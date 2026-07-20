import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: Object.fromEntries(
      [
        [
          '@starter/adapters-cloudflare-queue',
          'packages/adapters-cloudflare-queue/src/index.ts',
        ],
        ['@starter/adapters-d1', 'packages/adapters-d1/src/index.ts'],
        ['@starter/contracts', 'packages/contracts/src/index.ts'],
        // Must precede '@starter/core': alias resolution matches by prefix,
        // so the more specific subpath entry has to come first.
        ['@starter/core/test-support', 'packages/core/src/contract-tests.ts'],
        ['@starter/core', 'packages/core/src/index.ts'],
        ['@starter/demo-connector', 'examples/demo-connector/src/index.ts'],
        ['@starter/security', 'packages/security/src/index.ts'],
        ['@starter/throttle', 'packages/throttle/src/index.ts'],
      ].map(([name, path]) => [
        name,
        fileURLToPath(new URL(path!, import.meta.url)),
      ]),
    ),
  },
  test: {
    include: ['tests/**/*.test.ts', 'scripts/**/*.test.ts'],
    exclude: ['packages/**', 'apps/**', 'examples/**', '**/dist/**'],
    // scripts/verify-release.test.ts and scripts/setup.test.ts spawn real
    // git/node subprocesses per test; the default 5000ms budget has been
    // observed to trip under CPU load. Give this suite headroom.
    testTimeout: 15_000,
  },
});
