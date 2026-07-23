import { isAbsolute, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createDownloadDefaultPath,
  getDownloadSourceHost,
  sanitizeDownloadDisplayText,
  sanitizeDownloadFileName,
} from '../src/main/downloads/download-security';

describe('download filename security', () => {
  it.each([
    ['../../.ssh/id_rsa', 'id_rsa'],
    ['..\\..\\payload.exe', 'payload.exe'],
    ['/etc/passwd', 'passwd'],
    ['CON', '_CON'],
    ['aux.txt', '_aux.txt'],
    ['..', 'download'],
    ['.env', 'download.env'],
    ['report. ', 'report'],
    ['bad\u0000\u202efile.txt', 'bad__file.txt'],
  ])('sanitizes untrusted suggested name %j', (input, expected) => {
    expect(sanitizeDownloadFileName(input)).toBe(expected);
  });

  it('preserves bounded well-formed Unicode while retaining a short extension', () => {
    const result = sanitizeDownloadFileName(`${'报告👩‍💻'.repeat(100)}.pdf`);
    expect(Array.from(result).length).toBeLessThanOrEqual(180);
    expect(result.endsWith('.pdf')).toBe(true);
  });

  it('constructs an absolute candidate that remains under the trusted directory', () => {
    const directory = resolve('/tmp', 'Daily Workbench 下载');
    const candidate = createDownloadDefaultPath(directory, '../../escape.txt');
    expect(isAbsolute(candidate)).toBe(true);
    expect(relative(directory, candidate)).toBe('escape.txt');
    expect(() => createDownloadDefaultPath('relative/downloads', 'file.txt')).toThrow(TypeError);
  });

  it('exposes only a sanitized source hostname and display metadata', () => {
    expect(
      getDownloadSourceHost([
        'https://user:secret@example.com/private?token=secret',
        'blob:https://files.example/1234',
      ]),
    ).toBe('files.example');
    expect(getDownloadSourceHost(['file:///etc/passwd', 'javascript:alert(1)'])).toBe('');
    expect(sanitizeDownloadDisplayText('text/\u0085plain\u202e.exe', 256)).toBe('text/plain.exe');
  });
});
