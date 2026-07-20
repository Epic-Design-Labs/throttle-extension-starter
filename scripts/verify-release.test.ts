import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const verifyScript = join(repositoryRoot, 'scripts/verify-release.mjs');
const temporaryDirectories: string[] = [];

function writeFile(root: string, relativePath: string, contents: string) {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, 'utf8');
}

function git(root: string, ...arguments_: string[]) {
  execFileSync('git', arguments_, { cwd: root, encoding: 'utf8' });
}

/**
 * Builds a minimal, self-consistent fixture repository that should pass
 * `verify-release` cleanly (zero errors, zero warnings): every required
 * artifact is present, no placeholder Cloudflare identifiers, no
 * placeholder repository URL, no unresolved documentation markers.
 */
function fixture(mutate?: (root: string) => void): string {
  const root = mkdtempSync(join(tmpdir(), 'throttle-verify-release-'));
  temporaryDirectories.push(root);

  writeFile(
    root,
    'package.json',
    JSON.stringify(
      {
        name: 'fixture-repo',
        scripts: {
          dev: 'echo dev',
          test: 'echo test',
          check: 'echo check',
          build: 'echo build',
          lint: 'echo lint',
          typecheck: 'echo typecheck',
          format: 'echo format',
          setup: 'node scripts/setup.mjs',
          'verify:release': 'node scripts/verify-release.mjs',
        },
      },
      null,
      2,
    ),
  );
  writeFile(root, 'pnpm-lock.yaml', "lockfileVersion: '9.0'\n");
  writeFile(
    root,
    'packages/adapters-d1/migrations/0001_initial.sql',
    'CREATE TABLE installations (id TEXT PRIMARY KEY);\n',
  );
  writeFile(
    root,
    '.env.example',
    'THROTTLE_BASE_URL=\nLOCAL_ENCRYPTION_KEY=\n',
  );
  writeFile(
    root,
    'apps/cloudflare/.dev.vars.example',
    'ENCRYPTION_KEY=\nENCRYPTION_KEYRING={}\n',
  );
  writeFile(
    root,
    'apps/cloudflare/wrangler.jsonc',
    JSON.stringify(
      {
        name: 'fixture-worker',
        d1_databases: [
          {
            binding: 'DB',
            database_name: 'fixture-db',
            database_id: '11111111-1111-1111-1111-111111111111',
          },
        ],
      },
      null,
      2,
    ),
  );
  writeFile(
    root,
    'apps/cloudflare/package.json',
    JSON.stringify(
      {
        name: '@fixture/cloudflare',
        scripts: { 'db:migrate:local': 'echo migrate' },
      },
      null,
      2,
    ),
  );
  writeFile(
    root,
    'README.md',
    `# Fixture repo

## Quickstart

\`\`\`bash
git clone https://example.com/fixture-repo.git
pnpm install
pnpm dev
pnpm test
pnpm check
pnpm build
pnpm lint
pnpm typecheck
pnpm format
pnpm setup -- --name Example --slug example
pnpm verify:release
\`\`\`

Run the Cloudflare local D1 migration with
\`pnpm --filter @starter/cloudflare db:migrate:local\`.

See [docs/release-checklist.md](docs/release-checklist.md) before your
first production deploy.
`,
  );
  writeFile(
    root,
    'SECURITY.md',
    '# Security Policy\n\nEmail support@example.com to report a vulnerability.\n',
  );
  writeFile(
    root,
    'LICENSE',
    'MIT License\n\nCopyright (c) 2026 Fixture Owner\n',
  );
  writeFile(
    root,
    'tests/workspace-boundaries.test.ts',
    "import { describe, it, expect } from 'vitest';\ndescribe('boundary', () => { it('passes', () => expect(true).toBe(true)); });\n",
  );
  writeFile(
    root,
    'vitest.root.config.ts',
    "export default { test: { include: ['tests/**/*.test.ts', 'scripts/**/*.test.ts'] } };\n",
  );
  writeFile(
    root,
    'docs/release-checklist.md',
    '# Release checklist\n\nEverything here is resolved.\n',
  );
  writeFile(root, 'docs/architecture.md', '# Architecture\n\nNo open items.\n');

  mutate?.(root);

  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'fixture@example.com');
  git(root, 'config', 'user.name', 'Fixture');
  git(root, 'add', '-A');

  return root;
}

function run(root: string) {
  return spawnSync(process.execPath, [verifyScript, '--root', root], {
    encoding: 'utf8',
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('verify-release fixture happy path', () => {
  it('passes with zero errors and zero warnings on a fully consistent fixture', () => {
    const root = fixture();
    const result = run(root);

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      'Release verification passed with 0 warning(s).',
    );
    expect(result.stdout).not.toContain('Errors (');
  });
});

describe('verify-release against the real repository root', () => {
  it('passes and warns only about publisher-supplied Cloudflare IDs and repository URL', () => {
    const result = run(repositoryRoot);

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('Errors (');
    expect(result.stdout).toMatch(/placeholder identifiers/u);
    expect(result.stdout).toMatch(/all-zero database_id/u);
    expect(result.stdout).toMatch(/<this-repository-url>/u);
  });
});

describe('verify-release missing-artifact detection', () => {
  it('reports a missing LICENSE', () => {
    const root = fixture((r) => rmSync(join(r, 'LICENSE')));
    const result = run(root);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('LICENSE is missing');
  });

  it('reports a missing lockfile', () => {
    const root = fixture((r) => rmSync(join(r, 'pnpm-lock.yaml')));
    const result = run(root);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('pnpm-lock.yaml is missing');
  });

  it('reports missing D1 migrations', () => {
    const root = fixture((r) =>
      rmSync(join(r, 'packages/adapters-d1/migrations'), {
        recursive: true,
        force: true,
      }),
    );
    const result = run(root);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain(
      'packages/adapters-d1/migrations/ directory is missing',
    );
  });

  it('reports a missing .env.example', () => {
    const root = fixture((r) => rmSync(join(r, '.env.example')));
    const result = run(root);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('.env.example is missing');
  });

  it('reports a missing .dev.vars.example', () => {
    const root = fixture((r) =>
      rmSync(join(r, 'apps/cloudflare/.dev.vars.example')),
    );
    const result = run(root);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain(
      'apps/cloudflare/.dev.vars.example is missing',
    );
  });

  it('reports a missing wrangler.jsonc', () => {
    const root = fixture((r) =>
      rmSync(join(r, 'apps/cloudflare/wrangler.jsonc')),
    );
    const result = run(root);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain(
      'apps/cloudflare/wrangler.jsonc is missing',
    );
  });

  it('reports a missing README', () => {
    const root = fixture((r) => rmSync(join(r, 'README.md')));
    const result = run(root);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('README.md is missing');
  });

  it('reports a missing SECURITY.md', () => {
    const root = fixture((r) => rmSync(join(r, 'SECURITY.md')));
    const result = run(root);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('SECURITY.md is missing');
  });

  it('reports a missing LICENSE and a missing package boundary test together', () => {
    const root = fixture((r) => {
      rmSync(join(r, 'LICENSE'));
      rmSync(join(r, 'tests/workspace-boundaries.test.ts'));
    });
    const result = run(root);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('LICENSE is missing');
    expect(result.stdout).toContain(
      'tests/workspace-boundaries.test.ts is missing',
    );
  });
});

describe('verify-release secret hygiene detection', () => {
  it('reports a tracked .dev.vars file', () => {
    const root = fixture((r) =>
      writeFile(
        r,
        'apps/cloudflare/.dev.vars',
        'ENCRYPTION_KEY=not-a-real-key\n',
      ),
    );
    const result = run(root);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain(
      'Secret-bearing file(s) are tracked in git',
    );
    expect(result.stdout).toContain('apps/cloudflare/.dev.vars');
  });

  it('reports a tracked bare .env file', () => {
    const root = fixture((r) => writeFile(r, '.env', 'ENCRYPTION_KEY=x\n'));
    const result = run(root);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain(
      'Secret-bearing file(s) are tracked in git',
    );
    expect(result.stdout).toContain('.env');
  });

  it('reports a tracked .env.local file with a real-looking value', () => {
    const root = fixture((r) =>
      writeFile(
        r,
        '.env.local',
        'API_SECRET=sk_super_real_secret_value_do_not_commit\n',
      ),
    );
    const result = run(root);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain(
      'Secret-bearing file(s) are tracked in git',
    );
    expect(result.stdout).toContain('.env.local');
  });

  it('reports a tracked non-canonical .env.production and .dev.vars.staging file', () => {
    const root = fixture((r) => {
      writeFile(
        r,
        '.env.production',
        'API_SECRET=sk_super_real_secret_value_do_not_commit\n',
      );
      writeFile(
        r,
        'apps/cloudflare/.dev.vars.staging',
        'ENCRYPTION_KEY=not-a-real-key\n',
      );
    });
    const result = run(root);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain(
      'Secret-bearing file(s) are tracked in git',
    );
    expect(result.stdout).toContain('.env.production');
    expect(result.stdout).toContain('apps/cloudflare/.dev.vars.staging');
  });

  it('reports a non-blank value in a tracked .example file', () => {
    const root = fixture((r) =>
      writeFile(
        r,
        'apps/cloudflare/.dev.vars.example',
        'ENCRYPTION_KEY=abcdefabcdefabcdefabcdefabcdef12\nENCRYPTION_KEYRING={}\n',
      ),
    );
    const result = run(root);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain(
      'non-placeholder value for "ENCRYPTION_KEY"',
    );
  });

  it('does not flag the real .env.example / .dev.vars.example placeholder blanks', () => {
    const root = fixture();
    const result = run(root);
    expect(result.stdout).not.toContain('non-placeholder value');
  });

  it('reports an obvious credential-like value committed to a tracked file', () => {
    // Built from parts rather than a literal so this test file itself never
    // contains a contiguous string matching the AWS-key pattern — otherwise
    // scanning this repo's own tracked files would flag this test file.
    const fakeAwsAccessKeyId = ['AKIA', 'ABCDEFGHIJKLMNOP'].join('');
    const root = fixture((r) =>
      writeFile(r, 'NOTES.md', `Do not use ${fakeAwsAccessKeyId} in prod.\n`),
    );
    const result = run(root);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('appears to contain an AWS access key ID');
  });

  it('does not flag ordinary test fixtures that merely mention "secret" or "token"', () => {
    const root = fixture((r) =>
      writeFile(
        r,
        'packages/core/src/example.test.ts',
        "const secret = 'test-webhook-secret';\nconst token = 'claim-token';\n",
      ),
    );
    const result = run(root);
    expect(result.stdout).not.toContain('appears to contain');
  });

  it('reports tracked generated dist/ output', () => {
    const root = fixture((r) =>
      writeFile(r, 'apps/cloudflare/dist/index.js', 'export {};\n'),
    );
    const result = run(root);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('Generated dist/ output is tracked in git');
  });
});

describe('verify-release documentation hygiene detection', () => {
  it('reports an unresolved TODO marker in a scanned doc', () => {
    const root = fixture((r) =>
      writeFile(
        r,
        'docs/architecture.md',
        '# Architecture\n\nTODO: finish this section.\n',
      ),
    );
    const result = run(root);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain(
      'docs/architecture.md:3 contains an unresolved "TODO" marker',
    );
  });

  it('does not flag a marker word mentioned only inside inline code spans', () => {
    const root = fixture((r) =>
      writeFile(
        r,
        'docs/architecture.md',
        '# Architecture\n\nThe skeleton throws with `TODO` markers in comments.\n',
      ),
    );
    const result = run(root);
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('contains an unresolved');
  });

  it('does not flag a marker word inside a fenced code block', () => {
    const root = fixture((r) =>
      writeFile(
        r,
        'docs/architecture.md',
        '# Architecture\n\n```ts\n// TODO: implement\n```\n',
      ),
    );
    const result = run(root);
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('contains an unresolved');
  });
});

describe('verify-release README command detection', () => {
  it('reports a required root script missing from README', () => {
    const root = fixture((r) =>
      writeFile(
        r,
        'README.md',
        '# Fixture repo\n\nRun `pnpm install` and `pnpm dev` only.\n',
      ),
    );
    const result = run(root);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('README.md does not document "pnpm test"');
  });

  it('reports a missing docs/release-checklist.md link', () => {
    const root = fixture((r) =>
      writeFile(
        r,
        'README.md',
        `# Fixture repo

\`\`\`bash
pnpm install
pnpm dev
pnpm test
pnpm check
pnpm build
pnpm lint
pnpm typecheck
pnpm format
pnpm setup -- --name Example --slug example
pnpm verify:release
\`\`\`

Cloudflare: \`pnpm --filter @starter/cloudflare db:migrate:local\`.
`,
      ),
    );
    const result = run(root);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain(
      'README.md does not link docs/release-checklist.md',
    );
  });
});

describe('verify-release wrangler and repository URL warnings', () => {
  it('warns (without failing) about placeholder Cloudflare identifiers', () => {
    const root = fixture((r) =>
      writeFile(
        r,
        'apps/cloudflare/wrangler.jsonc',
        JSON.stringify(
          {
            name: 'replace-with-throttle-extension-worker-name',
            d1_databases: [
              {
                binding: 'DB',
                database_name: 'replace-with-d1-database-name',
                database_id: '00000000-0000-0000-0000-000000000000',
              },
            ],
          },
          null,
          2,
        ),
      ),
    );
    const result = run(root);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/placeholder identifiers/u);
    expect(result.stdout).toMatch(/all-zero database_id/u);
  });

  it('warns (without failing) about the placeholder repository URL', () => {
    const root = fixture((r) =>
      writeFile(
        r,
        'README.md',
        `# Fixture repo

\`\`\`bash
git clone <this-repository-url>
pnpm install
pnpm dev
pnpm test
pnpm check
pnpm build
pnpm lint
pnpm typecheck
pnpm format
pnpm setup -- --name Example --slug example
pnpm verify:release
\`\`\`

Cloudflare: \`pnpm --filter @starter/cloudflare db:migrate:local\`.

See [docs/release-checklist.md](docs/release-checklist.md).
`,
      ),
    );
    const result = run(root);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('<this-repository-url>');
  });
});
