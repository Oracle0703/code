import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  WorkspaceColor,
  WorkspacePreferencesPatch,
  WorkspaceSnapshot,
} from '../../shared/contracts';
import {
  LEGACY_WORKSPACE_STORAGE_KEYS,
  isLegacyWorkspaceImportCommitted,
  mergeWorkspacePreferencePatches,
  readLegacyWorkspacePreferences,
  rebaseWorkspaceMutationSnapshot,
  removeCommittedWorkspacePreferencePatch,
} from '../../shared/workspace-preference-state';

type WorkspaceOperation = 'create' | 'rename' | 'activate' | 'archive' | null;
export type WorkspaceSaveStatus = 'saved' | 'saving' | 'error';

export interface WorkspaceController {
  readonly status: 'loading' | 'ready' | 'error';
  readonly snapshot: WorkspaceSnapshot | null;
  readonly loadError: string | null;
  readonly operationError: string | null;
  readonly saveError: string | null;
  readonly saveStatus: WorkspaceSaveStatus;
  readonly pendingOperation: WorkspaceOperation;
  readonly pendingWorkspaceId: string | null;
  readonly canRetry: boolean;
  retry(): void;
  retryPreferences(): void;
  create(name: string, color: WorkspaceColor): Promise<void>;
  rename(workspaceId: string, name: string): Promise<void>;
  activate(workspaceId: string): Promise<void>;
  archive(workspaceId: string): Promise<void>;
  updatePreferences(
    patch: WorkspacePreferencesPatch,
    persist?: boolean,
    workspaceId?: string,
  ): void;
}

export function useWorkspaceController(): WorkspaceController {
  const workspaceApi = window.workbench?.workspace;
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>(
    workspaceApi ? 'loading' : 'error',
  );
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot | null>(null);
  const [loadError, setLoadError] = useState<string | null>(
    workspaceApi ? null : '桌面工作区桥接不可用，请重新启动应用。',
  );
  const [operationError, setOperationError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [pendingSaveCount, setPendingSaveCount] = useState(0);
  const [dirtyPreferenceCount, setDirtyPreferenceCount] = useState(0);
  const [pendingOperation, setPendingOperation] = useState<WorkspaceOperation>(null);
  const [pendingWorkspaceId, setPendingWorkspaceId] = useState<string | null>(null);
  const [loadGeneration, setLoadGeneration] = useState(0);
  const snapshotRef = useRef<WorkspaceSnapshot | null>(null);
  const mutationInFlightRef = useRef(false);
  const lastPaintThemeRef = useRef<string | null>(null);
  const preferenceRevisionRef = useRef(0);
  const preferenceWritesRef = useRef(new Set<Promise<boolean>>());
  const dirtyPreferencesRef = useRef(new Map<string, WorkspacePreferencesPatch>());
  const retryPreferencesRef = useRef<Promise<boolean> | null>(null);
  const deferPreferenceWritesRef = useRef(false);
  const legacyImportWorkspaceIdRef = useRef<string | null>(null);

  const applySnapshot = useCallback((nextSnapshot: WorkspaceSnapshot) => {
    snapshotRef.current = nextSnapshot;
    setSnapshot(nextSnapshot);
    setStatus('ready');
    setLoadError(null);
    if (lastPaintThemeRef.current !== nextSnapshot.preferences.theme) {
      lastPaintThemeRef.current = nextSnapshot.preferences.theme;
      try {
        window.localStorage.setItem(
          'daily.paint.theme',
          JSON.stringify(nextSnapshot.preferences.theme),
        );
      } catch {
        // This cache is only a first-paint hint; SQLite remains authoritative.
      }
    }
  }, []);

  const sendPreferencePatch = useCallback(
    (workspaceId: string, patch: WorkspacePreferencesPatch): Promise<boolean> => {
      if (!workspaceApi) {
        setSaveError('工作区设置尚未保存；桌面桥接不可用。');
        return Promise.resolve(false);
      }

      setPendingSaveCount((count) => count + 1);
      const task = (async () => {
        try {
          await workspaceApi.updatePreferences({ workspaceId, patch });
          const dirty = dirtyPreferencesRef.current.get(workspaceId) ?? {};
          const remaining = removeCommittedWorkspacePreferencePatch(dirty, patch);
          if (Object.keys(remaining).length === 0) {
            dirtyPreferencesRef.current.delete(workspaceId);
          } else {
            dirtyPreferencesRef.current.set(workspaceId, remaining);
          }
          if (
            isLegacyWorkspaceImportCommitted(
              legacyImportWorkspaceIdRef.current,
              workspaceId,
              remaining,
            )
          ) {
            clearLegacyWorkspaceStorage();
            legacyImportWorkspaceIdRef.current = null;
          }
          setDirtyPreferenceCount(dirtyPreferencesRef.current.size);
          if (dirtyPreferencesRef.current.size === 0) setSaveError(null);
          return true;
        } catch {
          setSaveError('工作区设置尚未保存，请重试。');
          return false;
        } finally {
          setPendingSaveCount((count) => Math.max(0, count - 1));
        }
      })();
      preferenceWritesRef.current.add(task);
      void task.then(() => preferenceWritesRef.current.delete(task));
      return task;
    },
    [workspaceApi],
  );

  const flushDirtyPreferences = useCallback(async (): Promise<boolean> => {
    if (retryPreferencesRef.current) return retryPreferencesRef.current;

    const retry = (async () => {
      while (true) {
        while (preferenceWritesRef.current.size > 0) {
          await Promise.all([...preferenceWritesRef.current]);
        }
        const dirty = [...dirtyPreferencesRef.current.entries()];
        if (dirty.length === 0) return true;
        if (!workspaceApi) {
          setSaveError('工作区设置尚未保存；桌面桥接不可用。');
          return false;
        }
        const results = await Promise.all(
          dirty.map(([workspaceId, patch]) => sendPreferencePatch(workspaceId, patch)),
        );
        if (results.some((succeeded) => !succeeded)) return false;
      }
    })();
    retryPreferencesRef.current = retry;
    try {
      return await retry;
    } finally {
      if (retryPreferencesRef.current === retry) retryPreferencesRef.current = null;
    }
  }, [sendPreferencePatch, workspaceApi]);

  useEffect(() => {
    let active = true;
    if (!workspaceApi) return;

    void (async () => {
      try {
        let nextSnapshot = await workspaceApi.getSnapshot();
        const legacy = readLegacyWorkspacePreferences((key) => window.localStorage.getItem(key));
        if (legacy.found) {
          const canImport = nextSnapshot.workspaces.length === 1;
          if (canImport && Object.keys(legacy.patch).length > 0) {
            try {
              const preferences = await workspaceApi.updatePreferences({
                workspaceId: nextSnapshot.currentWorkspaceId,
                patch: legacy.patch,
              });
              nextSnapshot = { ...nextSnapshot, preferences };
              clearLegacyWorkspaceStorage();
              legacyImportWorkspaceIdRef.current = null;
            } catch {
              legacyImportWorkspaceIdRef.current = nextSnapshot.currentWorkspaceId;
              dirtyPreferencesRef.current.set(nextSnapshot.currentWorkspaceId, legacy.patch);
              setDirtyPreferenceCount(dirtyPreferencesRef.current.size);
              nextSnapshot = {
                ...nextSnapshot,
                preferences: { ...nextSnapshot.preferences, ...legacy.patch },
              };
              setSaveError('旧版布局尚未迁移，请重试保存。');
            }
          } else {
            clearLegacyWorkspaceStorage();
          }
        }
        if (active) applySnapshot(nextSnapshot);
      } catch {
        if (!active) return;
        setStatus('error');
        setLoadError('无法安全打开本地工作区，请重试。');
      }
    })();
    return () => {
      active = false;
    };
  }, [applySnapshot, loadGeneration, workspaceApi]);

  const runMutation = useCallback(
    async (
      operation: Exclude<WorkspaceOperation, null>,
      workspaceId: string | null,
      action: () => Promise<WorkspaceSnapshot>,
    ): Promise<void> => {
      if (mutationInFlightRef.current) {
        throw new Error('另一项工作区操作正在进行，请稍候。');
      }
      mutationInFlightRef.current = true;
      deferPreferenceWritesRef.current = true;
      setPendingOperation(operation);
      setPendingWorkspaceId(workspaceId);
      setOperationError(null);
      try {
        if (!(await flushDirtyPreferences())) {
          throw new Error('Workspace preferences could not be saved.');
        }
        const startedWorkspaceId = snapshotRef.current?.currentWorkspaceId ?? null;
        const revision = preferenceRevisionRef.current;
        const mutationSnapshot = await action();
        const activeWorkspaceIds = new Set(
          mutationSnapshot.workspaces.map((workspace) => workspace.id),
        );
        for (const dirtyWorkspaceId of dirtyPreferencesRef.current.keys()) {
          if (!activeWorkspaceIds.has(dirtyWorkspaceId)) {
            dirtyPreferencesRef.current.delete(dirtyWorkspaceId);
          }
        }
        setDirtyPreferenceCount(dirtyPreferencesRef.current.size);
        const targetPatch =
          dirtyPreferencesRef.current.get(mutationSnapshot.currentWorkspaceId) ?? {};
        applySnapshot(
          rebaseWorkspaceMutationSnapshot(
            mutationSnapshot,
            snapshotRef.current,
            startedWorkspaceId,
            revision !== preferenceRevisionRef.current,
            targetPatch,
          ),
        );
        deferPreferenceWritesRef.current = false;
        await flushDirtyPreferences();
      } catch (error) {
        deferPreferenceWritesRef.current = false;
        if (dirtyPreferencesRef.current.size > 0) void flushDirtyPreferences();
        const message = workspaceErrorMessage(error);
        setOperationError(message);
        throw new Error(message, { cause: error });
      } finally {
        mutationInFlightRef.current = false;
        deferPreferenceWritesRef.current = false;
        setPendingOperation(null);
        setPendingWorkspaceId(null);
      }
    },
    [applySnapshot, flushDirtyPreferences],
  );

  const create = useCallback(
    async (name: string, color: WorkspaceColor) => {
      if (!workspaceApi) throw new Error('桌面工作区桥接不可用。');
      await runMutation('create', null, () => workspaceApi.create({ name, color }));
    },
    [runMutation, workspaceApi],
  );

  const rename = useCallback(
    async (workspaceId: string, name: string) => {
      if (!workspaceApi) throw new Error('桌面工作区桥接不可用。');
      await runMutation('rename', workspaceId, () => workspaceApi.rename({ workspaceId, name }));
    },
    [runMutation, workspaceApi],
  );

  const activate = useCallback(
    async (workspaceId: string) => {
      if (!workspaceApi || snapshotRef.current?.currentWorkspaceId === workspaceId) return;
      await runMutation('activate', workspaceId, () => workspaceApi.activate({ workspaceId }));
    },
    [runMutation, workspaceApi],
  );

  const archive = useCallback(
    async (workspaceId: string) => {
      if (!workspaceApi) throw new Error('桌面工作区桥接不可用。');
      await runMutation('archive', workspaceId, () => workspaceApi.archive({ workspaceId }));
    },
    [runMutation, workspaceApi],
  );

  const updatePreferences = useCallback(
    (patch: WorkspacePreferencesPatch, persist = true, requestedWorkspaceId?: string) => {
      const current = snapshotRef.current;
      if (!current) return;
      const workspaceId = requestedWorkspaceId ?? current.currentWorkspaceId;
      preferenceRevisionRef.current += 1;
      if (workspaceId === current.currentWorkspaceId) {
        applySnapshot({
          ...current,
          preferences: { ...current.preferences, ...patch },
        });
      }
      if (!persist) return;

      const dirty = dirtyPreferencesRef.current.get(workspaceId) ?? {};
      dirtyPreferencesRef.current.set(workspaceId, mergeWorkspacePreferencePatches(dirty, patch));
      setDirtyPreferenceCount(dirtyPreferencesRef.current.size);
      if (!deferPreferenceWritesRef.current) void sendPreferencePatch(workspaceId, patch);
    },
    [applySnapshot, sendPreferencePatch],
  );

  const saveStatus: WorkspaceSaveStatus =
    pendingSaveCount > 0 || (dirtyPreferenceCount > 0 && !saveError)
      ? 'saving'
      : saveError
        ? 'error'
        : 'saved';

  return {
    status,
    snapshot,
    loadError,
    operationError,
    saveError,
    saveStatus,
    pendingOperation,
    pendingWorkspaceId,
    canRetry: Boolean(workspaceApi),
    retry: () => {
      if (!workspaceApi) {
        setStatus('error');
        setLoadError('桌面工作区桥接不可用，请重新启动应用。');
        return;
      }
      setStatus('loading');
      setLoadError(null);
      setLoadGeneration((generation) => generation + 1);
    },
    retryPreferences: () => {
      if (!deferPreferenceWritesRef.current) void flushDirtyPreferences();
    },
    create,
    rename,
    activate,
    archive,
    updatePreferences,
  };
}

function workspaceErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('preferences could not be saved')) {
    return '请先重试保存工作区设置，再继续此操作。';
  }
  if (message.includes('already uses this name')) {
    return '已有同名的活动工作区，请换一个名称。';
  }
  if (message.includes('last active workspace')) {
    return '至少需要保留一个活动工作区。';
  }
  if (message.includes('unavailable')) {
    return '这个工作区已归档或不存在。';
  }
  return '工作区操作失败，原有数据未被更改。';
}

function clearLegacyWorkspaceStorage(): void {
  for (const key of LEGACY_WORKSPACE_STORAGE_KEYS) {
    try {
      window.localStorage.removeItem(key);
    } catch {
      // SQLite is already authoritative; continue clearing any remaining keys.
    }
  }
}
