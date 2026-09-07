import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';
import { workspaceAliases } from '../../vitest.workspace-aliases.mjs';
import { assertDeployableEnv } from './deployable-env.js';

export default defineConfig(({ mode }) => {
  // Fail fast on the developer's machine if development-only env would ship.
  if (mode === 'production') assertDeployableEnv(mode, import.meta.dirname);
  return {
    plugins: [react()],
    resolve: { alias: workspaceAliases },
    test: {
      environment: 'jsdom',
      setupFiles: './src/test-setup.ts',
    },
  };
});
