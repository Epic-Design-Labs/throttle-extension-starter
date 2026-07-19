import type { Hono } from 'hono';
import type { AppBindings, AppDependencies } from '../app.js';

export function registerHealthRoutes(
  app: Hono<AppBindings>,
  dependencies: AppDependencies,
) {
  app.get('/health/live', (c) => c.json({ status: 'ok' as const }));
  app.get('/health/ready', async (c) => {
    try {
      return (await dependencies.readiness())
        ? c.json({ status: 'ready' as const })
        : c.json({ status: 'not_ready' as const }, 503);
    } catch {
      return c.json({ status: 'not_ready' as const }, 503);
    }
  });
}
