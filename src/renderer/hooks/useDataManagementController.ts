import { useCallback, useEffect, useReducer, useRef } from 'react';
import type {
  BackupPolicyUpdateInput,
  DataImportPreview,
  DatabaseBackupRestoreInput,
  DatabaseBackupRestoreResult,
  WorkbenchApi,
} from '../../shared/contracts';
import {
  INITIAL_DATA_MANAGEMENT_STATE,
  DataImportLifecycle,
  dataManagementReducer,
  type DataManagementState,
  type DataOperationKind,
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
  load(): Promise<void>;
  createBackup(): Promise<void>;
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
      dispatch({ type: 'load-succeeded', generation, snapshot });
    } catch (error) {
      if (generation !== loadGenerationRef.current) return;
      dispatch({
        type: 'load-failed',
        generation,
        message: toDataError(error, '无法读取数据管理状态，请重试。').message,
      });
    }
  }, [databaseApi]);

  useEffect(() => {
    if (!databaseApi) return;
    return databaseApi.onBackupStateChange((snapshot) => {
      loadGenerationRef.current += 1;
      dispatch({ type: 'snapshot-observed', snapshot });
    });
  }, [databaseApi]);

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
    const operation = beginOperation('backup');
    if (!databaseApi) {
      throw failOperation(operation, null, '桌面数据桥接不可用，请重新启动应用。');
    }
    try {
      await databaseApi.createBackup();
      const snapshot = await databaseApi.getManagementSnapshot();
      loadGenerationRef.current += 1;
      if (!finishOperation(operation)) return;
      dispatch({
        type: 'operation-succeeded',
        generation: operation.generation,
        snapshot,
        message: '一致性备份已创建。',
      });
    } catch (error) {
      throw failOperation(operation, error, '备份创建失败；现有数据未被更改。');
    }
  }, [beginOperation, databaseApi, failOperation, finishOperation]);

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
        dispatch({
          type: 'operation-succeeded',
          generation: operation.generation,
          snapshot,
          message: '自动备份策略已保存。',
        });
      } catch (error) {
        throw failOperation(operation, error, '自动备份策略保存失败，请刷新后重试。');
      }
    },
    [beginOperation, databaseApi, failOperation, finishOperation],
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
    load,
    createBackup,
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
