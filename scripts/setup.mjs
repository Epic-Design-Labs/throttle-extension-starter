#!/usr/bin/env node

import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_TEMPLATE,
  DEMO_FILES,
  LOCAL_VARIABLES_EXAMPLE,
  LOCAL_VARIABLES_FILE,
  PROVIDER_INDEX_SKELETON,
  PROVIDER_SKELETON,
  PROVIDER_TEST_SKELETON,
  SETUP_MARKER,
  SETUP_VERSION,
  templateEdits,
} from './lib/template-files.mjs';

function fail(message) {
  throw new Error(message);
}

function parseArguments(arguments_) {
  const values = {
    dryRun: false,
    force: false,
    keepDemo: false,
    removeDemo: false,
  };
  const seen = new Set();
  for (let index = 0; index < arguments_.length; index++) {
    const argument = arguments_[index];
    if (argument === '--' && index === 0) continue;
    if (argument === '--name' || argument === '--slug') {
      if (seen.has(argument)) fail(`Duplicate option: ${argument}`);
      const value = arguments_[++index];
      if (!value || value.startsWith('--'))
        fail(`Missing value for ${argument}`);
      values[argument.slice(2)] = value;
      seen.add(argument);
      continue;
    }
    if (
      argument === '--dry-run' ||
      argument === '--force' ||
      argument === '--remove-demo' ||
      argument === '--keep-demo'
    ) {
      if (seen.has(argument)) fail(`Duplicate option: ${argument}`);
      values[
        argument
          .slice(2)
          .replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())
      ] = true;
      seen.add(argument);
      continue;
    }
    fail(`Unknown option: ${argument}`);
  }
  if (values.removeDemo && values.keepDemo) {
    fail('--remove-demo and --keep-demo cannot be used together');
  }
  if (!values.name) fail('--name is required');
  if (!values.slug) fail('--slug is required');
  return values;
}

function validateInput({ name, slug }) {
  if (
    name !== name.trim() ||
    name.length < 1 ||
    name.length > 80 ||
    [...name].some((character) => {
      const code = character.codePointAt(0);
      return code !== undefined && (code < 32 || code === 127);
    })
  ) {
    fail(
      'Name must be 1-80 printable characters without surrounding whitespace',
    );
  }
  if (slug.length > 63 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(slug)) {
    fail(
      'Slug must contain lowercase letters, numbers, and single hyphens only',
    );
  }
}

function validateNodeVersion() {
  const major = Number.parseInt(process.versions.node.split('.')[0], 10);
  if (!Number.isSafeInteger(major) || major < 20) {
    fail('Node.js 20 or newer is required');
  }
}

function inside(root, candidate) {
  const path = relative(root, candidate);
  return (
    path === '' ||
    (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path))
  );
}

function validatePath(root, path, mayNotExist = false) {
  const absolute = resolve(root, path);
  if (!inside(root, absolute)) fail(`${path} escapes the repository`);
  let checked = absolute;
  if (mayNotExist && !existsSync(checked)) checked = dirname(checked);
  const real = realpathSync(checked);
  if (!inside(root, real))
    fail(`${path} escapes the repository through a symlink`);
  if (existsSync(absolute) && lstatSync(absolute).isSymbolicLink()) {
    const target = realpathSync(absolute);
    if (!inside(root, target))
      fail(`${path} escapes the repository through a symlink`);
  }
  return absolute;
}

function readMarker(root) {
  const path = join(root, SETUP_MARKER);
  if (!existsSync(path)) return undefined;
  validatePath(root, SETUP_MARKER);
  let marker;
  try {
    marker = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    fail(`${SETUP_MARKER} is not valid JSON`);
  }
  if (
    marker?.setupVersion !== SETUP_VERSION ||
    typeof marker.name !== 'string' ||
    typeof marker.slug !== 'string' ||
    typeof marker.removeDemo !== 'boolean'
  ) {
    fail(`${SETUP_MARKER} has an unsupported format`);
  }
  validateInput(marker);
  return marker;
}

function localVariables(root) {
  const examplePath = validatePath(root, LOCAL_VARIABLES_EXAMPLE);
  const contents = readFileSync(examplePath, 'utf8');
  for (const line of contents.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    const value = trimmed.slice(separator + 1);
    if (separator < 1 || (value !== '' && value !== '{}')) {
      fail(
        `${LOCAL_VARIABLES_EXAMPLE} must contain only blank values or an empty keyring`,
      );
    }
  }
  return contents;
}

function writeSafely(path, contents) {
  const temporary = `${path}.setup-${randomBytes(8).toString('hex')}`;
  try {
    writeFileSync(temporary, contents, { encoding: 'utf8', flag: 'wx' });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function nextSteps() {
  return `Next steps:
  1. Start local development: pnpm dev
  2. Run the test suite: pnpm test
  3. Apply local D1 migrations: pnpm --filter @starter/cloudflare db:migrate:local
  4. Expose the UI for iframe testing: pnpm dlx cloudflared tunnel --url http://localhost:5173
  5. Register the extension in Throttle Test mode: https://app.usethrottle.dev
  6. Deploy after configuring Cloudflare resources and secrets: pnpm --filter @starter/cloudflare exec wrangler deploy
`;
}

export function runSetup(arguments_, rootDirectory = process.cwd()) {
  validateNodeVersion();
  const options = parseArguments(arguments_);
  validateInput(options);
  const root = realpathSync(rootDirectory);
  const marker = readMarker(root);
  if (marker && !options.force) {
    fail(
      'This repository has already been customized; pass --force to rerun setup',
    );
  }

  const removeDemo = options.removeDemo
    ? true
    : options.keepDemo
      ? false
      : (marker?.removeDemo ?? false);
  if (marker?.removeDemo && !removeDemo) {
    fail(
      'The removed demo cannot be restored by setup; start from a clean template',
    );
  }

  const current = marker ?? DEFAULT_TEMPLATE;
  const next = { name: options.name, slug: options.slug };
  const operations = [];
  for (const edit of templateEdits(current, next)) {
    const path = validatePath(root, edit.path);
    const before = readFileSync(path, 'utf8');
    const after = edit.apply(before);
    if (before !== after)
      operations.push({ action: 'MODIFY', path: edit.path, after });
  }

  const localPath = validatePath(root, LOCAL_VARIABLES_FILE, true);
  if (!existsSync(localPath)) {
    operations.push({
      action: 'CREATE',
      path: LOCAL_VARIABLES_FILE,
      after: localVariables(root),
    });
  }

  if (removeDemo && !marker?.removeDemo) {
    for (const [path, after] of [
      [DEMO_FILES.implementation, PROVIDER_SKELETON],
      [DEMO_FILES.test, PROVIDER_TEST_SKELETON],
      [DEMO_FILES.index, PROVIDER_INDEX_SKELETON],
    ]) {
      validatePath(root, path);
      operations.push({ action: 'MODIFY', path, after });
    }
    validatePath(root, DEMO_FILES.lifecycleTest);
    operations.push({ action: 'DELETE', path: DEMO_FILES.lifecycleTest });
  }

  const markerContents = `${JSON.stringify(
    {
      name: options.name,
      removeDemo,
      setupVersion: SETUP_VERSION,
      slug: options.slug,
    },
    null,
    2,
  )}\n`;
  const markerPath = validatePath(root, SETUP_MARKER, true);
  if (!marker || readFileSync(markerPath, 'utf8') !== markerContents) {
    operations.push({
      action: marker ? 'MODIFY' : 'CREATE',
      path: SETUP_MARKER,
      after: markerContents,
    });
  }

  operations.sort((left, right) => left.path.localeCompare(right.path));
  process.stdout.write('Planned changes:\n');
  for (const operation of operations) {
    process.stdout.write(`  ${operation.action} ${operation.path}\n`);
  }

  if (options.dryRun) {
    process.stdout.write('\nDry run: no files were changed.\n\n');
  } else {
    const executionOperations = [
      ...operations.filter((operation) => operation.path !== SETUP_MARKER),
      ...operations.filter((operation) => operation.path === SETUP_MARKER),
    ];
    for (const operation of executionOperations) {
      const path = join(root, operation.path);
      if (operation.action === 'DELETE') rmSync(path);
      else writeSafely(path, operation.after);
    }
    process.stdout.write('\nStarter customization complete.\n\n');
  }
  process.stdout.write(nextSteps());
}

if (
  resolve(process.argv[1] ?? '') === resolve(fileURLToPath(import.meta.url))
) {
  try {
    runSetup(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    process.stderr.write(`Setup failed: ${message}\n`);
    process.exitCode = 1;
  }
}
