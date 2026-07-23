export function approveWindowClose(
  hasUnsavedDraft: boolean,
  confirmDiscard: () => boolean,
): boolean {
  return !hasUnsavedDraft || confirmDiscard();
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
