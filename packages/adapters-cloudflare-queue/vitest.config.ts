import { defineConfig } from 'vitest/config';
import { workspaceAliases } from '../../vitest.workspace-aliases.mjs';

export default defineConfig({
  resolve: { alias: workspaceAliases },
  test: { include: ['src/**/*.test.ts'] },
});
