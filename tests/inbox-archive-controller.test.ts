import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const controllerSource = readFileSync(
  new URL('../src/renderer/hooks/useInboxController.ts', import.meta.url),
  'utf8',
);
const appSource = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
const workspaceControllerSource = readFileSync(
  new URL('../src/renderer/hooks/useWorkspaceController.ts', import.meta.url),
  'utf8',
);
const pageSource = readFileSync(
  new URL('../src/renderer/components/InboxPage.tsx', import.meta.url),
  'utf8',
);

describe('inbox archive controller contract', () => {
  it('separates retryable archive failure from post-commit exact reconciliation', () => {
    const archiveFlow = sourceBetween(
      controllerSource,
      '  const archive = useCallback(',
      '  const undoArchive = useCallback(',
    );
    const mainCall = archiveFlow.indexOf('await window.workbench.inbox.archive({');
    const reconciliation = archiveFlow.indexOf('await reconcileInboxArchiveResult({');
    const publication = archiveFlow.indexOf('const notice: InboxUndoNoticeState = {');

    expect(archiveFlow).toContain('createInboxArchiveMutationIntent(target.workspaceId, entry)');
    expect(archiveFlow).toContain("archiveCoordinator.begin(target, 'archive')");
    expect(mainCall).toBeGreaterThanOrEqual(0);
    expect(reconciliation).toBeGreaterThan(mainCall);
    expect(publication).toBeGreaterThan(reconciliation);
    expect(archiveFlow.slice(0, reconciliation)).toContain(
      "operationFailure(error, request.workspace, '归档失败，请重试。')",
    );
    expect(archiveFlow.slice(reconciliation)).not.toContain('operationFailure(');
    expect(archiveFlow.slice(reconciliation)).toContain(
      "phase: reconciliation.committed ? 'archived' : 'archive-recovery'",
    );
    expect(archiveFlow.slice(reconciliation)).toContain('archiveCoordinator.isActive');
  });

  it('uses Main expiration and consumes the token once before fail-closed undo recovery', () => {
    const expirationFlow = sourceBetween(
      controllerSource,
      '  useEffect(() => {\n    const expiringNotices',
      '  const clearOperationErrorFor = useCallback(',
    );
    const archiveFlow = sourceBetween(
      controllerSource,
      '  const archive = useCallback(',
      '  const undoArchive = useCallback(',
    );
    const undoFlow = sourceBetween(
      controllerSource,
      '  const undoArchive = useCallback(',
      '  const refreshArchiveNotice = useCallback(',
    );
    const mainCall = undoFlow.indexOf('await window.workbench.inbox.undoArchive({');
    const reconciliation = undoFlow.indexOf('await reconcileInboxUndoResult({');

    expect(archiveFlow).toContain(
      'inboxUndoMonotonicDeadline(result.undoExpiresAt, Date.now(), monotonicNowMs)',
    );
    expect(archiveFlow).not.toContain('INBOX_UNDO_WINDOW_MS');
    expect(undoFlow).toContain("archiveCoordinator.begin(target, 'undo', currentNotice.undoToken)");
    expect(undoFlow).toContain(
      "(currentNotice.phase === 'archived' && hasArchiveRecovery(target.workspaceId))",
    );
    expect(undoFlow).toContain('window.performance.now() >= currentNotice.expiresAtMonotonicMs');
    expect(mainCall).toBeGreaterThanOrEqual(0);
    expect(reconciliation).toBeGreaterThan(mainCall);
    expect(undoFlow.slice(0, reconciliation)).toContain(
      "operationFailure(error, request.workspace, '撤销失败或已过期。')",
    );
    expect(undoFlow.slice(0, reconciliation)).toContain('refreshError: failure.message');
    expect(undoFlow.slice(reconciliation)).not.toContain('operationFailure(');
    expect(undoFlow.slice(reconciliation)).toContain("phase: 'undo-recovery'");
    expect(undoFlow.slice(reconciliation)).toContain('undoAvailable: false');
    expect(expirationFlow).toContain('!pendingUndoOperationsRef.current.has(notice.undoToken)');
    expect(expirationFlow).toContain('undoAvailable: false, focusActionOnMount: true');
  });

  it('recovers an exact warning only through committed reads and never replays a mutation', () => {
    const recoveryFlow = sourceBetween(
      controllerSource,
      '  const refreshArchiveNotice = useCallback(',
      '  const invalidateArchiveMutations = useCallback(',
    );

    expect(recoveryFlow).toMatch(
      /archiveCoordinator\.begin\(\s*target,\s*'recover',\s*currentNotice\.undoIntent\?\.undoToken \?\? null/u,
    );
    expect(recoveryFlow).toContain('reconcileInboxArchiveResult({');
    expect(recoveryFlow).toContain('reconcileInboxUndoResult({');
    expect(recoveryFlow.match(/commitResultSnapshot: \(\) => false/gu)).toHaveLength(2);
    expect(recoveryFlow).toContain('prepareSnapshotRefresh');
    expect(recoveryFlow).toContain('refreshError:');
    expect(recoveryFlow).not.toContain('window.workbench.inbox.archive(');
    expect(recoveryFlow).not.toContain('window.workbench.inbox.undoArchive(');
  });

  it('uses identity-safe pending cleanup and blocks competing controller and page actions', () => {
    const pendingFlow = sourceBetween(
      controllerSource,
      '  const beginPendingEntry = useCallback(',
      '  const beginPendingCapture = useCallback(',
    );
    const taskConversion = sourceBetween(
      appSource,
      '  const convertInboxToTask = useCallback(',
      '  const convertInboxToNote = useCallback(',
    );
    const noteConversion = sourceBetween(
      appSource,
      '  const convertInboxToNote = useCallback(',
      '  const refreshInboxConversionSyncWarning = useCallback(',
    );

    expect(pendingFlow).toContain('generation: ++pendingEntryGenerationRef.current');
    expect(pendingFlow).toContain('pendingEntryOperationsRef.current.get(entryId) !== operation');
    expect(taskConversion).toContain('assertInboxMutationAvailable();');
    expect(noteConversion).toContain('assertInboxMutationAvailable();');
    expect(taskConversion.indexOf('assertInboxMutationAvailable();')).toBeLessThan(
      taskConversion.indexOf('inboxConversionNavigation.invalidate();'),
    );
    expect(noteConversion.indexOf('assertInboxMutationAvailable();')).toBeLessThan(
      noteConversion.indexOf('inboxConversionNavigation.invalidate();'),
    );
    expect(pageSource).toContain('inboxMutationBlocked');
    expect(pageSource).toContain('inbox-mutation-blocked-reason');
    expect(pageSource).toContain('data-inbox-archive-id={entry.id}');
    expect(pageSource).toContain('data-inbox-entry-id={entry.id}');
  });

  it('invalidates only after a real replacement commit and leaves close approval alone', () => {
    const restoreFlow = sourceBetween(
      appSource,
      '  const restoreBackupWithApproval = useCallback(',
      '  const restoreManualBackupSyncWarningFocus = useCallback(',
    );
    const importFlow = sourceBetween(appSource, '{dataState.importPreview ?', '<InboxUndoStack');
    const closeFlow = sourceBetween(
      appSource,
      'window.workbench.window.onCloseRequest',
      'const protectDraft',
    );

    expect(restoreFlow.indexOf('assertInboxMutationAvailable();')).toBeLessThan(
      restoreFlow.indexOf('await restoreBackup(input)'),
    );
    expect(restoreFlow.indexOf('invalidateInboxArchiveMutations();')).toBeGreaterThan(
      restoreFlow.indexOf('} else {'),
    );
    expect(importFlow.indexOf('assertInboxMutationAvailable();')).toBeLessThan(
      importFlow.indexOf('await commitImport();'),
    );
    expect(importFlow.indexOf('invalidateInboxArchiveMutations();')).toBeGreaterThan(
      importFlow.indexOf('await commitImport();'),
    );
    expect(closeFlow).not.toContain('invalidateInboxArchiveMutations');
  });

  it('renders the cross-page recovery surface with blocked state and focus fallback', () => {
    const stack = sourceBetween(appSource, '<InboxUndoStack', '>');

    expect(stack).toContain('notices={visibleUndoNotices}');
    expect(stack).toContain('pendingTokens={inboxController.pendingUndoTokens}');
    expect(stack).toContain('focusBlocked={overlayOpen}');
    expect(stack).toContain('workspaceLeasePending={inboxController.archiveOperationPending}');
    expect(stack).toContain('workspaceRecoveryPending={inboxController.archiveRecoveryPending}');
    expect(stack).toContain('workspaceController.pendingOperation !== null');
    expect(stack).toContain('onUndo={undoInboxArchive}');
    expect(stack).toContain('onRefresh={refreshInboxArchiveNotice}');
    expect(stack).toContain('onDismiss={dismissInboxArchiveNotice}');
    expect(stack).toContain('onFocusFallback={restoreInboxArchiveNoticeFocus}');
    expect(appSource).toContain("document.querySelectorAll<HTMLElement>('[data-inbox-entry-id]')");
  });

  it('keeps a recovery in its owning workspace until exact reconciliation completes', () => {
    const workspaceActivation = sourceBetween(
      appSource,
      '  const requestWorkspaceActivation = useCallback(',
      '  const createWorkspace = useCallback(',
    );
    const workspaceArchive = sourceBetween(
      appSource,
      '  const archiveWorkspace = useCallback(',
      '  const openQuickCapture = useCallback(',
    );
    const searchNavigation = sourceBetween(
      appSource,
      '  const selectSearchResult = useCallback(',
      '  const commands = useMemo<PaletteCommand[]>',
    );

    expect(workspaceActivation).toContain('inboxWorkspaceChangeIsBlocked()');
    expect(workspaceArchive).toContain('inboxWorkspaceChangeIsBlocked()');
    expect(searchNavigation).toContain('inboxWorkspaceChangeIsBlocked()');
    expect(appSource).toContain(
      'inboxWorkspaceChangeBlocked || noteWorkspaceChangeBlocked || scheduleWorkspaceChangeBlocked',
    );
    expect(appSource).toContain("'请先确认当前收件箱归档或撤销，再切换工作区。'");
    expect(appSource).toContain('workspaceController.pendingOperation !== null ||');
    expect(appSource).toContain('onCategorize={categorizeInbox}');
    expect(appSource).toContain('onArchive={archiveInbox}');
    expect(workspaceControllerSource).toContain('mutationInFlightRef.current');
    expect(workspaceControllerSource).toContain('assertMutationAvailable(): void;');
    expect(workspaceControllerSource).toContain('assertMutationAvailable,');
  });
});

function sourceBetween(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  expect(startIndex, `missing source marker: ${start}`).toBeGreaterThanOrEqual(0);
  expect(endIndex, `missing source marker: ${end}`).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}
