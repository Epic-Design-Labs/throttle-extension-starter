import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';
import { workspaceAliases } from '../../vitest.workspace-aliases.mjs';

export default defineConfig({
  plugins: [react()],
  resolve: { alias: workspaceAliases },
  test: {
    environment: 'jsdom',
    setupFiles: './src/test-setup.ts',
  },
});
