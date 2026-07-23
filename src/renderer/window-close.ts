import type { WindowCloseReason } from '../shared/contracts';

export function approveWindowClose(
  hasUnsavedDraft: boolean,
  confirmDiscard: () => boolean,
): boolean {
  return !hasUnsavedDraft || confirmDiscard();
}

export type WindowCloseProtectionDecision = 'approve' | 'reject' | 'cancel-import';

interface WindowCloseProtectionInput {
  readonly reason: WindowCloseReason;
  readonly hasUnsavedDraft: boolean;
  readonly noteDiscardPreviouslyApproved: boolean;
  readonly dataReplacementApproved: boolean;
  readonly importPreviewOpen: boolean;
  readonly importCommitInFlight: boolean;
}

export function evaluateWindowCloseProtection(
  input: WindowCloseProtectionInput,
  confirmDiscardDraft: () => boolean,
  confirmCancelImport: () => boolean,
): WindowCloseProtectionDecision {
  const noteApproved = approveWindowClose(input.hasUnsavedDraft, () =>
    input.reason === 'data-replacement' && input.noteDiscardPreviouslyApproved
      ? true
      : confirmDiscardDraft(),
  );
  if (!noteApproved) return 'reject';
  if (input.reason === 'data-replacement' && input.dataReplacementApproved) {
    return 'approve';
  }
  if (input.importCommitInFlight) return 'reject';
  if (!input.importPreviewOpen) return 'approve';
  return confirmCancelImport() ? 'cancel-import' : 'reject';
}

export function shouldProtectWindowUnload(hasUnsavedDraft: boolean): boolean {
  return hasUnsavedDraft;
}

export function synchronizeDirtyDraft(
  dirtyRef: { current: boolean },
  updateState: (dirty: boolean) => void,
  dirty: boolean,
): void {
  dirtyRef.current = dirty;
  updateState(dirty);
}
