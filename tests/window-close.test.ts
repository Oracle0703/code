import { describe, expect, it, vi } from 'vitest';
import {
  approveWindowClose,
  shouldProtectWindowUnload,
  synchronizeDirtyDraft,
} from '../src/renderer/window-close';

describe('renderer window close protection', () => {
  it('does not prompt when there is no unsaved note draft', () => {
    const confirmDiscard = vi.fn(() => false);
    expect(approveWindowClose(false, confirmDiscard)).toBe(true);
    expect(confirmDiscard).not.toHaveBeenCalled();
  });

  it('preserves a dirty note when the user cancels and keeps unload protection independent', () => {
    expect(approveWindowClose(true, () => false)).toBe(false);
    expect(shouldProtectWindowUnload(true)).toBe(true);
    expect(approveWindowClose(true, () => true)).toBe(true);
    expect(shouldProtectWindowUnload(true)).toBe(true);
    expect(shouldProtectWindowUnload(false)).toBe(false);
  });

  it('updates the close-protection ref before publishing React state', () => {
    const dirtyRef = { current: false };
    const observedRefValues: boolean[] = [];

    synchronizeDirtyDraft(
      dirtyRef,
      () => {
        observedRefValues.push(dirtyRef.current);
      },
      true,
    );

    expect(dirtyRef.current).toBe(true);
    expect(observedRefValues).toEqual([true]);
  });
});
