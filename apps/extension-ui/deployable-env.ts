import { loadEnv } from 'vite';

/**
 * Fails a production `vite build` when development-only env has leaked into it.
 *
 * Vite applies `.env.local` in *every* mode, so a mock flag a developer sets on
 * day one silently follows them into `vite build` and ships. The runtime guard
 * in src/bridge.ts is the last line of defense, but it fires in the customer's
 * browser with a message that names no file. This one fires on the developer's
 * machine and names the cause. Keep development overrides in
 * `.env.development.local` (mode-scoped, never applied to a production build)
 * and deployed values in the tracked `.env.production`.
 */
export function assertDeployableEnv(mode: string, dir: string): void {
  const env = loadEnv(mode, dir, 'VITE_');
  const problems: string[] = [];
  if (env.VITE_USE_MOCK_BRIDGE === 'true')
    problems.push('VITE_USE_MOCK_BRIDGE=true (a development-only mock flag)');
  for (const name of [
    'VITE_THROTTLE_DASHBOARD_ORIGIN',
    'VITE_CONNECTOR_API_ORIGIN',
  ]) {
    const value = env[name];
    if (value && !value.startsWith('https://'))
      problems.push(`${name}=${value} (must be an https:// origin)`);
  }
  if (problems.length > 0)
    throw new Error(
      [
        'Refusing to build the extension UI for production with development-only env:',
        ...problems.map((problem) => `  - ${problem}`),
        'These usually come from apps/extension-ui/.env.local, which Vite applies in every',
        'mode. Move development overrides to .env.development.local (mode-scoped) and set',
        'deployed values in .env.production.',
      ].join('\n'),
    );
}
