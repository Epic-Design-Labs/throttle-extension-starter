import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(dir, entry.name);
      return entry.isDirectory() ? sourceFiles(path) : [path];
    }),
  );
  return nested.flat().filter((path) => /\.[cm]?[jt]sx?$/.test(path));
}

describe('portable package boundaries', () => {
  it.each(['packages/contracts/src', 'packages/core/src'])(
    '%s has no runtime imports',
    async (dir) => {
      for (const file of await sourceFiles(dir)) {
        const source = await readFile(file, 'utf8');
        expect(source).not.toMatch(
          /cloudflare:|node:|@cloudflare|react|postgres|wrangler/,
        );
      }
    },
  );
});
