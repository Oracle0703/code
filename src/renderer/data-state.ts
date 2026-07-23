import type {
  DataImportPreview,
  DataManagementSnapshot,
  DatabaseBackupInfo,
} from '../shared/contracts';

export type DataLoadStatus = 'idle' | 'loading' | 'ready' | 'error';

export type DataOperationKind =
  'backup' | 'update-policy' | 'export' | 'choose-import' | 'commit-import' | 'cancel-import';

export interface ActiveDataOperation {
  readonly kind: DataOperationKind;
  readonly generation: number;
}

export interface DataFeedback {
  readonly tone: 'success' | 'error';
  readonly message: string;
}

export interface DataManagementState {
  readonly snapshot: DataManagementSnapshot | null;
  readonly loadStatus: DataLoadStatus;
  readonly loadGeneration: number;
  readonly activeOperation: ActiveDataOperation | null;
  readonly importPreview: DataImportPreview | null;
  readonly feedback: DataFeedback | null;
}

export type DataManagementAction =
  | { readonly type: 'load-started'; readonly generation: number }
  | {
      readonly type: 'load-succeeded';
      readonly generation: number;
      readonly snapshot: DataManagementSnapshot;
    }
  | { readonly type: 'load-failed'; readonly generation: number; readonly message: string }
  | { readonly type: 'snapshot-observed'; readonly snapshot: DataManagementSnapshot }
  | {
      readonly type: 'operation-started';
      readonly operation: ActiveDataOperation;
    }
  | {
      readonly type: 'operation-succeeded';
      readonly generation: number;
      readonly snapshot?: DataManagementSnapshot;
      readonly message?: string;
      readonly importPreview?: DataImportPreview | null;
    }
  | {
      readonly type: 'operation-failed';
      readonly generation: number;
      readonly message: string;
      readonly clearImportPreview?: boolean;
    }
  | { readonly type: 'import-preview-cleared' }
  | { readonly type: 'feedback-cleared' };

export const INITIAL_DATA_MANAGEMENT_STATE: DataManagementState = Object.freeze({
  snapshot: null,
  loadStatus: 'idle',
  loadGeneration: 0,
  activeOperation: null,
  importPreview: null,
  feedback: null,
});

export function dataManagementReducer(
  state: DataManagementState,
  action: DataManagementAction,
): DataManagementState {
  switch (action.type) {
    case 'load-started':
      if (action.generation < state.loadGeneration) return state;
      return {
        ...state,
        loadStatus: 'loading',
        loadGeneration: action.generation,
        feedback: null,
      };
    case 'load-succeeded':
      if (action.generation !== state.loadGeneration) return state;
      return {
        ...state,
        snapshot: reconcileDataManagementSnapshot(state.snapshot, action.snapshot),
        loadStatus: 'ready',
        feedback: null,
      };
    case 'load-failed':
      if (action.generation !== state.loadGeneration) return state;
      return {
        ...state,
        loadStatus: 'error',
        feedback: { tone: 'error', message: action.message },
      };
    case 'snapshot-observed':
      return {
        ...state,
        snapshot: reconcileDataManagementSnapshot(state.snapshot, action.snapshot),
        loadStatus: 'ready',
      };
    case 'operation-started':
      if (state.activeOperation) return state;
      return {
        ...state,
        activeOperation: action.operation,
        feedback: null,
      };
    case 'operation-succeeded':
      if (state.activeOperation?.generation !== action.generation) return state;
      return {
        ...state,
        snapshot: action.snapshot
          ? reconcileDataManagementSnapshot(state.snapshot, action.snapshot)
          : state.snapshot,
        loadStatus: action.snapshot ? 'ready' : state.loadStatus,
        activeOperation: null,
        importPreview:
          action.importPreview === undefined ? state.importPreview : action.importPreview,
        feedback: action.message ? { tone: 'success', message: action.message } : null,
      };
    case 'operation-failed':
      if (state.activeOperation?.generation !== action.generation) return state;
      return {
        ...state,
        activeOperation: null,
        importPreview: action.clearImportPreview ? null : state.importPreview,
        feedback: { tone: 'error', message: action.message },
      };
    case 'import-preview-cleared':
      return { ...state, importPreview: null };
    case 'feedback-cleared':
      return { ...state, feedback: null };
  }
}

export function canStartDataOperation(state: DataManagementState): boolean {
  return state.activeOperation === null;
}

export function reconcileDataManagementSnapshot(
  current: DataManagementSnapshot | null,
  incoming: DataManagementSnapshot,
): DataManagementSnapshot {
  if (current && incoming.schedule.policy.revision < current.schedule.policy.revision) {
    return current;
  }
  return incoming;
}

export function latestDatabaseBackup(
  backups: readonly DatabaseBackupInfo[],
): DatabaseBackupInfo | null {
  let latest: DatabaseBackupInfo | null = null;
  for (const backup of backups) {
    if (!latest || Date.parse(backup.createdAt) > Date.parse(latest.createdAt)) latest = backup;
  }
  return latest;
}

export function dataOperationLabel(operation: DataOperationKind | null): string | null {
  switch (operation) {
    case 'backup':
      return '正在创建一致性备份…';
    case 'update-policy':
      return '正在保存自动备份设置…';
    case 'export':
      return '正在导出本地数据…';
    case 'choose-import':
      return '正在验证导入文件…';
    case 'commit-import':
      return '正在替换本地数据并准备重启…';
    case 'cancel-import':
      return '正在取消导入…';
    case null:
      return null;
  }
}

export class DataImportLifecycle {
  #preview: DataImportPreview | null = null;
  readonly #protectedImportIds = new Set<string>();
  readonly #cancelledImportIds = new Set<string>();
  readonly #cancellationTasks = new Map<string, Promise<void>>();

  setPreview(preview: DataImportPreview | null): void {
    this.#preview = preview;
  }

  currentPreview(): DataImportPreview | null {
    return this.#preview;
  }

  beginCommit(): DataImportPreview {
    const preview = this.#preview;
    if (!preview) throw new Error('导入预览已经失效，请重新选择文件。');
    this.#protectedImportIds.add(preview.importId);
    return preview;
  }

  failCommit(importId: string): void {
    this.#protectedImportIds.delete(importId);
    if (this.#preview?.importId === importId) this.#preview = null;
  }

  finishCommit(importId: string): void {
    this.#protectedImportIds.add(importId);
    if (this.#preview?.importId === importId) this.#preview = null;
  }

  isCommitInFlight(): boolean {
    const preview = this.#preview;
    return Boolean(preview && this.#protectedImportIds.has(preview.importId));
  }

  cancel(action: (preview: DataImportPreview) => Promise<void>): Promise<void> {
    const preview = this.#preview;
    if (!preview) return Promise.resolve();
    if (this.#protectedImportIds.has(preview.importId)) {
      return Promise.reject(new Error('数据替换已经开始，不能再取消导入。'));
    }
    const existingTask = this.#cancellationTasks.get(preview.importId);
    if (existingTask) return existingTask;
    if (this.#cancelledImportIds.has(preview.importId)) {
      this.#preview = null;
      return Promise.resolve();
    }

    this.#cancelledImportIds.add(preview.importId);
    let actionTask: Promise<void>;
    try {
      actionTask = action(preview);
    } catch (error) {
      this.#cancelledImportIds.delete(preview.importId);
      return Promise.reject(error);
    }
    const task = actionTask
      .then(() => {
        if (this.#preview?.importId === preview.importId) this.#preview = null;
      })
      .catch((error: unknown) => {
        this.#cancelledImportIds.delete(preview.importId);
        throw error;
      })
      .finally(() => {
        this.#cancellationTasks.delete(preview.importId);
      });
    this.#cancellationTasks.set(preview.importId, task);
    return task;
  }
}
