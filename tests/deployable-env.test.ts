import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertDeployableEnv } from '../apps/extension-ui/deployable-env.js';

// Verifies the extension UI's production build guard rejects development-only
// env before a bundle can ship it. Lives in the root (Node) suite because
// Vite's loadEnv pulls in esbuild, which trips over the UI suite's jsdom
// TextEncoder. (ShipStation feedback #4b.)

const dirs: string[] = [];
function envDir(productionEnv: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'deployable-env-'));
  dirs.push(dir);
  writeFileSync(join(dir, '.env.production'), productionEnv);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('assertDeployableEnv', () => {
  it('passes for a clean production env', () => {
    const dir = envDir(
      [
        'VITE_USE_MOCK_BRIDGE=false',
        'VITE_THROTTLE_DASHBOARD_ORIGIN=https://app.usethrottle.dev',
        'VITE_CONNECTOR_API_ORIGIN=https://worker.example.workers.dev',
      ].join('\n'),
    );
    expect(() => assertDeployableEnv('production', dir)).not.toThrow();
  });

  it('rejects a mock flag that leaked into the production build', () => {
    const dir = envDir('VITE_USE_MOCK_BRIDGE=true');
    expect(() => assertDeployableEnv('production', dir)).toThrow(
      /VITE_USE_MOCK_BRIDGE/u,
    );
  });

  it('rejects a non-HTTPS origin', () => {
    const dir = envDir('VITE_CONNECTOR_API_ORIGIN=http://localhost:8787');
    expect(() => assertDeployableEnv('production', dir)).toThrow(
      /must be an https:\/\/ origin/u,
    );
  });

  it('names .env.local as the likely source', () => {
    const dir = envDir('VITE_USE_MOCK_BRIDGE=true');
    expect(() => assertDeployableEnv('production', dir)).toThrow(
      /\.env\.local/u,
    );
  });
});
