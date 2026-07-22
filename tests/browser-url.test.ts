import { describe, expect, it } from 'vitest';
import { isAllowedBrowserUrl, normalizeBrowserUrl } from '../src/main/security/browser-url';

describe('normalizeBrowserUrl', () => {
  it('adds HTTPS to a host entered without a scheme', () => {
    expect(normalizeBrowserUrl('example.com/docs')).toBe('https://example.com/docs');
  });

  it('preserves explicit HTTP and HTTPS addresses', () => {
    expect(normalizeBrowserUrl('http://localhost:3000')).toBe('http://localhost:3000/');
    expect(normalizeBrowserUrl('https://example.com?q=work')).toBe('https://example.com/?q=work');
  });

  it('allows the internal blank page', () => {
    expect(normalizeBrowserUrl('about:blank')).toBe('about:blank');
  });

  it.each([
    'javascript:alert(1)',
    'file:///etc/passwd',
    'data:text/html,hello',
    'https://user:password@example.com',
    'https://exa\u0000mple.com',
  ])('rejects unsafe address %s', (address) => {
    expect(() => normalizeBrowserUrl(address)).toThrow(TypeError);
    expect(isAllowedBrowserUrl(address)).toBe(false);
  });
});
