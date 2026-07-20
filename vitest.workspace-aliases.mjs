import { URL, fileURLToPath } from 'node:url';

const WORKSPACE_ROOT = fileURLToPath(new URL('.', import.meta.url));

const WORKSPACE_PACKAGES = [
  [
    '@starter/adapters-cloudflare-queue',
    'packages/adapters-cloudflare-queue/src/index.ts',
  ],
  ['@starter/adapters-d1', 'packages/adapters-d1/src/index.ts'],
  ['@starter/contracts', 'packages/contracts/src/index.ts'],
  // Must precede '@starter/core': alias resolution matches by prefix, so the
  // more specific subpath entry has to come first or it never gets reached.
  ['@starter/core/test-support', 'packages/core/src/contract-tests.ts'],
  ['@starter/core', 'packages/core/src/index.ts'],
  ['@starter/demo-connector', 'examples/demo-connector/src/index.ts'],
  ['@starter/security', 'packages/security/src/index.ts'],
  ['@starter/throttle', 'packages/throttle/src/index.ts'],
];

// Every package/app Vitest config resolves @starter/* imports to workspace
// source files, never to a sibling package's dist/ output. This keeps tests
// green immediately after editing a dependency's source, and means `pnpm
// test` never depends on `pnpm build` having already run (e.g. on a fresh
// clone, where no dist/ directories exist yet).
export const workspaceAliases = Object.fromEntries(
  WORKSPACE_PACKAGES.map(([name, relativePath]) => [
    name,
    `${WORKSPACE_ROOT}${relativePath}`,
  ]),
);
