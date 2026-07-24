import { describe, expect, it } from 'vitest';

import { shouldIgnorePackagerPath } from '../forge.config';

describe('Forge packager filter', () => {
  it.each([
    '',
    '/package.json',
    '/.vite',
    '/.vite/build/main.js',
    '/node_modules',
    '/node_modules/node-pty',
    '/node_modules/node-pty/lib/index.js',
    '/node_modules/node-addon-api',
    '/node_modules/node-addon-api/napi.h',
  ])('keeps required path %s', (filePath) => {
    expect(shouldIgnorePackagerPath(filePath)).toBe(false);
  });

  it.each([
    '/.vite-old',
    '/src/main.ts',
    '/src/main/assistant/openai-responses-provider.ts',
    '/tests/helpers/fake-responses-server.ts',
    '/reports/assistant-provider-smoke/assistant-provider-smoke.cjs',
    '/README.md',
    '/node_modules/react/index.js',
    '/node_modules/openai/index.js',
    '/node_modules/@openai/codex/package.json',
  ])('excludes non-runtime path %s', (filePath) => {
    expect(shouldIgnorePackagerPath(filePath)).toBe(true);
  });
});
