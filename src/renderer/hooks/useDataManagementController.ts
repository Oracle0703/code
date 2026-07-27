import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type {
  BackupPolicyUpdateInput,
  DataImportPreview,
  DataManagementSnapshot,
  DatabaseBackupInfo,
  DatabaseBackupRestoreInput,
  DatabaseBackupRestoreResult,
  WorkbenchApi,
} from '../../shared/contracts';
import {
  INITIAL_DATA_MANAGEMENT_STATE,
  DataImportLifecycle,
  createManualBackupIdentity,
  createManualBackupSyncWarning,
  dataManagementReducer,
  exactManualBackupFromSnapshot,
  reconcileDataManagementSnapshot,
  reconcileManualBackupCreation,
  type DataManagementState,
  type DataOperationKind,
  type ManualBackupCreateIdentity,
  type ManualBackupSyncWarning,
} from '../data-state';

interface DataManagementControllerOptions {
  readonly databaseApi?: WorkbenchApi['database'] | null;
}

interface OperationToken {
  readonly kind: DataOperationKind;
  readonly generation: number;
}

export interface DataManagementController {
  readonly state: DataManagementState;
  readonly manualBackupSyncWarning: ManualBackupSyncWarning | null;
  readonly manualBackupBlocked: boolean;
  load(): Promise<void>;
  createBackup(): Promise<void>;
  refreshManualBackupSyncWarning(): Promise<void>;
  invalidateManualBackupRecovery(): void;
  restoreBackup(input: DatabaseBackupRestoreInput): Promise<DatabaseBackupRestoreResult>;
  updateBackupPolicy(input: BackupPolicyUpdateInput): Promise<void>;
  exportData(): Promise<void>;
  chooseImport(): Promise<void>;
  commitImport(): Promise<void>;
  cancelImport(): Promise<void>;
  currentImportPreview(): DataImportPreview | null;
  isImportCommitInFlight(): boolean;
}

export function useDataManagementController({
  databaseApi = window.workbench?.database ?? null,
}: DataManagementControllerOptions = {}): DataManagementController {
  const [state, dispatch] = useReducer(dataManagementReducer, INITIAL_DATA_MANAGEMENT_STATE);
  const loadGenerationRef = useRef(0);
  const operationGenerationRef = useRef(0);
  const activeOperationRef = useRef<OperationToken | null>(null);
  const importLifecycleRef = useRef(new DataImportLifecycle());
  const committedSnapshotRef = useRef<DataManagementSnapshot | null>(null);
  const protectedManualBackupsRef = useRef<readonly ManualBackupCreateIdentity[]>([]);
  const manualBackupReconciliationGenerationRef = useRef(0);
  const manualBackupRefreshTaskRef = useRef<Promise<void> | null>(null);
  const manualBackupSyncWarningRef = useRef<ManualBackupSyncWarning | null>(null);
  const [manualBackupSyncWarning, setManualBackupSyncWarning] =
    useState<ManualBackupSyncWarning | null>(null);

  const publishManualBackupSyncWarning = useCallback(
    (warning: ManualBackupSyncWarning | null): void => {
      manualBackupSyncWarningRef.current = warning;
      setManualBackupSyncWarning(warning);
    },
    [],
  );

  const protectManualBackup = useCallback((identity: ManualBackupCreateIdentity | null): void => {
    if (identity === null) return;
    protectedManualBackupsRef.current = Object.freeze([
      ...protectedManualBackupsRef.current.filter(({ id }) => id !== identity.id),
      identity,
    ]);
  }, []);

  const resolveManualBackupSyncWarning = useCallback(
    (snapshot: DataManagementSnapshot, publishFeedback = true): boolean => {
      const warning = manualBackupSyncWarningRef.current;
      if (
        !warning?.identity ||
        exactManualBackupFromSnapshot(warning.identity, snapshot) === null ||
        manualBackupSyncWarningRef.current !== warning
      ) {
        return false;
      }
      manualBackupSyncWarningRef.current = null;
      setManualBackupSyncWarning((current) => (current === warning ? null : current));
      if (publishFeedback && activeOperationRef.current?.kind !== 'backup-refresh') {
        dispatch({
          type: 'feedback-published',
          feedback: { tone: 'success', message: '已确认刚创建的备份。' },
        });
      }
      return true;
    },
    [],
  );

  const commitObservedSnapshot = useCallback(
    (
      snapshot: DataManagementSnapshot,
      requiredManualBackup: ManualBackupCreateIdentity | null = null,
    ): boolean => {
      const protectedManualBackups = protectedManualBackupsRef.current;
      const reconciled = reconcileDataManagementSnapshot(
        committedSnapshotRef.current,
        snapshot,
        protectedManualBackups,
      );
      committedSnapshotRef.current = reconciled;
      dispatch({
        type: 'snapshot-observed',
        snapshot,
        protectedManualBackups,
      });
      resolveManualBackupSyncWarning(reconciled);
      return (
        requiredManualBackup === null ||
        exactManualBackupFromSnapshot(requiredManualBackup, reconciled) !== null
      );
    },
    [resolveManualBackupSyncWarning],
  );

  const beginOperation = useCallback((kind: DataOperationKind): OperationToken => {
    if (activeOperationRef.current) {
      throw new Error('另一项数据操作正在进行，请稍候。');
    }
    const operation = { kind, generation: ++operationGenerationRef.current };
    activeOperationRef.current = operation;
    dispatch({ type: 'operation-started', operation });
    return operation;
  }, []);

  const finishOperation = useCallback((operation: OperationToken): boolean => {
    if (activeOperationRef.current?.generation !== operation.generation) return false;
    activeOperationRef.current = null;
    return true;
  }, []);

  const failOperation = useCallback(
    (
      operation: OperationToken,
      error: unknown,
      fallback: string,
      clearImportPreview = false,
    ): Error => {
      const failure = toDataError(error, fallback);
      if (finishOperation(operation)) {
        dispatch({
          type: 'operation-failed',
          generation: operation.generation,
          message: failure.message,
          clearImportPreview,
        });
      }
      return failure;
    },
    [finishOperation],
  );

  const load = useCallback(async (): Promise<void> => {
    if (activeOperationRef.current) return;
    const generation = ++loadGenerationRef.current;
    dispatch({ type: 'load-started', generation });
    if (!databaseApi) {
      dispatch({
        type: 'load-failed',
        generation,
        message: '桌面数据桥接不可用，请重新启动应用。',
      });
      return;
    }
    try {
      const snapshot = await databaseApi.getManagementSnapshot();
      if (generation !== loadGenerationRef.current) return;
      const protectedManualBackups = protectedManualBackupsRef.current;
      committedSnapshotRef.current = reconcileDataManagementSnapshot(
        committedSnapshotRef.current,
        snapshot,
        protectedManualBackups,
      );
      dispatch({ type: 'load-succeeded', generation, snapshot, protectedManualBackups });
      resolveManualBackupSyncWarning(committedSnapshotRef.current);
    } catch (error) {
      if (generation !== loadGenerationRef.current) return;
      dispatch({
        type: 'load-failed',
        generation,
        message: toDataError(error, '无法读取数据管理状态，请重试。').message,
      });
    }
  }, [databaseApi, resolveManualBackupSyncWarning]);

  useEffect(() => {
    if (!databaseApi) return;
    return databaseApi.onBackupStateChange((snapshot) => {
      loadGenerationRef.current += 1;
      commitObservedSnapshot(snapshot);
    });
  }, [commitObservedSnapshot, databaseApi]);

  useEffect(
    () => () => {
      const preview = importLifecycleRef.current.currentPreview();
      if (!databaseApi || !preview) return;
      void importLifecycleRef.current
        .cancel((target) => databaseApi.cancelImport({ importId: target.importId }))
        .catch(() => undefined);
    },
    [databaseApi],
  );

  const createBackup = useCallback(async (): Promise<void> => {
    if (manualBackupSyncWarningRef.current !== null) {
      throw new Error('上一份备份已经创建但列表尚未同步，请先重新读取，勿重复创建。');
    }
    const operation = beginOperation('backup');
    if (!databaseApi) {
      throw failOperation(operation, null, '桌面数据桥接不可用，请重新启动应用。');
    }
    let backup: Readonly<DatabaseBackupInfo>;
    try {
      backup = Object.freeze({ ...(await databaseApi.createBackup()) });
    } catch (error) {
      throw failOperation(operation, error, '备份创建失败；现有数据未被更改。');
    }

    const identity = createManualBackupIdentity(backup);
    protectManualBackup(identity);
    const reconciliationGeneration = ++manualBackupReconciliationGenerationRef.current;
    const isCurrent = (): boolean =>
      reconciliationGeneration === manualBackupReconciliationGenerationRef.current;
    let committed: boolean;
    try {
      const reconciliation = await reconcileManualBackupCreation({
        backup,
        getCommittedSnapshot: () => committedSnapshotRef.current,
        prepareSnapshotRefresh: async () => {
          const loadGeneration = ++loadGenerationRef.current;
          const snapshot = await databaseApi.getManagementSnapshot();
          return {
            snapshot,
            commit: () =>
              loadGeneration === loadGenerationRef.current &&
              isCurrent() &&
              commitObservedSnapshot(snapshot, identity),
          };
        },
        isCurrent,
      });
      committed = reconciliation.committed;
    } catch {
      committed = false;
    }

    const operationCurrent = finishOperation(operation);
    if (!isCurrent()) {
      if (operationCurrent) {
        dispatch({
          type: 'operation-succeeded',
          generation: operation.generation,
        });
      }
      return;
    }
    if (committed) {
      publishManualBackupSyncWarning(null);
      if (operationCurrent) {
        dispatch({
          type: 'operation-succeeded',
          generation: operation.generation,
          message: '一致性备份已创建。',
        });
      }
      return;
    }

    publishManualBackupSyncWarning(
      createManualBackupSyncWarning(
        backup,
        '备份已经创建，但当前列表未能确认这份精确备份。请重新读取；勿重复创建。',
      ),
    );
    if (operationCurrent) {
      dispatch({
        type: 'operation-succeeded',
        generation: operation.generation,
      });
    }
  }, [
    beginOperation,
    commitObservedSnapshot,
    databaseApi,
    failOperation,
    finishOperation,
    protectManualBackup,
    publishManualBackupSyncWarning,
  ]);

  const runManualBackupSyncRefresh = useCallback(async (): Promise<void> => {
    const warning = manualBackupSyncWarningRef.current;
    if (warning === null) return;
    let operation: OperationToken;
    try {
      operation = beginOperation('backup-refresh');
    } catch (error) {
      const refreshError = toDataError(
        error,
        '另一项数据操作正在进行，请稍候再重新读取备份。',
      ).message;
      if (manualBackupSyncWarningRef.current?.backup.id === warning.backup.id) {
        publishManualBackupSyncWarning({
          ...warning,
          refreshing: false,
          refreshError,
          focusActionOnMount: false,
        });
      }
      throw new Error(refreshError, { cause: error });
    }
    publishManualBackupSyncWarning({
      ...warning,
      refreshing: true,
      refreshError: null,
      focusActionOnMount: false,
    });
    const reconciliationGeneration = ++manualBackupReconciliationGenerationRef.current;
    const isCurrent = (): boolean =>
      reconciliationGeneration === manualBackupReconciliationGenerationRef.current;
    let committed = false;

    if (databaseApi) {
      try {
        const reconciliation = await reconcileManualBackupCreation({
          backup: warning.backup,
          getCommittedSnapshot: () => committedSnapshotRef.current,
          prepareSnapshotRefresh: async () => {
            const loadGeneration = ++loadGenerationRef.current;
            const snapshot = await databaseApi.getManagementSnapshot();
            return {
              snapshot,
              commit: () =>
                loadGeneration === loadGenerationRef.current &&
                isCurrent() &&
                commitObservedSnapshot(snapshot, warning.identity),
            };
          },
          isCurrent,
        });
        committed = reconciliation.committed;
      } catch {
        committed = false;
      }
    }

    const operationCurrent = finishOperation(operation);
    if (!isCurrent()) {
      if (operationCurrent) {
        dispatch({
          type: 'operation-succeeded',
          generation: operation.generation,
        });
      }
      return;
    }
    if (committed) {
      const warningStillCurrent =
        manualBackupSyncWarningRef.current?.backup.id === warning.backup.id;
      if (warningStillCurrent) publishManualBackupSyncWarning(null);
      if (operationCurrent) {
        dispatch({
          type: 'operation-succeeded',
          generation: operation.generation,
          message: '已确认刚创建的备份。',
        });
      }
      return;
    }

    const refreshError = databaseApi
      ? '重新读取后仍无法确认备份，请稍后重试；备份已经创建，请勿重复创建。'
      : '桌面数据桥接不可用；备份已经创建，请勿重复创建，重启应用后再确认。';
    if (isCurrent() && manualBackupSyncWarningRef.current?.backup.id === warning.backup.id) {
      publishManualBackupSyncWarning({
        ...warning,
        refreshing: false,
        refreshError,
        focusActionOnMount: false,
      });
    }
    if (operationCurrent) {
      dispatch({
        type: 'operation-succeeded',
        generation: operation.generation,
      });
    }
    throw new Error(refreshError);
  }, [
    beginOperation,
    commitObservedSnapshot,
    databaseApi,
    finishOperation,
    publishManualBackupSyncWarning,
  ]);

  const refreshManualBackupSyncWarning = useCallback((): Promise<void> => {
    const currentTask = manualBackupRefreshTaskRef.current;
    if (currentTask !== null) return currentTask;
    const task = runManualBackupSyncRefresh().finally(() => {
      if (manualBackupRefreshTaskRef.current === task) {
        manualBackupRefreshTaskRef.current = null;
      }
    });
    manualBackupRefreshTaskRef.current = task;
    return task;
  }, [runManualBackupSyncRefresh]);

  const invalidateManualBackupRecovery = useCallback((): void => {
    manualBackupReconciliationGenerationRef.current += 1;
    protectedManualBackupsRef.current = [];
    publishManualBackupSyncWarning(null);
  }, [publishManualBackupSyncWarning]);

  const restoreBackup = useCallback(
    async (input: DatabaseBackupRestoreInput): Promise<DatabaseBackupRestoreResult> => {
      const operation = beginOperation('restore-backup');
      if (!databaseApi) {
        throw failOperation(operation, null, '桌面数据桥接不可用，请重新启动应用。');
      }
      const lockedInput = Object.freeze({ ...input });
      try {
        const result = await databaseApi.restoreBackup(lockedInput);
        if (!finishOperation(operation)) return result;
        dispatch({
          type: 'operation-succeeded',
          generation: operation.generation,
          message:
            result.status === 'restarting'
              ? '备份恢复已安全提交，应用正在重启。'
              : '已取消备份恢复；当前数据未被更改。',
        });
        return result;
      } catch (error) {
        throw failOperation(
          operation,
          error,
          '备份恢复失败；当前数据库、目标备份与安全副本均已保留。',
        );
      }
    },
    [beginOperation, databaseApi, failOperation, finishOperation],
  );

  const updateBackupPolicy = useCallback(
    async (input: BackupPolicyUpdateInput): Promise<void> => {
      const operation = beginOperation('update-policy');
      if (!databaseApi) {
        throw failOperation(operation, null, '桌面数据桥接不可用，请重新启动应用。');
      }
      try {
        const snapshot = await databaseApi.updateBackupPolicy(input);
        loadGenerationRef.current += 1;
        if (!finishOperation(operation)) return;
        const protectedManualBackups = protectedManualBackupsRef.current;
        committedSnapshotRef.current = reconcileDataManagementSnapshot(
          committedSnapshotRef.current,
          snapshot,
          protectedManualBackups,
        );
        resolveManualBackupSyncWarning(committedSnapshotRef.current, false);
        dispatch({
          type: 'operation-succeeded',
          generation: operation.generation,
          snapshot,
          protectedManualBackups,
          message: '自动备份策略已保存。',
        });
      } catch (error) {
        throw failOperation(operation, error, '自动备份策略保存失败，请刷新后重试。');
      }
    },
    [beginOperation, databaseApi, failOperation, finishOperation, resolveManualBackupSyncWarning],
  );

  const exportData = useCallback(async (): Promise<void> => {
    const operation = beginOperation('export');
    if (!databaseApi) {
      throw failOperation(operation, null, '桌面数据桥接不可用，请重新启动应用。');
    }
    try {
      const result = await databaseApi.exportData();
      if (!finishOperation(operation)) return;
      dispatch({
        type: 'operation-succeeded',
        generation: operation.generation,
        message:
          result.status === 'exported'
            ? `数据已导出${result.fileName ? `为 ${result.fileName}` : ''}。`
            : '已取消导出。',
      });
    } catch (error) {
      throw failOperation(operation, error, '数据导出失败；现有数据未被更改。');
    }
  }, [beginOperation, databaseApi, failOperation, finishOperation]);

  const chooseImport = useCallback(async (): Promise<void> => {
    const operation = beginOperation('choose-import');
    if (!databaseApi) {
      throw failOperation(operation, null, '桌面数据桥接不可用，请重新启动应用。');
    }
    try {
      const selection = await databaseApi.chooseImport();
      if (!finishOperation(operation)) return;
      const preview = selection.status === 'ready' ? selection.preview : null;
      importLifecycleRef.current.setPreview(preview);
      dispatch({
        type: 'operation-succeeded',
        generation: operation.generation,
        importPreview: preview,
        message: selection.status === 'cancelled' ? '已取消选择导入文件。' : undefined,
      });
    } catch (error) {
      throw failOperation(operation, error, '导入文件验证失败；本地数据未被更改。');
    }
  }, [beginOperation, databaseApi, failOperation, finishOperation]);

  const commitImport = useCallback(async (): Promise<void> => {
    const operation = beginOperation('commit-import');
    let preview: DataImportPreview;
    try {
      preview = importLifecycleRef.current.beginCommit();
    } catch (error) {
      throw failOperation(operation, error, '导入预览已经失效，请重新选择文件。');
    }
    if (!databaseApi) {
      importLifecycleRef.current.failCommit(preview.importId);
      throw failOperation(operation, null, '桌面数据桥接不可用，请重新启动应用。', true);
    }
    try {
      await databaseApi.commitImport({
        importId: preview.importId,
        previewDigest: preview.previewDigest,
      });
      if (!finishOperation(operation)) return;
      importLifecycleRef.current.finishCommit(preview.importId);
      dispatch({
        type: 'operation-succeeded',
        generation: operation.generation,
        importPreview: null,
        message: '数据已安全替换，应用正在重启。',
      });
    } catch (error) {
      importLifecycleRef.current.failCommit(preview.importId);
      throw failOperation(operation, error, '数据替换失败；已保留原数据库。', true);
    }
  }, [beginOperation, databaseApi, failOperation, finishOperation]);

  const cancelImport = useCallback(async (): Promise<void> => {
    return importLifecycleRef.current.cancel(async (preview) => {
      const operation = beginOperation('cancel-import');
      try {
        if (!databaseApi) throw new Error('桌面数据桥接不可用，请重新启动应用。');
        await databaseApi.cancelImport({ importId: preview.importId });
        if (!finishOperation(operation)) return;
        dispatch({
          type: 'operation-succeeded',
          generation: operation.generation,
          importPreview: null,
        });
      } catch (error) {
        throw failOperation(operation, error, '无法关闭导入预览，请重试。');
      }
    });
  }, [beginOperation, databaseApi, failOperation, finishOperation]);

  const currentImportPreview = useCallback(() => importLifecycleRef.current.currentPreview(), []);
  const isImportCommitInFlight = useCallback(
    () => importLifecycleRef.current.isCommitInFlight(),
    [],
  );

  return {
    state,
    manualBackupSyncWarning,
    manualBackupBlocked: manualBackupSyncWarning !== null,
    load,
    createBackup,
    refreshManualBackupSyncWarning,
    invalidateManualBackupRecovery,
    restoreBackup,
    updateBackupPolicy,
    exportData,
    chooseImport,
    commitImport,
    cancelImport,
    currentImportPreview,
    isImportCommitInFlight,
  };
}

function toDataError(error: unknown, fallback: string): Error {
  if (!(error instanceof Error) || !error.message.trim()) return new Error(fallback);
  const message = error.message.replace(/^Error invoking remote method '[^']+':\s*/u, '').trim();
  return new Error(message || fallback, { cause: error });
}
