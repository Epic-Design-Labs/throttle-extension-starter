#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

function fail(message) {
  throw new Error(message);
}

const REQUIRED_FILES = [
  'pnpm-lock.yaml',
  '.env.example',
  'apps/cloudflare/.dev.vars.example',
  'apps/cloudflare/wrangler.jsonc',
  'README.md',
  'SECURITY.md',
  'LICENSE',
];

const DOC_FILES_TO_SCAN_FOR_MARKERS = [
  'README.md',
  'docs/architecture.md',
  'docs/local-development.md',
  'docs/cloudflare-deployment.md',
  'docs/adding-a-provider.md',
  'docs/testing.md',
  'docs/operations.md',
  'docs/release-checklist.md',
];

// Keep this list in sync with the `required` array in
// tests/documentation.test.ts ("documents every required root script
// defined in package.json") — both enumerate the root scripts the README
// must document, and have drifted before.
const REQUIRED_ROOT_SCRIPTS = [
  'dev',
  'test',
  'check',
  'build',
  'lint',
  'typecheck',
  'format',
  'setup',
  'verify:release',
];

const UNRESOLVED_MARKER_PATTERN = /\b(TODO|FIXME|TBD|XXX)\b/u;

const BINARY_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'ico',
  'webp',
  'woff',
  'woff2',
  'ttf',
  'eot',
  'pdf',
  'zip',
  'gz',
]);

// High-confidence patterns that essentially never appear by accident in a
// template repository. Kept intentionally narrow to stay low-false-positive
// (this is a lightweight heuristic, not a general secret scanner).
const SECRET_PATTERNS = [
  { name: 'an AWS access key ID', pattern: /AKIA[0-9A-Z]{16}/u },
  {
    name: 'a PEM private key block',
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |)PRIVATE KEY-----/u,
  },
  { name: 'a Stripe live secret key', pattern: /sk_live_[0-9a-zA-Z]{10,}/u },
  { name: 'a GitHub token', pattern: /gh[pousr]_[A-Za-z0-9]{20,}/u },
  { name: 'a Slack token', pattern: /xox[baprs]-[A-Za-z0-9-]{10,}/u },
];

// Matches any env-like file, canonical or not: `.env`, `.env.local`,
// `.env.production`, `.env.example`, `.dev.vars`, `.dev.vars.staging`, etc.
const ENV_LIKE_PATTERN = /(^|\/)\.env(\..+)?$|(^|\/)\.dev\.vars(\..+)?$/u;

function isNonExampleEnvLikeFile(path) {
  return ENV_LIKE_PATTERN.test(path) && !basename(path).endsWith('.example');
}

function createReport() {
  const report = { passed: [], warnings: [], errors: [] };
  return {
    pass: (message) => report.passed.push(message),
    warn: (message) => report.warnings.push(message),
    error: (message) => report.errors.push(message),
    report,
  };
}

function readOptional(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

function gitLsFiles(root) {
  try {
    return execFileSync('git', ['-C', root, 'ls-files'], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    })
      .split(/\r?\n/u)
      .filter(Boolean);
  } catch {
    return undefined;
  }
}

function checkRequiredFiles(root, { pass, error }) {
  for (const relativePath of REQUIRED_FILES) {
    if (existsSync(join(root, relativePath))) {
      pass(`${relativePath} is present`);
    } else {
      error(`${relativePath} is missing`);
    }
  }

  const migrationsDirectory = join(root, 'packages/adapters-d1/migrations');
  if (
    !existsSync(migrationsDirectory) ||
    !statSync(migrationsDirectory).isDirectory()
  ) {
    error('packages/adapters-d1/migrations/ directory is missing');
    return;
  }
  const migrationFiles = readdirSync(migrationsDirectory).filter((name) =>
    name.endsWith('.sql'),
  );
  if (migrationFiles.length === 0) {
    error('packages/adapters-d1/migrations/ contains no .sql migration files');
  } else {
    pass(
      `packages/adapters-d1/migrations/ contains ${migrationFiles.length} migration file(s)`,
    );
  }
}

function checkPackageBoundaryTests(root, { pass, warn, error }) {
  const boundaryTestPath = 'tests/workspace-boundaries.test.ts';
  if (!existsSync(join(root, boundaryTestPath))) {
    error(`${boundaryTestPath} is missing`);
    return;
  }
  pass(`${boundaryTestPath} is present`);

  const vitestConfig = readOptional(join(root, 'vitest.root.config.ts'));
  if (vitestConfig === undefined) {
    warn(
      'vitest.root.config.ts is missing; cannot confirm the package boundary test is collected',
    );
  } else if (vitestConfig.includes('tests/**/*.test.ts')) {
    pass('vitest.root.config.ts collects tests/**/*.test.ts');
  } else {
    warn(
      'vitest.root.config.ts does not obviously include tests/**/*.test.ts — confirm the package boundary test still runs',
    );
  }
}

function checkGeneratedOutputIsClean(trackedFiles, { pass, error }) {
  if (trackedFiles === undefined) return;
  const trackedDist = trackedFiles.filter((path) => /(^|\/)dist\//u.test(path));
  if (trackedDist.length > 0) {
    error(
      `Generated dist/ output is tracked in git: ${trackedDist.join(', ')}`,
    );
  } else {
    pass('No dist/ output is tracked in git');
  }
}

function checkNoTrackedSecretFiles(trackedFiles, { pass, error }) {
  if (trackedFiles === undefined) return;
  // Any non-`.example` env-like file is a real (or realistic-looking)
  // secrets file — canonical (`.env`, `.dev.vars`) or not (`.env.local`,
  // `.env.production`, `.dev.vars.staging`, ...). None of these should ever
  // be tracked in git; they must stay gitignored.
  const badFiles = trackedFiles.filter((path) => isNonExampleEnvLikeFile(path));
  if (badFiles.length > 0) {
    error(
      `Secret-bearing file(s) are tracked in git and must stay gitignored: ${badFiles.join(', ')}`,
    );
  } else {
    pass('No tracked non-example .env/.dev.vars files found in git');
  }
}

function checkEnvExampleFilesStayBlank(root, trackedFiles, { pass, error }) {
  if (trackedFiles === undefined) return;
  const envLikeFiles = trackedFiles.filter((path) =>
    ENV_LIKE_PATTERN.test(path),
  );
  let sawExample = false;
  for (const relativePath of envLikeFiles) {
    if (!basename(relativePath).endsWith('.example')) continue;
    sawExample = true;
    const contents = readOptional(join(root, relativePath));
    if (contents === undefined) continue;
    for (const line of contents.split(/\r?\n/u)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const separator = trimmed.indexOf('=');
      if (separator < 1) continue;
      const key = trimmed.slice(0, separator);
      const value = trimmed.slice(separator + 1).trim();
      if (value !== '' && value !== '{}') {
        error(
          `${relativePath} defines a non-placeholder value for "${key}" — example files must ship blank placeholders`,
        );
      }
    }
  }
  if (sawExample)
    pass('Tracked .example env/vars files contain only blank placeholders');
}

function checkForObviousCredentials(root, trackedFiles, { pass, error }) {
  if (trackedFiles === undefined) return;
  let flagged = false;
  for (const relativePath of trackedFiles) {
    const extension = relativePath.split('.').pop()?.toLowerCase();
    if (extension && BINARY_EXTENSIONS.has(extension)) continue;
    if (relativePath === 'pnpm-lock.yaml') continue;
    const contents = readOptional(join(root, relativePath));
    if (contents === undefined) continue;
    for (const { name, pattern } of SECRET_PATTERNS) {
      if (pattern.test(contents)) {
        error(
          `${relativePath} appears to contain ${name} — remove real credentials from tracked files`,
        );
        flagged = true;
      }
    }
  }
  if (!flagged) {
    pass('No obvious credential-like values found in tracked files');
  }
}

function checkWranglerPlaceholders(root, { warn, pass }) {
  const contents = readOptional(join(root, 'apps/cloudflare/wrangler.jsonc'));
  if (contents === undefined) return;

  const placeholders = [
    ...new Set(
      [...contents.matchAll(/replace-with-[a-z0-9-]+/giu)].map(
        (match) => match[0],
      ),
    ),
  ];
  if (placeholders.length > 0) {
    warn(
      `apps/cloudflare/wrangler.jsonc still has placeholder identifiers (${placeholders.join(', ')}) — replace with your real Cloudflare resource names/IDs before deploying`,
    );
  }
  if (contents.includes('00000000-0000-0000-0000-000000000000')) {
    warn(
      'apps/cloudflare/wrangler.jsonc still has the placeholder all-zero database_id — replace it with the real D1 database_id before deploying',
    );
  }
  if (
    placeholders.length === 0 &&
    !contents.includes('00000000-0000-0000-0000-000000000000')
  ) {
    pass(
      'apps/cloudflare/wrangler.jsonc has no placeholder Cloudflare identifiers',
    );
  }
}

function checkRepositoryUrlPlaceholder(readme, { warn, pass }) {
  if (readme === undefined) return;
  if (readme.includes('<this-repository-url>')) {
    warn(
      'README.md still references the placeholder <this-repository-url> — replace it with your published repository URL before publishing',
    );
  } else {
    pass('README.md does not reference the placeholder repository URL');
  }
}

function stripCodeSpans(line) {
  return line.replace(/`[^`]*`/gu, '');
}

function findUnresolvedMarkers(contents) {
  const hits = [];
  let inFence = false;
  const lines = contents.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (/^\s*```/u.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = UNRESOLVED_MARKER_PATTERN.exec(stripCodeSpans(line));
    if (match) hits.push({ line: index + 1, marker: match[1] });
  }
  return hits;
}

function checkUnresolvedDocumentationMarkers(root, { pass, error }) {
  let checkedAny = false;
  for (const relativePath of DOC_FILES_TO_SCAN_FOR_MARKERS) {
    const contents = readOptional(join(root, relativePath));
    if (contents === undefined) continue;
    checkedAny = true;
    const hits = findUnresolvedMarkers(contents);
    for (const hit of hits) {
      error(
        `${relativePath}:${hit.line} contains an unresolved "${hit.marker}" marker`,
      );
    }
  }
  if (checkedAny)
    pass(
      'No unresolved TODO/FIXME/TBD/XXX markers found in scanned documentation',
    );
}

function checkReadmeCommands(root, readme, { pass, error }) {
  const packageJsonPath = join(root, 'package.json');
  if (!existsSync(packageJsonPath)) return;
  let packageJson;
  try {
    packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  } catch {
    error('package.json is not valid JSON');
    return;
  }
  const scripts = packageJson.scripts ?? {};

  if (readme === undefined) return;
  if (!readme.includes('pnpm install')) {
    error('README.md does not document "pnpm install"');
  } else {
    pass('README.md documents pnpm install');
  }

  for (const name of REQUIRED_ROOT_SCRIPTS) {
    if (!(name in scripts)) {
      error(`package.json is missing the "${name}" script`);
      continue;
    }
    if (!readme.includes(`pnpm ${name}`)) {
      error(`README.md does not document "pnpm ${name}"`);
    } else {
      pass(`README.md documents pnpm ${name}`);
    }
  }

  const cloudflarePackageJsonPath = join(root, 'apps/cloudflare/package.json');
  if (existsSync(cloudflarePackageJsonPath)) {
    let cloudflarePackageJson;
    try {
      cloudflarePackageJson = JSON.parse(
        readFileSync(cloudflarePackageJsonPath, 'utf8'),
      );
    } catch {
      error('apps/cloudflare/package.json is not valid JSON');
      return;
    }
    const cloudflareScripts = cloudflarePackageJson.scripts ?? {};
    if (!('db:migrate:local' in cloudflareScripts)) {
      error('apps/cloudflare/package.json is missing "db:migrate:local"');
    } else if (!readme.includes('db:migrate:local')) {
      error(
        'README.md does not document the Cloudflare local D1 migration command',
      );
    } else {
      pass('README.md documents the Cloudflare local D1 migration command');
    }
  }

  if (!readme.includes('docs/release-checklist.md')) {
    error('README.md does not link docs/release-checklist.md');
  } else {
    pass('README.md links docs/release-checklist.md');
  }
}

export function runVerification(rootDirectory = process.cwd()) {
  const root = resolve(rootDirectory);
  const { pass, warn, error, report } = createReport();

  checkRequiredFiles(root, { pass, warn, error });
  checkPackageBoundaryTests(root, { pass, warn, error });

  const trackedFiles = gitLsFiles(root);
  if (trackedFiles === undefined) {
    warn(
      'Could not determine git-tracked files (not a git repository or git unavailable) — skipped tracked-file checks',
    );
  }
  checkNoTrackedSecretFiles(trackedFiles, { pass, warn, error });
  checkGeneratedOutputIsClean(trackedFiles, { pass, warn, error });
  checkEnvExampleFilesStayBlank(root, trackedFiles, { pass, warn, error });
  checkForObviousCredentials(root, trackedFiles, { pass, warn, error });

  checkWranglerPlaceholders(root, { pass, warn, error });

  const readme = readOptional(join(root, 'README.md'));
  checkRepositoryUrlPlaceholder(readme, { pass, warn, error });
  checkUnresolvedDocumentationMarkers(root, { pass, warn, error });
  checkReadmeCommands(root, readme, { pass, warn, error });

  return report;
}

function printReport(report) {
  process.stdout.write('Release verification\n\n');
  if (report.passed.length > 0) {
    process.stdout.write(`Passed (${report.passed.length}):\n`);
    for (const message of report.passed) {
      process.stdout.write(`  ✅ ${message}\n`);
    }
    process.stdout.write('\n');
  }
  if (report.warnings.length > 0) {
    process.stdout.write(`Warnings (${report.warnings.length}):\n`);
    for (const message of report.warnings) {
      process.stdout.write(`  ⚠️  ${message}\n`);
    }
    process.stdout.write('\n');
  }
  if (report.errors.length > 0) {
    process.stdout.write(`Errors (${report.errors.length}):\n`);
    for (const message of report.errors) {
      process.stdout.write(`  ❌ ${message}\n`);
    }
    process.stdout.write('\n');
  }
  process.stdout.write(
    report.errors.length > 0
      ? `Release verification FAILED: ${report.errors.length} error(s), ${report.warnings.length} warning(s).\n`
      : `Release verification passed with ${report.warnings.length} warning(s).\n`,
  );
}

function parseCliArguments(arguments_) {
  const values = { root: process.cwd() };
  for (let index = 0; index < arguments_.length; index++) {
    const argument = arguments_[index];
    if (argument === '--root') {
      const value = arguments_[++index];
      if (!value) fail('Missing value for --root');
      values.root = value;
      continue;
    }
    fail(`Unknown option: ${argument}`);
  }
  return values;
}

if (
  resolve(process.argv[1] ?? '') === resolve(fileURLToPath(import.meta.url))
) {
  try {
    const { root } = parseCliArguments(process.argv.slice(2));
    const report = runVerification(root);
    printReport(report);
    process.exitCode = report.errors.length > 0 ? 1 : 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    process.stderr.write(`Release verification failed to run: ${message}\n`);
    process.exitCode = 1;
  }
}
