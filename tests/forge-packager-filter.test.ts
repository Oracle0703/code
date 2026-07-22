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

  it.each(['/.vite-old', '/src/main.ts', '/README.md', '/node_modules/react/index.js'])(
    'excludes non-runtime path %s',
    (filePath) => {
      expect(shouldIgnorePackagerPath(filePath)).toBe(true);
    },
  );
});
