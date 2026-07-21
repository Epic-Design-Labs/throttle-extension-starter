import { execFileSync, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const setupScript = join(repositoryRoot, 'scripts/setup.mjs');
const temporaryDirectories: string[] = [];

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'throttle-setup-'));
  temporaryDirectories.push(root);
  for (const path of [
    '.env.example',
    '.gitignore',
    'README.md',
    'package.json',
    'apps/cloudflare/.dev.vars.example',
    'apps/cloudflare/package.json',
    'apps/cloudflare/src/composition/index.ts',
    'apps/cloudflare/wrangler.jsonc',
    'apps/extension-ui/index.html',
    'examples/demo-connector/package.json',
    'examples/demo-connector/src/demo-provider.test.ts',
    'examples/demo-connector/src/demo-provider.ts',
    'examples/demo-connector/src/index.ts',
    'tests/e2e/demo-extension.test.ts',
  ]) {
    cpSync(join(repositoryRoot, path), join(root, path), {
      recursive: true,
    });
  }
  writeFileSync(join(root, 'notes.txt'), 'throttle-extension-starter\n');
  return root;
}

function run(root: string, ...arguments_: string[]) {
  return spawnSync(process.execPath, [setupScript, ...arguments_], {
    cwd: root,
    encoding: 'utf8',
  });
}

function contents(root: string, path: string): string {
  return readFileSync(join(root, path), 'utf8');
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    execFileSync(process.execPath, [
      '-e',
      `require('node:fs').rmSync(${JSON.stringify(directory)},{recursive:true,force:true})`,
    ]);
  }
});

describe('starter setup', () => {
  it('reports an exact deterministic dry run without mutating the repository', () => {
    const root = fixture();
    const beforePackage = contents(root, 'package.json');
    const result = run(
      root,
      '--',
      '--name',
      'Example Connector',
      '--slug',
      'example-connector',
      '--dry-run',
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Dry run: no files were changed.');
    expect(result.stdout).toContain('CREATE .throttle-starter.json');
    expect(result.stdout).toContain('CREATE apps/cloudflare/.dev.vars');
    expect(result.stdout).toContain('MODIFY package.json');
    expect(result.stdout).toContain(
      'pnpm --filter @starter/cloudflare db:migrate:local',
    );
    expect(result.stdout).toContain('pnpm dev');
    expect(result.stdout).toContain('pnpm test');
    expect(result.stdout).toContain(
      'pnpm dlx cloudflared tunnel --url http://localhost:5173',
    );
    expect(result.stdout).toContain('https://app.usethrottle.dev');
    expect(result.stdout).toContain(
      'pnpm --filter @starter/cloudflare exec wrangler deploy',
    );
    expect(contents(root, 'package.json')).toBe(beforePackage);
    expect(existsSync(join(root, '.throttle-starter.json'))).toBe(false);
    expect(existsSync(join(root, 'apps/cloudflare/.dev.vars'))).toBe(false);
  });

  it('customizes only allowlisted tokens and creates an ignored secret-free local file', () => {
    const root = fixture();
    const environmentExample = contents(root, '.env.example');
    const result = run(
      root,
      '--name',
      'Example Connector',
      '--slug',
      'example-connector',
    );

    expect(result.status).toBe(0);
    expect(JSON.parse(contents(root, 'package.json')).name).toBe(
      'example-connector',
    );
    expect(contents(root, 'README.md')).toContain('# Example Connector');
    expect(contents(root, 'apps/extension-ui/index.html')).toContain(
      '<title>Example Connector</title>',
    );
    expect(contents(root, 'apps/cloudflare/wrangler.jsonc')).toContain(
      '"name": "example-connector-worker"',
    );
    expect(contents(root, '.env.example')).toBe(environmentExample);
    expect(contents(root, 'notes.txt')).toBe('throttle-extension-starter\n');
    expect(contents(root, 'apps/cloudflare/.dev.vars')).toBe(
      contents(root, 'apps/cloudflare/.dev.vars.example'),
    );
    const localValues = contents(root, 'apps/cloudflare/.dev.vars')
      .split(/\r?\n/u)
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => line.slice(line.indexOf('=') + 1));
    expect(localValues.every((value) => value === '' || value === '{}')).toBe(
      true,
    );
    expect(contents(root, '.gitignore')).toContain('.dev.vars');
    expect(JSON.parse(contents(root, '.throttle-starter.json'))).toEqual({
      name: 'Example Connector',
      removeDemo: false,
      setupVersion: 1,
      slug: 'example-connector',
    });
  });

  it.each([
    ['uppercase slug', ['--name', 'Valid Name', '--slug', 'Invalid-Slug']],
    ['traversal slug', ['--name', 'Valid Name', '--slug', '../escape']],
    ['unsafe name', ['--name', 'Unsafe\nName', '--slug', 'safe-name']],
    ['unknown flag', ['--name', 'Valid Name', '--slug', 'safe-name', '--wat']],
    [
      'conflicting demo flags',
      [
        '--name',
        'Valid Name',
        '--slug',
        'safe-name',
        '--remove-demo',
        '--keep-demo',
      ],
    ],
  ])('rejects %s without changing files', (_label, arguments_) => {
    const root = fixture();
    const before = contents(root, 'package.json');
    const result = run(root, ...arguments_);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Setup failed:');
    expect(contents(root, 'package.json')).toBe(before);
    expect(existsSync(join(root, '.throttle-starter.json'))).toBe(false);
  });

  it('refuses a second run unless --force is explicit', () => {
    const root = fixture();
    expect(
      run(root, '--name', 'First Connector', '--slug', 'first-connector')
        .status,
    ).toBe(0);

    const refused = run(
      root,
      '--name',
      'Second Connector',
      '--slug',
      'second-connector',
    );
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain('already been customized');

    const forced = run(
      root,
      '--name',
      'Second Connector',
      '--slug',
      'second-connector',
      '--force',
    );
    expect(forced.stderr).toBe('');
    expect(forced.status).toBe(0);
    expect(JSON.parse(contents(root, 'package.json')).name).toBe(
      'second-connector',
    );
    expect(contents(root, 'apps/cloudflare/wrangler.jsonc')).toContain(
      'second-connector-worker',
    );

    const unchanged = run(
      root,
      '--name',
      'Second Connector',
      '--slug',
      'second-connector',
      '--force',
      '--dry-run',
    );
    expect(unchanged.status).toBe(0);
    expect(unchanged.stdout).not.toContain('MODIFY .throttle-starter.json');
  });

  it('refuses to follow an allowlisted symlink outside the repository', () => {
    const root = fixture();
    const outside = join(
      mkdtempSync(join(tmpdir(), 'throttle-outside-')),
      'file',
    );
    temporaryDirectories.push(dirname(outside));
    writeFileSync(outside, 'do not touch');
    execFileSync(process.execPath, [
      '-e',
      `require('node:fs').rmSync(${JSON.stringify(join(root, 'package.json'))})`,
    ]);
    symlinkSync(outside, join(root, 'package.json'));

    const result = run(
      root,
      '--name',
      'Example Connector',
      '--slug',
      'example-connector',
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('escapes the repository');
    expect(readFileSync(outside, 'utf8')).toBe('do not touch');
  });

  it('removes demo behavior while leaving a type-safe provider skeleton', () => {
    const root = fixture();
    const result = run(
      root,
      '--name',
      'Example Connector',
      '--slug',
      'example-connector',
      '--remove-demo',
    );

    expect(result.status).toBe(0);
    expect(existsSync(join(root, 'tests/e2e/demo-extension.test.ts'))).toBe(
      false,
    );
    expect(
      contents(root, 'examples/demo-connector/src/demo-provider.ts'),
    ).toContain('TODO: validate provider credentials');
    expect(
      contents(root, 'examples/demo-connector/src/demo-provider.test.ts'),
    ).toContain('provider adapter skeleton');

    const coreStub = join(root, 'node_modules/@starter/core');
    mkdirSync(coreStub, { recursive: true });
    writeFileSync(
      join(coreStub, 'package.json'),
      JSON.stringify({ name: '@starter/core', types: 'index.d.ts' }),
      { flush: true },
    );
    writeFileSync(
      join(coreStub, 'index.d.ts'),
      `export interface ProviderConnector {
        validateCredentials(credentials: Uint8Array): Promise<{ providerAccountReference: string }>;
        handleEvent(input: unknown): Promise<void>;
      }
      export class TerminalProviderError extends Error {}
      `,
    );
    const compile = spawnSync(
      join(repositoryRoot, 'node_modules/.bin/tsc'),
      [
        '--noEmit',
        '--strict',
        '--target',
        'ES2022',
        '--module',
        'NodeNext',
        '--moduleResolution',
        'NodeNext',
        join(root, 'examples/demo-connector/src/demo-provider.ts'),
        join(root, 'examples/demo-connector/src/index.ts'),
      ],
      { cwd: root, encoding: 'utf8' },
    );
    expect(compile.stderr + compile.stdout).toBe('');
    expect(compile.status).toBe(0);
  });
});
