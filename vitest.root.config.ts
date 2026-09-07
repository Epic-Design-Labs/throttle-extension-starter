import { defineConfig } from 'vitest/config';
import { workspaceAliases } from './vitest.workspace-aliases.mjs';

export default defineConfig({
  // Single source of truth for @starter/* → source aliases, shared with every
  // package-level vitest config (vitest.workspace-aliases.mjs).
  resolve: { alias: workspaceAliases },
  test: {
    include: ['tests/**/*.test.ts', 'scripts/**/*.test.ts'],
    exclude: ['packages/**', 'apps/**', 'examples/**', '**/dist/**'],
    // scripts/verify-release.test.ts and scripts/setup.test.ts spawn real
    // git/node subprocesses per test; the default 5000ms budget has been
    // observed to trip under CPU load. Give this suite headroom.
    testTimeout: 15_000,
  },
});
