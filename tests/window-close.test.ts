import { describe, expect, it, vi } from 'vitest';
import {
  approveWindowClose,
  evaluateWindowCloseProtection,
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

  it('checks the note decision before approving a data-replacement close', () => {
    const confirmDiscard = vi.fn(() => false);
    const decision = evaluateWindowCloseProtection(
      {
        reason: 'data-replacement',
        hasUnsavedDraft: true,
        noteDiscardPreviouslyApproved: false,
        dataReplacementApproved: true,
        importPreviewOpen: true,
        importCommitInFlight: true,
      },
      confirmDiscard,
      () => true,
    );

    expect(decision).toBe('reject');
    expect(confirmDiscard).toHaveBeenCalledOnce();
  });

  it('reuses the note approval bound to import commit before approving replacement', () => {
    const confirmDiscard = vi.fn(() => false);
    const decision = evaluateWindowCloseProtection(
      {
        reason: 'data-replacement',
        hasUnsavedDraft: true,
        noteDiscardPreviouslyApproved: true,
        dataReplacementApproved: true,
        importPreviewOpen: true,
        importCommitInFlight: true,
      },
      confirmDiscard,
      () => false,
    );

    expect(decision).toBe('approve');
    expect(confirmDiscard).not.toHaveBeenCalled();
  });

  it('rejects ordinary close during commit and requires preview cancellation otherwise', () => {
    expect(
      evaluateWindowCloseProtection(
        {
          reason: 'window',
          hasUnsavedDraft: false,
          noteDiscardPreviouslyApproved: true,
          dataReplacementApproved: true,
          importPreviewOpen: true,
          importCommitInFlight: true,
        },
        () => true,
        () => true,
      ),
    ).toBe('reject');
    expect(
      evaluateWindowCloseProtection(
        {
          reason: 'window',
          hasUnsavedDraft: false,
          noteDiscardPreviouslyApproved: false,
          dataReplacementApproved: false,
          importPreviewOpen: true,
          importCommitInFlight: false,
        },
        () => true,
        () => true,
      ),
    ).toBe('cancel-import');
  });
});
