import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

function importSpecifiers(source: string): string[] {
  const sourceFile = ts.createSourceFile(
    'source.tsx',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const specifiers: string[] = [];

  function visit(node: ts.Node): void {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0]!)
    ) {
      specifiers.push(node.arguments[0].text);
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return specifiers;
}

function isForbiddenImport(specifier: string): boolean {
  return /^(?:cloudflare:|node:|@cloudflare(?:\/|$)|react(?:[-/]|$)|postgres(?:[-./]|$)|wrangler(?:\/|$))/.test(
    specifier,
  );
}

describe('import specifier inspection', () => {
  it('finds static, export-from, and dynamic imports', () => {
    const source = `
      import React from 'react';
      export { readFile } from 'node:fs/promises';
      const database = import('postgres');
    `;

    expect(importSpecifiers(source)).toEqual([
      'react',
      'node:fs/promises',
      'postgres',
    ]);
    expect(importSpecifiers(source).filter(isForbiddenImport)).toHaveLength(3);
  });

  it('ignores comments, identifiers, and ordinary string content', () => {
    const source = `
      // import React from 'react';
      const wranglerStatus = 'postgres and node: are words, not imports';
      const documentation = "import('@cloudflare/workers-types')";
    `;

    expect(importSpecifiers(source)).toEqual([]);
  });
});

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
  it.each([
    'packages/contracts/src',
    'packages/core/src',
    'packages/security/src',
    'packages/throttle/src',
  ])('%s has no runtime imports', async (dir) => {
    for (const file of await sourceFiles(dir)) {
      const source = await readFile(file, 'utf8');
      expect(importSpecifiers(source).filter(isForbiddenImport)).toEqual([]);
    }
  });

  it('isolates runtime globals and typechecks root tests with Node 20 types', async () => {
    const [base, rootPackage, testsConfig, appConfig, workspacePaths, vitest] =
      await Promise.all([
        readFile('tsconfig.base.json', 'utf8'),
        readFile('package.json', 'utf8'),
        readFile('tsconfig.tests.json', 'utf8'),
        readFile('apps/cloudflare/tsconfig.json', 'utf8'),
        readFile('tsconfig.workspace-paths.json', 'utf8'),
        readFile('vitest.root.config.ts', 'utf8'),
      ]);
    expect(JSON.parse(base)).toMatchObject({ compilerOptions: { types: [] } });
    expect(JSON.parse(rootPackage)).toMatchObject({
      scripts: {
        test: expect.stringContaining('vitest run --config'),
        typecheck: expect.stringContaining('tsconfig.tests.json'),
      },
      devDependencies: { '@types/node': expect.stringMatching(/^20\./u) },
    });
    expect(JSON.parse(testsConfig)).toMatchObject({
      extends: ['./tsconfig.base.json', './tsconfig.workspace-paths.json'],
      compilerOptions: { types: ['node', 'vitest/globals'] },
    });
    expect(JSON.parse(appConfig)).toMatchObject({
      extends: [
        '../../tsconfig.base.json',
        '../../tsconfig.workspace-paths.json',
      ],
    });
    const paths = JSON.parse(workspacePaths).compilerOptions.paths as Record<
      string,
      string[]
    >;
    expect(paths).toEqual({
      '@starter/adapters-cloudflare-queue': [
        './packages/adapters-cloudflare-queue/src/index.ts',
      ],
      '@starter/adapters-d1': ['./packages/adapters-d1/src/index.ts'],
      '@starter/contracts': ['./packages/contracts/src/index.ts'],
      '@starter/core': ['./packages/core/src/index.ts'],
      '@starter/core/test-support': ['./packages/core/src/contract-tests.ts'],
      '@starter/demo-connector': ['./examples/demo-connector/src/index.ts'],
      '@starter/security': ['./packages/security/src/index.ts'],
      '@starter/throttle': ['./packages/throttle/src/index.ts'],
    });
    for (const [alias, [source]] of Object.entries(paths)) {
      expect(vitest).toContain(`'${alias}'`);
      expect(vitest).toContain(source!.replace(/^\.\//u, ''));
    }
  });

  it('resolves every no-emit workspace typecheck from source without changing emit configs', async () => {
    const noEmitConfigs = [
      'packages/contracts/tsconfig.json',
      'packages/core/tsconfig.json',
      'packages/security/tsconfig.json',
      'packages/throttle/tsconfig.json',
      'packages/adapters-cloudflare-queue/tsconfig.json',
      'packages/adapters-d1/tsconfig.json',
      'examples/demo-connector/tsconfig.json',
      'apps/cloudflare/tsconfig.json',
      'apps/extension-ui/tsconfig.json',
    ];
    for (const path of noEmitConfigs) {
      const config = JSON.parse(await readFile(path, 'utf8')) as {
        extends?: unknown;
        compilerOptions?: { noEmit?: unknown; rootDir?: unknown };
      };
      expect(config.compilerOptions?.noEmit).toBe(true);
      expect(config.compilerOptions?.rootDir).toBe('../..');
      expect(config.extends).toEqual(
        expect.arrayContaining(['../../tsconfig.workspace-paths.json']),
      );
    }

    for (const path of [
      'packages/contracts/tsconfig.build.json',
      'packages/core/tsconfig.build.json',
      'packages/security/tsconfig.build.json',
      'packages/throttle/tsconfig.build.json',
      'packages/adapters-cloudflare-queue/tsconfig.build.json',
      'packages/adapters-d1/tsconfig.build.json',
      'examples/demo-connector/tsconfig.build.json',
    ]) {
      const config = JSON.parse(await readFile(path, 'utf8')) as {
        extends?: unknown;
        compilerOptions?: { noEmit?: unknown; rootDir?: unknown };
      };
      expect(config.extends).toBe('../../tsconfig.base.json');
      expect(config.compilerOptions).toMatchObject({
        noEmit: false,
        rootDir: 'src',
      });
    }
  });
});
