import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Task, TaskPlanning, TaskSnapshot, TaskStatus } from '../../shared/contracts';
import {
  countTasks,
  isTaskRequestLatest,
  isTaskSequenceCurrent,
  isTaskSnapshotDateCurrent,
  isTaskWorkspaceCurrent,
  millisecondsUntilNextLocalDay,
} from '../task-state';

type TaskControllerStatus = 'loading' | 'ready' | 'error';
const EMPTY_TASKS: readonly Task[] = Object.freeze([]);

export function useTaskController(workspaceId: string | null) {
  const [storedSnapshot, setStoredSnapshot] = useState<TaskSnapshot | null>(null);
  const [status, setStatus] = useState<TaskControllerStatus>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [operationErrorState, setOperationErrorState] = useState<{
    readonly workspaceId: string;
    readonly message: string;
  } | null>(null);
  const [pendingTaskIds, setPendingTaskIds] = useState<ReadonlySet<string>>(() => new Set());
  const [pendingConversionEntryIds, setPendingConversionEntryIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [pendingCreateWorkspaces, setPendingCreateWorkspaces] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const activeWorkspaceRef = useRef(workspaceId);
  const storedSnapshotRef = useRef<TaskSnapshot | null>(null);
  const requestSequenceRef = useRef(0);
  const latestRequestSequenceRef = useRef(new Map<string, number>());
  const appliedSequenceRef = useRef(new Map<string, number>());
  const pendingTaskIdsRef = useRef(new Set<string>());
  const pendingConversionEntryIdsRef = useRef(new Set<string>());
  const pendingCreateWorkspacesRef = useRef(new Set<string>());

  const beginRequest = useCallback((targetWorkspaceId: string): number => {
    const sequence = ++requestSequenceRef.current;
    latestRequestSequenceRef.current.set(targetWorkspaceId, sequence);
    return sequence;
  }, []);

  const applySnapshot = useCallback((snapshot: TaskSnapshot, sequence: number) => {
    if (!isTaskSnapshotDateCurrent(snapshot, new Date())) return;
    const lastApplied = appliedSequenceRef.current.get(snapshot.workspaceId) ?? -1;
    if (!isTaskSequenceCurrent(sequence, lastApplied)) return;
    appliedSequenceRef.current.set(snapshot.workspaceId, sequence);
    if (!isTaskWorkspaceCurrent(activeWorkspaceRef.current, snapshot)) return;
    storedSnapshotRef.current = snapshot;
    setStoredSnapshot(snapshot);
    setStatus('ready');
    setLoadError(null);
  }, []);

  const load = useCallback(
    async (targetWorkspaceId: string): Promise<void> => {
      const sequence = beginRequest(targetWorkspaceId);
      if (activeWorkspaceRef.current === targetWorkspaceId) {
        setStatus('loading');
        setLoadError(null);
      }
      try {
        const snapshot = await window.workbench.task.getSnapshot({
          workspaceId: targetWorkspaceId,
        });
        applySnapshot(snapshot, sequence);
      } catch (error) {
        const latestRequested = latestRequestSequenceRef.current.get(targetWorkspaceId) ?? -1;
        if (
          isTaskRequestLatest(sequence, latestRequested) &&
          activeWorkspaceRef.current === targetWorkspaceId
        ) {
          storedSnapshotRef.current = null;
          setStoredSnapshot(null);
          setStatus('error');
          setLoadError(toMessage(error, '任务暂时无法读取。'));
        }
        throw error;
      }
    },
    [applySnapshot, beginRequest],
  );

  useEffect(() => {
    activeWorkspaceRef.current = workspaceId;
    if (workspaceId) void load(workspaceId).catch(() => undefined);
  }, [load, workspaceId]);

  useEffect(() => {
    if (!workspaceId) return;
    let timeout = 0;

    const scheduleRollover = () => {
      window.clearTimeout(timeout);
      timeout = window.setTimeout(() => {
        const current = storedSnapshotRef.current;
        if (current && !isTaskSnapshotDateCurrent(current, new Date())) {
          storedSnapshotRef.current = null;
          setStoredSnapshot(null);
          setStatus('loading');
          setLoadError(null);
        }
        void load(workspaceId).catch(() => undefined);
        scheduleRollover();
      }, millisecondsUntilNextLocalDay(new Date()));
    };
    const refreshIfDateChanged = () => {
      const current = storedSnapshotRef.current;
      if (!current || !isTaskSnapshotDateCurrent(current, new Date())) {
        if (current) {
          storedSnapshotRef.current = null;
          setStoredSnapshot(null);
          setStatus('loading');
          setLoadError(null);
        }
        void load(workspaceId).catch(() => undefined);
      }
      scheduleRollover();
    };
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') refreshIfDateChanged();
    };

    scheduleRollover();
    window.addEventListener('focus', refreshIfDateChanged);
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      window.clearTimeout(timeout);
      window.removeEventListener('focus', refreshIfDateChanged);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [load, workspaceId]);

  const beginPendingTask = useCallback((taskId: string): boolean => {
    if (pendingTaskIdsRef.current.has(taskId)) return false;
    pendingTaskIdsRef.current = new Set(pendingTaskIdsRef.current).add(taskId);
    setPendingTaskIds(pendingTaskIdsRef.current);
    return true;
  }, []);

  const endPendingTask = useCallback((taskId: string): void => {
    const next = new Set(pendingTaskIdsRef.current);
    next.delete(taskId);
    pendingTaskIdsRef.current = next;
    setPendingTaskIds(next);
  }, []);

  const beginPendingCreate = useCallback((targetWorkspaceId: string): boolean => {
    if (pendingCreateWorkspacesRef.current.has(targetWorkspaceId)) return false;
    pendingCreateWorkspacesRef.current = new Set(pendingCreateWorkspacesRef.current).add(
      targetWorkspaceId,
    );
    setPendingCreateWorkspaces(pendingCreateWorkspacesRef.current);
    return true;
  }, []);

  const endPendingCreate = useCallback((targetWorkspaceId: string): void => {
    const next = new Set(pendingCreateWorkspacesRef.current);
    next.delete(targetWorkspaceId);
    pendingCreateWorkspacesRef.current = next;
    setPendingCreateWorkspaces(next);
  }, []);

  const beginPendingConversion = useCallback((entryId: string): boolean => {
    if (pendingConversionEntryIdsRef.current.has(entryId)) return false;
    pendingConversionEntryIdsRef.current = new Set(pendingConversionEntryIdsRef.current).add(
      entryId,
    );
    setPendingConversionEntryIds(pendingConversionEntryIdsRef.current);
    return true;
  }, []);

  const endPendingConversion = useCallback((entryId: string): void => {
    const next = new Set(pendingConversionEntryIdsRef.current);
    next.delete(entryId);
    pendingConversionEntryIdsRef.current = next;
    setPendingConversionEntryIds(next);
  }, []);

  const createOperationError = useCallback(
    (error: unknown, targetWorkspaceId: string, fallback: string): Error => {
      const message = toMessage(error, fallback);
      setOperationErrorState({ workspaceId: targetWorkspaceId, message });
      return new Error(message, { cause: error });
    },
    [],
  );

  const create = useCallback(
    async (title: string, planning: TaskPlanning): Promise<void> => {
      const targetWorkspaceId = activeWorkspaceRef.current;
      if (!targetWorkspaceId || !beginPendingCreate(targetWorkspaceId)) {
        throw new Error('这个工作区正在创建另一项任务。');
      }
      const sequence = beginRequest(targetWorkspaceId);
      setOperationErrorState(null);
      try {
        const snapshot = await window.workbench.task.create({
          workspaceId: targetWorkspaceId,
          title,
          planning,
        });
        applySnapshot(snapshot, sequence);
      } catch (error) {
        throw createOperationError(error, targetWorkspaceId, '任务创建失败，请重试。');
      } finally {
        endPendingCreate(targetWorkspaceId);
      }
    },
    [applySnapshot, beginPendingCreate, beginRequest, createOperationError, endPendingCreate],
  );

  const runTaskMutation = useCallback(
    async (
      taskId: string,
      action: (workspaceId: string) => Promise<TaskSnapshot>,
    ): Promise<void> => {
      const targetWorkspaceId = activeWorkspaceRef.current;
      if (!targetWorkspaceId || !beginPendingTask(taskId)) return;
      const sequence = beginRequest(targetWorkspaceId);
      setOperationErrorState(null);
      try {
        applySnapshot(await action(targetWorkspaceId), sequence);
      } catch (error) {
        throw createOperationError(error, targetWorkspaceId, '任务更新失败，请重试。');
      } finally {
        endPendingTask(taskId);
      }
    },
    [applySnapshot, beginPendingTask, beginRequest, createOperationError, endPendingTask],
  );

  const rename = useCallback(
    (taskId: string, title: string) =>
      runTaskMutation(taskId, (targetWorkspaceId) =>
        window.workbench.task.rename({ workspaceId: targetWorkspaceId, taskId, title }),
      ),
    [runTaskMutation],
  );

  const updateStatus = useCallback(
    (taskId: string, taskStatus: TaskStatus) =>
      runTaskMutation(taskId, (targetWorkspaceId) =>
        window.workbench.task.updateStatus({
          workspaceId: targetWorkspaceId,
          taskId,
          status: taskStatus,
        }),
      ),
    [runTaskMutation],
  );

  const updatePlanning = useCallback(
    (taskId: string, planning: TaskPlanning) =>
      runTaskMutation(taskId, (targetWorkspaceId) =>
        window.workbench.task.updatePlanning({
          workspaceId: targetWorkspaceId,
          taskId,
          planning,
        }),
      ),
    [runTaskMutation],
  );

  const convertInbox = useCallback(
    async (entryId: string, planning: TaskPlanning) => {
      const targetWorkspaceId = activeWorkspaceRef.current;
      if (!targetWorkspaceId || !beginPendingConversion(entryId)) {
        throw new Error('这条记录正在转换。');
      }
      const sequence = beginRequest(targetWorkspaceId);
      setOperationErrorState(null);
      try {
        const result = await window.workbench.task.convertInbox({
          workspaceId: targetWorkspaceId,
          entryId,
          planning,
        });
        applySnapshot(result.taskSnapshot, sequence);
        return result;
      } catch (error) {
        throw createOperationError(error, targetWorkspaceId, '无法转换为任务，请重试。');
      } finally {
        endPendingConversion(entryId);
      }
    },
    [
      applySnapshot,
      beginPendingConversion,
      beginRequest,
      createOperationError,
      endPendingConversion,
    ],
  );

  const snapshot =
    storedSnapshot?.workspaceId === workspaceId &&
    workspaceId !== null &&
    isTaskSnapshotDateCurrent(storedSnapshot, new Date())
      ? storedSnapshot
      : null;
  const tasks = snapshot?.tasks ?? EMPTY_TASKS;
  const counts = useMemo(
    () => (snapshot ? countTasks(tasks, snapshot.todayDate) : null),
    [snapshot, tasks],
  );
  const operationErrorMessage =
    operationErrorState?.workspaceId === workspaceId ? operationErrorState.message : null;

  return {
    snapshot,
    tasks,
    counts,
    status:
      snapshot !== null
        ? ('ready' as const)
        : storedSnapshot !== null
          ? ('loading' as const)
          : status,
    loadError,
    operationError: operationErrorMessage,
    pendingTaskIds,
    pendingConversionEntryIds,
    pendingCreate: workspaceId ? pendingCreateWorkspaces.has(workspaceId) : false,
    refresh: async () => {
      if (workspaceId) await load(workspaceId);
    },
    retry: () => {
      if (workspaceId) void load(workspaceId).catch(() => undefined);
    },
    clearOperationError: () => setOperationErrorState(null),
    create,
    rename,
    updateStatus,
    updatePlanning,
    convertInbox,
  };
}

function toMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error) || error.message.trim().length === 0) return fallback;
  const message = error.message.replace(/^Error invoking remote method '[^']+':\s*/u, '').trim();
  return message || fallback;
}
