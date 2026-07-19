import type { ConfigurationValue } from '@starter/core';
import type { Hono } from 'hono';
import type { AppBindings, AppDependencies } from '../app.js';
import { identity, requireMutationRole } from '../middleware/auth.js';
import { isJsonContentType } from '../middleware/content-type.js';
import { forbidden, invalidRequest } from '../middleware/errors.js';

const MAX_BODY_BYTES = 32 * 1024;
const encoder = new TextEncoder();

function scope(current: ReturnType<typeof identity>) {
  return {
    workspaceId: current.workspaceId,
    applicationId: current.applicationId,
    environmentId: current.environmentId,
  };
}

async function activeInstallation(
  c: Parameters<typeof identity>[0],
  dependencies: AppDependencies,
) {
  const current = identity(c);
  const installation = await dependencies.installations.get(
    current.installationId,
    scope(current),
  );
  if (installation?.status !== 'active') throw forbidden();
  return installation;
}

function safeJson(value: unknown): value is ConfigurationValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string')
    return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(safeJson);
  if (typeof value !== 'object') return false;
  return Object.keys(value).every(
    (key) =>
      key !== '__proto__' &&
      key !== 'prototype' &&
      key !== 'constructor' &&
      safeJson((value as Record<string, unknown>)[key]),
  );
}

async function jsonBody(c: Parameters<typeof identity>[0]): Promise<unknown> {
  if (!isJsonContentType(c.req.header('content-type'))) throw invalidRequest();
  const text = await c.req.text();
  if (!text || encoder.encode(text).byteLength > MAX_BODY_BYTES)
    throw invalidRequest();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw invalidRequest();
  }
}

export function registerConnectorRoutes(
  app: Hono<AppBindings>,
  dependencies: AppDependencies,
) {
  app.get('/api/installation', async (c) => {
    const current = identity(c);
    const installation = await dependencies.installations.get(
      current.installationId,
      scope(current),
    );
    return c.json({ status: installation?.status ?? 'not_configured' });
  });

  app.put('/api/installation/secrets', async (c) => {
    requireMutationRole(c);
    if (new URL(c.req.url).protocol !== 'https:') throw invalidRequest();
    const body = await jsonBody(c);
    if (typeof body !== 'object' || body === null || Array.isArray(body))
      throw invalidRequest();
    const value = body as Record<string, unknown>;
    if (
      !Object.keys(value).every((key) =>
        ['throttleApiKey', 'webhookSigningSecret', 'replace'].includes(key),
      ) ||
      typeof value.throttleApiKey !== 'string' ||
      value.throttleApiKey.length < 1 ||
      value.throttleApiKey.length > 8192 ||
      typeof value.webhookSigningSecret !== 'string' ||
      value.webhookSigningSecret.length < 1 ||
      value.webhookSigningSecret.length > 8192 ||
      typeof value.replace !== 'boolean'
    )
      throw invalidRequest();
    const current = identity(c);
    const apiKey = encoder.encode(value.throttleApiKey);
    const signingSecret = encoder.encode(value.webhookSigningSecret);
    try {
      const result = await dependencies.bootstrap({
        identity: current,
        throttleApiKey: apiKey,
        webhookSigningSecret: signingSecret,
        replace: value.replace,
      });
      return c.json({ status: result.status });
    } finally {
      apiKey.fill(0);
      signingSecret.fill(0);
    }
  });

  app.get('/api/connector', async (c) => {
    const installation = await activeInstallation(c, dependencies);
    return c.json({
      status: installation.providerAccountReference
        ? 'connected'
        : 'not_connected',
    });
  });

  app.put('/api/connector/credentials', async (c) => {
    requireMutationRole(c);
    await activeInstallation(c, dependencies);
    const body = await jsonBody(c);
    if (
      typeof body !== 'object' ||
      body === null ||
      Array.isArray(body) ||
      Object.keys(body).length !== 1 ||
      typeof (body as Record<string, unknown>).credentials !== 'string'
    )
      throw invalidRequest();
    const credentials = encoder.encode(
      (body as { credentials: string }).credentials,
    );
    if (credentials.byteLength === 0 || credentials.byteLength > 8192)
      throw invalidRequest();
    try {
      const result = await dependencies.connect({
        identity: identity(c),
        credentials,
      });
      return c.json({
        status: 'connected',
        installationId: result.installationId,
      });
    } finally {
      credentials.fill(0);
    }
  });

  app.get('/api/connector/config', async (c) => {
    const installation = await activeInstallation(c, dependencies);
    return c.json({
      configuration: await dependencies.configurations.get(
        installation.installationId,
      ),
    });
  });
  app.put('/api/connector/config', async (c) => {
    requireMutationRole(c);
    const installation = await activeInstallation(c, dependencies);
    const configuration = await jsonBody(c);
    if (!safeJson(configuration)) throw invalidRequest();
    await dependencies.configurations.set(
      installation.installationId,
      configuration,
    );
    return c.json({ status: 'updated' });
  });
  app.get('/api/activity', async (c) => {
    const installation = await activeInstallation(c, dependencies);
    return c.json({
      activities: await dependencies.activities.list({
        installationId: installation.installationId,
        limit: 50,
      }),
    });
  });
  app.delete('/api/connector', async (c) => {
    requireMutationRole(c);
    await activeInstallation(c, dependencies);
    await dependencies.uninstall({ identity: identity(c) });
    return c.json({ status: 'uninstalled' });
  });
}
