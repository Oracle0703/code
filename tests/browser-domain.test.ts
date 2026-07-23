import { describe, expect, it } from 'vitest';
import {
  BROWSER_DEFAULT_TITLE,
  BROWSER_TITLE_MAX_LENGTH,
  normalizeBrowserId,
  normalizeBrowserRevision,
  normalizeBrowserTitle,
  sanitizeBrowserTitle,
} from '../src/shared/browser-domain';

describe('browser persistence domain', () => {
  it('accepts only lowercase UUID v4 identifiers and positive safe revisions', () => {
    expect(normalizeBrowserId('123e4567-e89b-42d3-a456-426614174000')).toBe(
      '123e4567-e89b-42d3-a456-426614174000',
    );
    expect(() => normalizeBrowserId('123E4567-E89B-42D3-A456-426614174000')).toThrow(TypeError);
    expect(() => normalizeBrowserId('123e4567-e89b-12d3-a456-426614174000')).toThrow(TypeError);
    expect(normalizeBrowserRevision(1)).toBe(1);
    expect(normalizeBrowserRevision(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => normalizeBrowserRevision(0)).toThrow(TypeError);
  });

  it('sanitizes untrusted page titles into a bounded persisted form', () => {
    expect(sanitizeBrowserTitle('  API\nreference\u0000  ')).toBe('API reference');
    expect(sanitizeBrowserTitle('invoice\u202egpj.exe\u2066')).toBe('invoice gpj.exe');
    expect(sanitizeBrowserTitle('\u0000\u0007')).toBe(BROWSER_DEFAULT_TITLE);
    expect(sanitizeBrowserTitle('\ud800')).toBe(BROWSER_DEFAULT_TITLE);
    expect(sanitizeBrowserTitle('🙂'.repeat(BROWSER_TITLE_MAX_LENGTH + 2))).toBe(
      '🙂'.repeat(BROWSER_TITLE_MAX_LENGTH),
    );
  });

  it('accepts only titles already in canonical persisted form', () => {
    expect(normalizeBrowserTitle('技术文档 👩‍💻')).toBe('技术文档 👩‍💻');
    expect(() => normalizeBrowserTitle(' title ')).toThrow(TypeError);
    expect(() => normalizeBrowserTitle('line one\nline two')).toThrow(TypeError);
    expect(() => normalizeBrowserTitle('safe\u202eevil')).toThrow(TypeError);
  });
});
