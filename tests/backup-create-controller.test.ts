import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const controllerSource = readFileSync(
  new URL('../src/renderer/hooks/useDataManagementController.ts', import.meta.url),
  'utf8',
);
const appSource = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');

describe('manual backup creation controller contract', () => {
  it('separates the retryable Main mutation from fail-closed post-commit reconciliation', () => {
    const createFlow = sourceBetween(
      controllerSource,
      'const createBackup = useCallback',
      'const runManualBackupSyncRefresh',
    );
    const mainMutationEnd = createFlow.indexOf('const identity = createManualBackupIdentity');
    const mainMutation = createFlow.slice(0, mainMutationEnd);
    const postCommit = createFlow.slice(mainMutationEnd);

    expect(mainMutation).toContain('await databaseApi.createBackup()');
    expect(mainMutation).toContain(
      "throw failOperation(operation, error, '备份创建失败；现有数据未被更改。')",
    );
    expect(postCommit).toContain('reconcileManualBackupCreation');
    expect(postCommit).toContain('createManualBackupSyncWarning');
    expect(postCommit).toContain('勿重复创建');
    expect(postCommit).not.toContain('failOperation(');
    expect(postCommit).not.toContain('throw error');
  });

  it('keeps exact identity, committed snapshots, bounded refreshes, and late events coordinated', () => {
    expect(controllerSource).toContain(
      'const committedSnapshotRef = useRef<DataManagementSnapshot | null>(null)',
    );
    expect(controllerSource).toContain(
      'const protectedManualBackupsRef = useRef<readonly ManualBackupCreateIdentity[]>([])',
    );
    expect(controllerSource).toContain('commitObservedSnapshot(snapshot, identity)');
    expect(controllerSource).toContain('resolveManualBackupSyncWarning(reconciled)');
    expect(controllerSource).toContain("activeOperationRef.current?.kind !== 'backup-refresh'");
    expect(controllerSource).toContain('manualBackupReconciliationGenerationRef.current += 1');
    expect(controllerSource).toContain('protectedManualBackupsRef.current = []');
    const policyFlow = sourceBetween(
      controllerSource,
      'const updateBackupPolicy',
      'const exportData',
    );
    expect(policyFlow).toContain(
      'resolveManualBackupSyncWarning(committedSnapshotRef.current, false)',
    );
  });

  it('defends both creation and warning recovery with controller-owned single-flight gates', () => {
    const createFlow = sourceBetween(
      controllerSource,
      'const createBackup = useCallback',
      'const runManualBackupSyncRefresh',
    );
    const refreshFlow = sourceBetween(
      controllerSource,
      'const runManualBackupSyncRefresh',
      'const invalidateManualBackupRecovery',
    );

    expect(createFlow.indexOf('manualBackupSyncWarningRef.current !== null')).toBeLessThan(
      createFlow.indexOf("beginOperation('backup')"),
    );
    expect(refreshFlow).toContain('manualBackupRefreshTaskRef.current');
    expect(refreshFlow).toContain("beginOperation('backup-refresh')");
    expect(refreshFlow).toContain('if (currentTask !== null) return currentTask');
    expect(refreshFlow).toContain('refreshError');
    expect(refreshFlow).toContain('另一项数据操作正在进行，请稍候再重新读取备份');
    expect(refreshFlow).not.toContain('operation-failed');
  });
});

describe('manual backup creation App contract', () => {
  it('blocks both manual entry points while leaving other data actions available', () => {
    const commands = sourceBetween(
      appSource,
      'const commands = useMemo',
      'const beginBrowserResize',
    );
    const backupCommand = sourceBetween(commands, "id: 'data:backup'", "id: 'data:export'");
    const exportCommand = sourceBetween(commands, "id: 'data:export'", "id: 'data:import'");

    expect(commands).toContain('const manualBackupDisabled = dataDisabled || manualBackupBlocked');
    expect(backupCommand).toContain('disabled: manualBackupDisabled');
    expect(backupCommand).toContain('action: createBackup');
    expect(exportCommand).toContain('disabled: dataDisabled');
    expect(appSource).toContain('manualBackupBlocked={manualBackupBlocked}');
  });

  it('renders one App-level recovery surface outside Settings', () => {
    const warningSurface = sourceBetween(
      appSource,
      '<InboxUndoStack',
      '{visibleAutomationCreateSyncWarning ?',
    );

    expect(warningSurface).toContain('manualBackupSyncWarning ?');
    expect(warningSurface).toContain('<BackupCreateSyncWarning');
    expect(warningSurface).toContain('focusBlocked={overlayOpen}');
    expect(warningSurface).toContain('blocked={dataState.activeOperation !== null}');
    expect(warningSurface).toContain('onRefresh={refreshManualBackupSyncWarning}');
    expect(warningSurface).toContain('onFocusFallback={restoreManualBackupSyncWarningFocus}');
  });

  it('invalidates only after a replacement commits, never on cancellation, failure, or close approval', () => {
    const restoreFlow = sourceBetween(
      appSource,
      'const restoreBackupWithApproval',
      'const restoreManualBackupSyncWarningFocus',
    );
    const importFlow = sourceBetween(appSource, 'dataState.importPreview ?', '<InboxUndoStack');
    const closeFlow = sourceBetween(
      appSource,
      'window.workbench.window.onCloseRequest',
      'const protectDraft',
    );

    expect(restoreFlow).toContain("if (result.status === 'cancelled')");
    expect(restoreFlow).toMatch(
      /else \{\s*invalidateNoteMutations\(\);\s*invalidateScheduleMutations\(\);\s*invalidateManualBackupRecovery\(\);\s*\}/u,
    );
    expect(importFlow).toMatch(
      /await commitImport\(\);\s*invalidateNoteMutations\(\);\s*invalidateScheduleMutations\(\);\s*invalidateManualBackupRecovery\(\);/u,
    );
    expect(closeFlow).not.toContain('invalidateManualBackupRecovery');
  });
});

function sourceBetween(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  expect(startIndex, `missing source marker: ${start}`).toBeGreaterThanOrEqual(0);
  expect(endIndex, `missing source marker: ${end}`).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}
