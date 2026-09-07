import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Guards against silent test exclusion: the root `test:packages` script
// enumerates workspace packages by hand, so a newly added package can be
// omitted and `pnpm check` stays green without ever running its tests. This
// test fails the moment a package with a `test` script is missing from
// `test:packages`. (ShipStation feedback #8.)

const root = new URL('..', import.meta.url).pathname;

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(root, path), 'utf8')) as Record<
    string,
    unknown
  >;
}

/** Parse the `dir/*` globs pnpm-workspace.yaml lists under `packages:`. */
async function workspaceGlobDirs(): Promise<string[]> {
  const yaml = await readFile(join(root, 'pnpm-workspace.yaml'), 'utf8');
  const dirs: string[] = [];
  for (const line of yaml.split(/\r?\n/u)) {
    const match = /^\s*-\s*['"]?([^'"\s]+?)\/\*['"]?\s*$/u.exec(line);
    if (match) dirs.push(match[1]!);
  }
  return dirs;
}

/** Every workspace package directory (parent of a package.json). */
async function workspacePackageDirs(): Promise<string[]> {
  const dirs: string[] = [];
  for (const globDir of await workspaceGlobDirs()) {
    const entries = await readdir(join(root, globDir), { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) dirs.push(join(globDir, entry.name));
    }
  }
  return dirs;
}

describe('root test:packages enumerates every testable workspace package', () => {
  it('references every workspace package that defines a test script', async () => {
    const rootScripts = ((await readJson('package.json')).scripts ??
      {}) as Record<string, string>;
    const testPackages = rootScripts['test:packages'] ?? '';
    expect(testPackages).not.toBe('');

    const missing: string[] = [];
    for (const dir of await workspacePackageDirs()) {
      const pkg = (await readJson(join(dir, 'package.json'))) as {
        name?: string;
        scripts?: Record<string, string>;
      };
      if (!pkg.scripts?.test || !pkg.name) continue;
      // Must appear as an explicit `--filter <name>` target.
      if (!testPackages.includes(`--filter ${pkg.name} `))
        missing.push(pkg.name);
    }

    expect(missing).toEqual([]);
  });
});
