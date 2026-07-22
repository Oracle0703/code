import { describe, expect, it } from 'vitest';
import {
  createTrustedRendererLocation,
  isTrustedRendererUrl,
} from '../src/main/security/trusted-renderer';

describe('trusted renderer location', () => {
  it('accepts only the exact Vite development origin', () => {
    const trusted = createTrustedRendererLocation('http://localhost:5173/', true);

    expect(isTrustedRendererUrl('http://localhost:5173/src/main.tsx', trusted)).toBe(true);
    expect(isTrustedRendererUrl('http://localhost:5174/', trusted)).toBe(false);
    expect(isTrustedRendererUrl('https://localhost:5173/', trusted)).toBe(false);
    expect(isTrustedRendererUrl('http://localhost.evil.test:5173/', trusted)).toBe(false);
  });

  it('accepts only the exact packaged renderer file URL', () => {
    const entryUrl = 'file:///opt/Daily%20Workbench/renderer/main_window/index.html';
    const trusted = createTrustedRendererLocation(entryUrl, false);

    expect(isTrustedRendererUrl(entryUrl, trusted)).toBe(true);
    expect(isTrustedRendererUrl(`${entryUrl}#settings`, trusted)).toBe(false);
    expect(isTrustedRendererUrl(`${entryUrl}?source=other`, trusted)).toBe(false);
    expect(
      isTrustedRendererUrl('file:///opt/Daily%20Workbench/renderer/other/index.html', trusted),
    ).toBe(false);
  });

  it('rejects a renderer entry with an unexpected protocol', () => {
    expect(() => createTrustedRendererLocation('file:///tmp/index.html', true)).toThrow(TypeError);
    expect(() => createTrustedRendererLocation('https://example.com/', false)).toThrow(TypeError);
    expect(isTrustedRendererUrl('not a URL', { kind: 'development-origin', origin: 'x' })).toBe(
      false,
    );
  });
});
