import { describe, expect, it } from 'vitest';
import {
  INITIAL_DATA_MANAGEMENT_STATE,
  DataImportLifecycle,
  canStartDataOperation,
  dataManagementReducer,
  dataOperationLabel,
  latestDatabaseBackup,
  reconcileDataManagementSnapshot,
} from '../src/renderer/data-state';
import type {
  DataImportPreview,
  DataManagementSnapshot,
  DatabaseBackupInfo,
} from '../src/shared/contracts';

describe('data management renderer state', () => {
  it('drops stale load completions and accepts only the current generation', () => {
    const loading = dataManagementReducer(INITIAL_DATA_MANAGEMENT_STATE, {
      type: 'load-started',
      generation: 2,
    });
    const stale = dataManagementReducer(loading, {
      type: 'load-succeeded',
      generation: 1,
      snapshot: managementSnapshot(1),
    });
    const current = dataManagementReducer(stale, {
      type: 'load-succeeded',
      generation: 2,
      snapshot: managementSnapshot(2),
    });

    expect(stale).toBe(loading);
    expect(current.loadStatus).toBe('ready');
    expect(current.snapshot?.database.backupCount).toBe(2);
  });

  it('keeps an active operation while applying scheduler observations', () => {
    const active = dataManagementReducer(INITIAL_DATA_MANAGEMENT_STATE, {
      type: 'operation-started',
      operation: { kind: 'backup', generation: 7 },
    });
    const observed = dataManagementReducer(active, {
      type: 'snapshot-observed',
      snapshot: managementSnapshot(3),
    });

    expect(observed.activeOperation).toEqual({ kind: 'backup', generation: 7 });
    expect(observed.snapshot?.database.backupCount).toBe(3);
    expect(canStartDataOperation(observed)).toBe(false);
  });

  it('serializes data mutations and ignores stale operation completion', () => {
    const active = dataManagementReducer(INITIAL_DATA_MANAGEMENT_STATE, {
      type: 'operation-started',
      operation: { kind: 'export', generation: 4 },
    });
    const overlapping = dataManagementReducer(active, {
      type: 'operation-started',
      operation: { kind: 'backup', generation: 5 },
    });
    const stale = dataManagementReducer(overlapping, {
      type: 'operation-succeeded',
      generation: 3,
      message: '旧导出完成',
    });
    const completed = dataManagementReducer(stale, {
      type: 'operation-succeeded',
      generation: 4,
      message: '导出完成',
    });

    expect(overlapping).toBe(active);
    expect(stale).toBe(active);
    expect(completed.activeOperation).toBeNull();
    expect(completed.feedback).toEqual({ tone: 'success', message: '导出完成' });
    expect(canStartDataOperation(completed)).toBe(true);
  });

  it('publishes an import preview only for the matching operation', () => {
    const active = dataManagementReducer(INITIAL_DATA_MANAGEMENT_STATE, {
      type: 'operation-started',
      operation: { kind: 'choose-import', generation: 10 },
    });
    const preview = importPreview();
    const selected = dataManagementReducer(active, {
      type: 'operation-succeeded',
      generation: 10,
      importPreview: preview,
    });
    const cleared = dataManagementReducer(selected, { type: 'import-preview-cleared' });

    expect(selected.importPreview).toBe(preview);
    expect(cleared.importPreview).toBeNull();
  });

  it('preserves the last good snapshot when an operation fails', () => {
    const ready = dataManagementReducer(
      {
        ...INITIAL_DATA_MANAGEMENT_STATE,
        snapshot: managementSnapshot(1),
        loadStatus: 'ready',
      },
      {
        type: 'operation-started',
        operation: { kind: 'update-policy', generation: 8 },
      },
    );
    const failed = dataManagementReducer(ready, {
      type: 'operation-failed',
      generation: 8,
      message: '策略已经被其他窗口更新',
    });

    expect(failed.snapshot).toBe(ready.snapshot);
    expect(failed.feedback).toEqual({
      tone: 'error',
      message: '策略已经被其他窗口更新',
    });
  });

  it('clears a consumed import preview when commit fails', () => {
    const preview = importPreview();
    const active = dataManagementReducer(
      { ...INITIAL_DATA_MANAGEMENT_STATE, importPreview: preview },
      {
        type: 'operation-started',
        operation: { kind: 'commit-import', generation: 9 },
      },
    );
    const failed = dataManagementReducer(active, {
      type: 'operation-failed',
      generation: 9,
      message: '用户取消了替换',
      clearImportPreview: true,
    });

    expect(failed.importPreview).toBeNull();
    expect(failed.feedback?.message).toBe('用户取消了替换');
  });

  it('finds the newest backup without depending on incoming order', () => {
    const old = backup('old', '2026-07-20T10:00:00.000Z');
    const latest = backup('latest', '2026-07-23T10:00:00.000Z');
    expect(latestDatabaseBackup([old, latest])?.id).toBe('latest');
    expect(latestDatabaseBackup([latest, old])?.id).toBe('latest');
    expect(latestDatabaseBackup([])).toBeNull();
  });

  it('provides bounded, user-facing operation labels', () => {
    expect(dataOperationLabel('backup')).toBe('正在创建一致性备份…');
    expect(dataOperationLabel('commit-import')).toContain('准备重启');
    expect(dataOperationLabel(null)).toBeNull();
  });

  it('does not let an older backup event replace a newer policy revision', () => {
    const current = managementSnapshot(4, 8);
    const stale = managementSnapshot(99, 7);

    expect(reconcileDataManagementSnapshot(current, stale)).toBe(current);
    expect(reconcileDataManagementSnapshot(current, managementSnapshot(5, 9))).not.toBe(current);
  });

  it('deduplicates import cancellation and never cancels after commit starts', async () => {
    const lifecycle = new DataImportLifecycle();
    lifecycle.setPreview(importPreview());
    let releaseCancel!: () => void;
    const deferred = new Promise<void>((resolve) => {
      releaseCancel = resolve;
    });
    let cancelCalls = 0;
    const cancel = () => {
      cancelCalls += 1;
      return deferred;
    };

    const first = lifecycle.cancel(cancel);
    const duplicate = lifecycle.cancel(cancel);
    expect(duplicate).toBe(first);
    expect(cancelCalls).toBe(1);
    releaseCancel();
    await Promise.all([first, duplicate]);
    expect(lifecycle.currentPreview()).toBeNull();

    lifecycle.setPreview(importPreview());
    const committing = lifecycle.beginCommit();
    await expect(lifecycle.cancel(cancel)).rejects.toThrow('不能再取消导入');
    expect(cancelCalls).toBe(1);
    lifecycle.failCommit(committing.importId);
    expect(lifecycle.currentPreview()).toBeNull();
  });
});

function managementSnapshot(backupCount: number, policyRevision = 1): DataManagementSnapshot {
  return {
    database: {
      schemaVersion: 7,
      appliedMigrations: 7,
      sqliteVersion: '3.53.1',
      journalMode: 'wal',
      integrityCheck: 'ok',
      backupCount,
    },
    backups: [],
    schedule: {
      policy: {
        enabled: true,
        cadence: 'daily',
        localTimeMinute: 120,
        weekday: null,
        retentionCount: 7,
        revision: policyRevision,
        updatedAt: '2026-07-23T10:00:00.000Z',
      },
      lastAttemptAt: null,
      lastSuccessAt: null,
      lastErrorCode: null,
      consecutiveFailures: 0,
      nextRunAt: '2026-07-24T02:00:00.000Z',
      running: false,
    },
  };
}

function backup(id: string, createdAt: string): DatabaseBackupInfo {
  return {
    id,
    fileName: `${id}.sqlite3`,
    createdAt,
    sizeBytes: 1_024,
    reason: 'manual',
    schemaVersion: 7,
  };
}

function importPreview(): DataImportPreview {
  return {
    importId: '33333333-3333-4333-8333-333333333333',
    previewDigest: 'a'.repeat(64),
    expiresAt: '2026-07-23T11:00:00.000Z',
    exportedAt: '2026-07-23T09:00:00.000Z',
    sourceAppVersion: '0.1.0',
    sourceSchemaVersion: 7,
    currentWorkspaceName: '开发',
    counts: {
      workspaces: 2,
      archivedWorkspaces: 1,
      inboxEntries: 3,
      tasks: 4,
      notes: 5,
      scheduleItems: 6,
      browserTabs: 7,
      browserBookmarks: 8,
      automations: 9,
      enabledAutomations: 2,
    },
    includesArchivedData: true,
    includesBrowserData: true,
  };
}
