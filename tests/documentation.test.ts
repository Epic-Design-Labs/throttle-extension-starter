import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// NOTE: This suite is offline-only. It never performs network requests and
// must not be extended to fetch external URLs — external link liveness
// checking is an explicit opt-in command owned by a separate task, not part
// of this (or any) unit test run.

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function read(path: string): string {
  return readFileSync(resolve(root, path), 'utf8');
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(read(path)) as Record<string, unknown>;
}

const readme = read('README.md');
const agents = read('AGENTS.md');
const contributing = read('CONTRIBUTING.md');
const security = read('SECURITY.md');
const license = read('LICENSE');
const rootPackageJson = readJson('package.json');
const cloudflarePackageJson = readJson('apps/cloudflare/package.json');
const extensionUiPackageJson = readJson('apps/extension-ui/package.json');

function scripts(packageJson: Record<string, unknown>): Record<string, string> {
  return (packageJson.scripts ?? {}) as Record<string, string>;
}

function extractMarkdownLinkTargets(markdown: string): string[] {
  const targets: string[] = [];
  const pattern = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/gu;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(markdown)) !== null) {
    targets.push(match[1]!);
  }
  return targets;
}

function isExternal(target: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/iu.test(target) && !target.startsWith('#');
}

describe('README local link targets', () => {
  const targets = extractMarkdownLinkTargets(readme);
  const localTargets = [
    ...new Set(
      targets.filter((target) => !isExternal(target) && target !== ''),
    ),
  ];

  it('contains at least one local link', () => {
    expect(localTargets.length).toBeGreaterThan(0);
  });

  it.each(localTargets)('resolves local link target %s', (target) => {
    const [pathPart] = target.split('#');
    if (!pathPart) return;
    expect(existsSync(resolve(root, pathPart))).toBe(true);
  });
});

describe('README links every required supporting document', () => {
  const requiredDocumentLinks = [
    'AGENTS.md',
    'CONTRIBUTING.md',
    'SECURITY.md',
    'LICENSE',
    'docs/architecture.md',
    'docs/local-development.md',
    'docs/cloudflare-deployment.md',
    'docs/adding-a-provider.md',
    'docs/testing.md',
    'docs/operations.md',
  ];

  it.each(requiredDocumentLinks)('links %s from the README', (path) => {
    expect(readme).toContain(`(${path})`);
  });
});

describe('README canonical Throttle links', () => {
  const canonicalLinks = [
    'https://usethrottle.dev',
    'https://app.usethrottle.dev',
    'https://docs.usethrottle.dev/developers/extensions/overview',
    'https://docs.usethrottle.dev/developers/extensions/get-started',
    'https://docs.usethrottle.dev/developers/extensions/starter-repository',
    'https://docs.usethrottle.dev/developers/extensions/build',
    'https://docs.usethrottle.dev/developers/extensions/identity',
    'https://docs.usethrottle.dev/developers/extensions/events',
    'https://docs.usethrottle.dev/developers/extensions/scopes',
    'https://docs.usethrottle.dev/developers/extensions/install',
    'https://docs.usethrottle.dev/developers/extensions/testing',
    'https://docs.usethrottle.dev/developers/extensions/versioning',
    'https://docs.usethrottle.dev/developers/extensions/security',
    'https://docs.usethrottle.dev/developers/extensions/publishing',
    'https://docs.usethrottle.dev/developers/extensions/operations',
    'https://docs.usethrottle.dev/developers/api-reference',
    'https://docs.usethrottle.dev/developers/packages',
  ];

  it.each(canonicalLinks)('links %s', (url) => {
    expect(readme).toContain(url);
  });

  it('does not invent a platform status page URL', () => {
    expect(readme).not.toMatch(/https:\/\/status\.usethrottle\.dev/u);
  });
});

describe('README verified commands', () => {
  it('documents installing dependencies and running setup', () => {
    expect(readme).toContain('pnpm install');
    expect(readme).toContain('pnpm setup -- --name');
  });

  it('documents every required root script defined in package.json', () => {
    const rootScripts = scripts(rootPackageJson);
    const required = [
      'dev',
      'test',
      'check',
      'build',
      'lint',
      'typecheck',
      'format',
      'setup',
    ];
    for (const name of required) {
      expect(rootScripts).toHaveProperty(name);
      expect(readme).toContain(`pnpm ${name}`);
    }
  });

  it('documents the Cloudflare local D1 migration command', () => {
    expect(scripts(cloudflarePackageJson)).toHaveProperty('db:migrate:local');
    expect(readme).toContain(
      'pnpm --filter @starter/cloudflare db:migrate:local',
    );
  });

  it('documents the Cloudflare dry-run build as a verification step', () => {
    expect(scripts(cloudflarePackageJson).build).toContain(
      'wrangler deploy --dry-run',
    );
    expect(readme).toContain('wrangler deploy');
  });

  it('documents the extension UI local dev server URL', () => {
    expect(scripts(extensionUiPackageJson)).toHaveProperty('dev');
    expect(readme).toContain('http://localhost:5173');
  });

  it('documents every workspace package by name', () => {
    const names = [
      '@starter/contracts',
      '@starter/core',
      '@starter/security',
      '@starter/throttle',
      '@starter/adapters-d1',
      '@starter/adapters-cloudflare-queue',
      '@starter/demo-connector',
      '@starter/cloudflare',
      '@starter/extension-ui',
    ];
    for (const name of names) expect(readme).toContain(name);
  });
});

describe('README content coverage', () => {
  it('documents Test-mode-first registration guidance', () => {
    expect(readme).toMatch(/test mode/iu);
  });

  it('documents the secret classification inventory', () => {
    expect(readme).toContain('LOCAL_ENCRYPTION_KEY');
    expect(readme).toContain('ENCRYPTION_KEY');
    expect(readme).toContain('ENCRYPTION_KEYRING');
    expect(readme).toMatch(/platform secret/iu);
    expect(readme).toMatch(/per installation/iu);
  });

  it('documents raw-body webhook signature verification', () => {
    expect(readme).toMatch(/raw(?:,| )request body|raw body/iu);
    expect(readme).toContain('HMAC-SHA256');
  });

  it('documents identity JWT verification', () => {
    expect(readme).toContain('RS256');
    expect(readme).toMatch(/JWKS/u);
  });

  it('documents idempotent webhook and job processing', () => {
    expect(readme).toMatch(/idempoten/iu);
  });

  it('documents uninstall cleanup', () => {
    expect(readme).toMatch(/uninstall/iu);
    expect(readme).toMatch(/cancel(?:s|led)? (?:queued|in-flight|pending)/iu);
  });

  it('documents replacing the demo provider', () => {
    expect(readme).toContain('demo-provider.ts');
    expect(readme).toMatch(/--remove-demo/u);
  });

  it('documents the Cloudflare deployment path', () => {
    expect(readme).toMatch(/wrangler\.jsonc/u);
    expect(readme).toMatch(/D1/u);
  });

  it('documents troubleshooting guidance', () => {
    expect(readme).toMatch(/## Troubleshooting/u);
  });

  it('documents a coding-agent section that points at AGENTS.md', () => {
    expect(readme).toMatch(/## .*[Cc]oding agent/u);
    expect(readme).toContain('(AGENTS.md)');
  });

  it('documents the Node/Render roadmap as future work', () => {
    expect(readme).toMatch(/Render/u);
    expect(readme).toMatch(/PostgreSQL/u);
  });
});

describe('AGENTS.md coding-agent rules', () => {
  it('names the source-of-truth documents', () => {
    expect(agents).toContain('README.md');
    expect(agents).toMatch(/source of truth|source-of-truth/iu);
  });

  it('states the dependency boundary invariant', () => {
    expect(agents).toContain('packages/contracts/src');
    expect(agents).toContain('packages/core/src');
    expect(agents).toMatch(/no runtime imports/iu);
  });

  it('states the raw-body, JWT, and secret handling rules', () => {
    expect(agents).toMatch(/raw body|raw request body/iu);
    expect(agents).toContain('RS256');
    expect(agents).toMatch(/encrypt/iu);
  });

  it('states the camelCase public contract rule', () => {
    expect(agents).toMatch(/camelCase/u);
    expect(agents).toContain('packages/contracts');
  });

  it('names the required verification commands', () => {
    expect(agents).toContain('pnpm check');
    expect(agents).toMatch(/test-driven|TDD/iu);
  });

  it('states migration ownership rules', () => {
    expect(agents).toMatch(/migrations/iu);
    expect(agents).toMatch(/never edit|do not edit|do not modify/iu);
  });

  it('states the generated-file policy', () => {
    expect(agents).toMatch(/dist\//u);
    expect(agents).toMatch(/generated/iu);
  });

  it('lists prohibited shortcuts', () => {
    expect(agents).toMatch(/prohibited|never|must not/iu);
  });
});

describe('SECURITY.md', () => {
  it('lists the support contact address', () => {
    expect(security).toContain('support@usethrottle.dev');
  });
});

describe('LICENSE', () => {
  it('is the MIT license held by Epic Design Labs', () => {
    expect(license).toMatch(/MIT License/u);
    expect(license).toContain('Epic Design Labs');
  });
});

describe('CONTRIBUTING.md', () => {
  it('is non-trivial and references the required checks', () => {
    expect(contributing.length).toBeGreaterThan(200);
    expect(contributing).toContain('pnpm check');
  });
});

describe('docs/*.md guides exist and are substantive', () => {
  const guides = [
    'docs/architecture.md',
    'docs/local-development.md',
    'docs/cloudflare-deployment.md',
    'docs/adding-a-provider.md',
    'docs/testing.md',
    'docs/operations.md',
  ];

  it.each(guides)('%s exists and has real content', (path) => {
    const contents = read(path);
    expect(contents.length).toBeGreaterThan(300);
    expect(contents).toMatch(/^# /mu);
  });
});
