import { describe, expect, it } from 'vitest';
import {
  parseBoolean,
  parseBrowserBounds,
  parseSessionId,
  parseTerminalCreateOptions,
  parseTerminalSize,
} from '../src/main/ipc/validation';

describe('IPC validation', () => {
  it('accepts integer browser bounds in the supported range', () => {
    expect(parseBrowserBounds({ x: 80, y: 120, width: 480, height: 620 })).toEqual({
      x: 80,
      y: 120,
      width: 480,
      height: 620,
    });
  });

  it.each([
    { x: -1, y: 0, width: 100, height: 100 },
    { x: 0.5, y: 0, width: 100, height: 100 },
    { x: 0, y: 0, width: 100, height: 100, extra: true },
  ])('rejects malformed browser bounds', (bounds) => {
    expect(() => parseBrowserBounds(bounds)).toThrow(TypeError);
  });

  it('accepts supported terminal profiles and safe sizes', () => {
    expect(parseTerminalCreateOptions({ cwd: 'C:\\work', shell: 'powershell' })).toEqual({
      cwd: 'C:\\work',
      shell: 'powershell',
    });
    expect(parseTerminalSize(120, 32)).toEqual({ columns: 120, rows: 32 });
  });

  it('rejects unsupported profiles and terminal dimensions', () => {
    expect(() => parseTerminalCreateOptions({ shell: 'fish' })).toThrow(TypeError);
    expect(() => parseTerminalSize(0, 32)).toThrow(TypeError);
    expect(() => parseTerminalSize(120, 1_001)).toThrow(TypeError);
  });

  it('accepts only UUID v4 terminal session identifiers', () => {
    expect(parseSessionId('123e4567-e89b-42d3-a456-426614174000')).toBe(
      '123e4567-e89b-42d3-a456-426614174000',
    );
    expect(() => parseSessionId('../../another-session')).toThrow(TypeError);
  });

  it('does not coerce boolean values', () => {
    expect(parseBoolean(true, 'visible')).toBe(true);
    expect(() => parseBoolean('true', 'visible')).toThrow(TypeError);
  });
});
