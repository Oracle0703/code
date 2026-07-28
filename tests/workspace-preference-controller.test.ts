import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const controllerSource = readFileSync(
  new URL('../src/renderer/hooks/useWorkspaceController.ts', import.meta.url),
  'utf8',
);
const appSource = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
const sidebarSource = readFileSync(
  new URL('../src/renderer/components/WorkspaceSidebar.tsx', import.meta.url),
  'utf8',
);

describe('workspace preference controller contract', () => {
  it('settles frozen intents only against their authoritative returned preferences', () => {
    const sendFlow = sourceBetween(
      controllerSource,
      'const sendPreferencePatch = useCallback(',
      'const flushDirtyPreferences = useCallback(',
    );

    expect(sendFlow).toContain('(intent: WorkspacePreferenceWriteIntent)');
    expect(sendFlow).toContain('workspaceId: intent.workspaceId');
    expect(sendFlow).toContain('patch: intent.patch');
    expect(sendFlow).toContain('coordinator.settleSuccess(intent, preferences)');
    expect(sendFlow).toContain('coordinator.settleFailure(intent)');
    expect(sendFlow).toContain('if (coordinator.isCurrent(intent))');
    expect(sendFlow).not.toContain('removeCommittedWorkspacePreferencePatch');
  });

  it('deduplicates retries and abandons a flush after its database epoch changes', () => {
    const flushFlow = sourceBetween(
      controllerSource,
      'const flushDirtyPreferences = useCallback(',
      'useEffect(() => {',
    );

    expect(flushFlow).toContain('preferenceRetryGateRef.current.run(async () =>');
    expect(flushFlow).toContain('const epoch = preferenceCoordinatorRef.current.epoch');
    expect(flushFlow.match(/if \(coordinator\.epoch !== epoch\) return true/gu)).toHaveLength(2);
    expect(flushFlow).toContain('coordinator.beginRetry(workspaceId)');
    expect(flushFlow).toContain("status === 'failed' && current");
    expect(flushFlow).toContain('coordinator.hasFailedPreferences');
  });

  it('stages deferred writes, generations immediate writes, and invalidates old load callbacks', () => {
    const updateFlow = sourceBetween(
      controllerSource,
      'const updatePreferences = useCallback(',
      'const saveStatus:',
    );
    const loadFlow = sourceBetween(
      controllerSource,
      'useEffect(() => {',
      'const loadArchiveManager = useCallback',
    );

    expect(updateFlow).toContain('coordinator.stage(workspaceId, patch)');
    expect(updateFlow).toContain('coordinator.beginWrite(workspaceId, patch)');
    expect(updateFlow).toContain('void sendPreferencePatch(intent)');
    expect(loadFlow).toContain('coordinator.invalidate()');
    expect(loadFlow).toContain('retryGate.invalidate()');
    expect(loadFlow).toContain('preferenceWrites.clear()');
    expect(loadFlow).toContain('pendingCounts.clear()');
  });

  it('preserves legacy migration and both workspace-mutation flush boundaries', () => {
    const loadFlow = sourceBetween(
      controllerSource,
      'useEffect(() => {',
      'const loadArchiveManager = useCallback',
    );
    const mutationFlow = sourceBetween(
      controllerSource,
      'const runMutation = useCallback(',
      'const create = useCallback(',
    );

    expect(loadFlow).toContain(
      'legacyImportWorkspaceIdRef.current = nextSnapshot.currentWorkspaceId',
    );
    expect(loadFlow).toContain('preferenceCoordinatorRef.current.beginWrite(');
    expect(loadFlow).toContain('const result = await sendPreferencePatch(intent)');
    expect(loadFlow).toContain('if (!active || !result.current) return');

    const mainMutation = mutationFlow.indexOf('const mutationSnapshot = await action()');
    expect(mutationFlow.indexOf('await flushDirtyPreferences()')).toBeLessThan(mainMutation);
    expect(mutationFlow).toContain('coordinator.discardMissingWorkspaces(activeWorkspaceIds)');
    expect(mutationFlow).toContain(
      'const targetPatch = coordinator.getDirtyPatch(mutationSnapshot.currentWorkspaceId)',
    );
    expect(mutationFlow).toContain('rebaseWorkspaceMutationSnapshot(');
    expect(mutationFlow.lastIndexOf('await flushDirtyPreferences()')).toBeGreaterThan(mainMutation);
  });

  it('invalidates the preference epoch only after data replacement is committed', () => {
    expect(controllerSource).toContain('invalidatePreferenceEpoch(): void;');
    expect(controllerSource).toContain('const invalidatePreferenceEpoch = useCallback((): void =>');
    expect(controllerSource).toContain('preferenceCoordinatorRef.current.invalidate();');
    expect(controllerSource).toContain('pendingPreferenceWriteCountsRef.current.clear();');
    expect(controllerSource).toContain('preferenceRetryGateRef.current.invalidate();');

    const restoreFlow = sourceBetween(
      appSource,
      'const restoreBackupWithApproval = useCallback(',
      'const restoreManualBackupSyncWarningFocus = useCallback',
    );
    expect(restoreFlow).toMatch(
      /if \(result\.status === 'cancelled'\)[\s\S]*?\} else \{\s+invalidateWorkspacePreferenceEpoch\(\);/u,
    );

    const closeFlow = sourceBetween(
      appSource,
      'window.workbench.window.onCloseRequest',
      'useEffect(() => {\n    const protectDraft',
    );
    expect(closeFlow).not.toContain('invalidateWorkspacePreferenceEpoch()');

    const importFlow = sourceBetween(appSource, 'onConfirm={async () => {', '<InboxUndoStack');
    expect(importFlow).toMatch(
      /await commitImport\(\);\s+invalidateWorkspacePreferenceEpoch\(\);/u,
    );
  });

  it('keeps a current failure visible above superseded pending writes', () => {
    const statusFlow = sourceBetween(
      controllerSource,
      'const saveStatus:',
      'return {\n    status,',
    );

    expect(statusFlow).toMatch(
      /const saveStatus: WorkspaceSaveStatus = saveError\s+\? 'error'\s+: pendingSaveCount > 0 \|\| dirtyPreferenceCount > 0/u,
    );
  });

  it('hands retry focus to stable status and restores it after another failure', () => {
    expect(sidebarSource).toContain('const storageStatusRef = useRef<HTMLDivElement>(null);');
    expect(sidebarSource).toContain('const retryButtonRef = useRef<HTMLButtonElement>(null);');
    expect(sidebarSource).toContain('const retryFocusActiveRef = useRef(false);');
    expect(sidebarSource).toContain("const target = saveStatus === 'error'");
    expect(sidebarSource).toContain('target?.focus({ preventScroll: true });');
    expect(sidebarSource).toContain('retryFocusOwnerRef.current = event.currentTarget;');
    expect(sidebarSource).toContain("aria-busy={saveStatus === 'saving'}");
    expect(sidebarSource).toContain('tabIndex={-1}');
  });
});

function sourceBetween(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  expect(startIndex, `missing source marker: ${start}`).toBeGreaterThanOrEqual(0);
  expect(endIndex, `missing source marker: ${end}`).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}
