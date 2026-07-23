import { describe, expect, it } from 'vitest';
import {
  deriveDoneDownloadState,
  deriveUpdatedDownloadState,
  isTerminalDownloadState,
  normalizeDownloadByteCount,
} from '../src/main/downloads/download-state';

describe('download state normalization', () => {
  it('maps progressing, paused and resumable interruption states', () => {
    expect(deriveUpdatedDownloadState('progressing', false, true)).toEqual({
      state: 'progressing',
      canResume: false,
    });
    expect(deriveUpdatedDownloadState('progressing', true, true)).toEqual({
      state: 'paused',
      canResume: true,
    });
    expect(deriveUpdatedDownloadState('interrupted', false, true)).toEqual({
      state: 'interrupted',
      canResume: true,
    });
  });

  it('maps terminal interruption to failed and identifies terminal states', () => {
    expect(deriveDoneDownloadState('completed')).toBe('completed');
    expect(deriveDoneDownloadState('cancelled')).toBe('cancelled');
    expect(deriveDoneDownloadState('interrupted')).toBe('failed');
    expect(isTerminalDownloadState('interrupted')).toBe(false);
    expect(isTerminalDownloadState('failed')).toBe(true);
  });

  it.each([
    [0, 0],
    [42, 42],
    [-1, 0],
    [1.5, 0],
    [Number.MAX_SAFE_INTEGER + 1, 0],
    [Number.NaN, 0],
  ])('normalizes byte count %s', (input, expected) => {
    expect(normalizeDownloadByteCount(input)).toBe(expected);
  });
});
