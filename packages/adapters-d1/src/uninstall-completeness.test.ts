import { readFile, readdir } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

// Guards the uninstall data-deletion invariant against silent drift. Every
// table that carries an `installation_id` must be a deliberate decision at
// uninstall time: either `markUninstalled` acts on it (delete rows, or cancel
// them), or it is listed in RETAINED_ACROSS_UNINSTALL below with a reason.
//
// Without this guard, a downstream integration that adds a per-installation
// table (e.g. an order-sync watermark) silently retains that tenant's data
// after they uninstall — contradicting AGENTS.md's uninstall invariant and
// docs/operations.md, with nothing to catch it. (ShipStation feedback #10.)

const migrationsDir = new URL('../migrations/', import.meta.url);
const installationsSource = new URL('./installations.ts', import.meta.url);

// Tables deliberately kept after uninstall. Adding an entry here is the
// conscious "retain this" decision; each must say why.
const RETAINED_ACROSS_UNINSTALL: Record<string, string> = {
  // Audit trail — not a secret; retained per docs/operations.md.
  activities: 'audit trail',
  // Webhook idempotency ledger — retained so a replay after uninstall is
  // still deduplicated rather than reprocessed.
  deliveries: 'idempotency ledger',
};

/** Names of every table whose CREATE TABLE body declares an installation_id. */
async function perInstallationTables(): Promise<string[]> {
  const files = (await readdir(migrationsDir))
    .filter((name) => name.endsWith('.sql'))
    .sort();
  const tables: string[] = [];
  for (const file of files) {
    const sql = await readFile(new URL(file, migrationsDir), 'utf8');
    const pattern = /CREATE TABLE (\w+)\s*\(([\s\S]*?)\n\);/gu;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(sql)) !== null) {
      const [, name, body] = match;
      if (/\binstallation_id\b/u.test(body!)) tables.push(name!);
    }
  }
  return tables;
}

/** The body of markUninstalled, where cleanup statements live. */
async function markUninstalledBody(): Promise<string> {
  const source = await readFile(installationsSource, 'utf8');
  const start = source.indexOf('async markUninstalled(');
  expect(start).toBeGreaterThan(-1);
  return source.slice(start);
}

describe('uninstall cleanup covers every per-installation table', () => {
  it('finds the per-installation tables the migrations declare', async () => {
    const tables = await perInstallationTables();
    // Sanity: the known upstream set. If this changes, the assertion below is
    // what enforces a matching cleanup decision.
    expect(new Set(tables)).toEqual(
      new Set([
        'installations',
        'secrets',
        'deliveries',
        'jobs',
        'activities',
        'configurations',
      ]),
    );
  });

  it('acts on or explicitly retains each per-installation table', async () => {
    const body = await markUninstalledBody();
    const unhandled: string[] = [];
    for (const table of await perInstallationTables()) {
      // `installations` is the row markUninstalled transitions; the child
      // tables must be deleted/cancelled there or be explicitly retained.
      const handled =
        new RegExp(`\\b${table}\\b`, 'u').test(body) ||
        table in RETAINED_ACROSS_UNINSTALL;
      if (!handled) unhandled.push(table);
    }
    expect(unhandled).toEqual([]);
  });
});
