export const SETUP_VERSION = 1;

export const DEFAULT_TEMPLATE = Object.freeze({
  name: 'throttle-extension-starter',
  slug: 'throttle-extension-starter',
});

export const SETUP_MARKER = '.throttle-starter.json';
export const LOCAL_VARIABLES_EXAMPLE = 'apps/cloudflare/.dev.vars.example';
export const LOCAL_VARIABLES_FILE = 'apps/cloudflare/.dev.vars';

export const DEMO_FILES = Object.freeze({
  implementation: 'examples/demo-connector/src/demo-provider.ts',
  test: 'examples/demo-connector/src/demo-provider.test.ts',
  index: 'examples/demo-connector/src/index.ts',
  lifecycleTest: 'tests/e2e/demo-extension.test.ts',
});

function replaceExact(contents, from, to, path, expectedOccurrences = 1) {
  if (from === to) return contents;
  const parts = contents.split(from);
  const occurrences = parts.length - 1;
  if (occurrences !== expectedOccurrences) {
    throw new Error(
      `Expected ${expectedOccurrences} template token occurrence(s) in ${path}, found ${occurrences}`,
    );
  }
  return parts.join(to);
}

function html(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function originalWranglerValue(kind) {
  return {
    worker: 'replace-with-throttle-extension-worker-name',
    database: 'replace-with-d1-database-name',
    queue: 'replace-with-connector-queue',
    deadLetterQueue: 'replace-with-connector-dead-letter-queue',
  }[kind];
}

function wranglerValue(kind, slug, isOriginal) {
  if (isOriginal) return originalWranglerValue(kind);
  return {
    worker: `${slug}-worker`,
    database: `${slug}-db`,
    queue: `${slug}-connector`,
    deadLetterQueue: `${slug}-connector-dead-letter`,
  }[kind];
}

export function templateEdits(current, next) {
  const currentIsOriginal = current.slug === DEFAULT_TEMPLATE.slug;
  const nextIsOriginal = next.slug === DEFAULT_TEMPLATE.slug;
  return [
    {
      path: 'package.json',
      apply(contents) {
        return replaceExact(
          contents,
          `"name": "${current.slug}"`,
          `"name": "${next.slug}"`,
          this.path,
        );
      },
    },
    {
      path: 'README.md',
      apply(contents) {
        return replaceExact(
          contents,
          `# ${current.name}`,
          `# ${next.name}`,
          this.path,
        );
      },
    },
    {
      path: 'apps/extension-ui/index.html',
      apply(contents) {
        const currentTitle =
          current.name === DEFAULT_TEMPLATE.name
            ? 'Connector management'
            : html(current.name);
        return replaceExact(
          contents,
          `<title>${currentTitle}</title>`,
          `<title>${html(next.name)}</title>`,
          this.path,
        );
      },
    },
    {
      path: 'apps/cloudflare/wrangler.jsonc',
      apply(contents) {
        let result = contents;
        for (const kind of ['worker', 'database', 'queue', 'deadLetterQueue']) {
          result = replaceExact(
            result,
            `"${wranglerValue(kind, current.slug, currentIsOriginal)}"`,
            `"${wranglerValue(kind, next.slug, nextIsOriginal)}"`,
            this.path,
            kind === 'queue' ? 2 : 1,
          );
        }
        return result;
      },
    },
  ];
}

export const PROVIDER_SKELETON = `import {
  TerminalProviderError,
  type ProviderConnector,
} from '@starter/core';

/** Replace this skeleton with the provider-specific implementation. */
export function createDemoProvider(): ProviderConnector {
  return {
    async validateCredentials(_credentials) {
      // TODO: validate provider credentials and return a stable account reference.
      throw new TerminalProviderError();
    },
    async handleEvent(_input) {
      // TODO: map Throttle events to idempotent provider API calls.
      throw new TerminalProviderError();
    },
  };
}
`;

export const PROVIDER_INDEX_SKELETON = `export { createDemoProvider } from './demo-provider.js';
`;

export const PROVIDER_TEST_SKELETON = `import { describe, expect, it } from 'vitest';
import { createDemoProvider } from './demo-provider.js';

describe('provider adapter skeleton', () => {
  it('exposes the provider connector contract', () => {
    const provider = createDemoProvider();
    expect(provider.validateCredentials).toBeTypeOf('function');
    expect(provider.handleEvent).toBeTypeOf('function');
  });
});
`;
