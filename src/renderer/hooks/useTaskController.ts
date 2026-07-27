import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type {
  Task,
  TaskConversionResult,
  TaskCreateResult,
  TaskPlanning,
  TaskSnapshot,
  TaskStatus,
} from '../../shared/contracts';
import {
  createdTaskFromResult,
  convertedTaskFromResult,
  countTasks,
  createTaskRequestIdentity,
  createTaskWorkspaceIdentity,
  isTaskRequestLatest,
  isTaskRequestCurrent,
  isTaskSnapshotDateCurrent,
  millisecondsUntilNextLocalDay,
  reconcileTaskCreateResult,
  shouldApplyTaskSnapshot,
  taskSnapshotForActivation,
  convertedTaskFromSnapshot,
  type TaskRequestIdentity,
  type TaskSnapshotState,
  type TaskWorkspaceIdentity,
} from '../task-state';

type TaskControllerStatus = 'loading' | 'ready' | 'error';

interface TaskLoadState {
  readonly activation: TaskWorkspaceIdentity;
  readonly status: TaskControllerStatus;
  readonly error: string | null;
}

interface TaskOperationError {
  readonly activation: TaskWorkspaceIdentity;
  readonly message: string;
}

const EMPTY_TASKS: readonly Task[] = Object.freeze([]);
const INACTIVE_ACTIVATION = Object.freeze(createTaskWorkspaceIdentity(null));
const TASK_CREATE_RECONCILIATION_ERROR =
  '任务已创建，但当前任务列表未能同步。请刷新后查看，避免重复创建。';

export interface TaskInboxConversionCommit {
  readonly result: TaskConversionResult;
  readonly createdTask: Task | null;
  readonly committed: boolean;
}

export interface TaskCreateCommit {
  readonly result: TaskCreateResult;
  readonly createdTask: Task | null;
  readonly committed: boolean;
  readonly reconciliationWarning: string | null;
}

export function useTaskController(workspaceId: string | null) {
  const activation = useMemo(() => createTaskWorkspaceIdentity(workspaceId), [workspaceId]);
  const activeActivationRef = useRef<TaskWorkspaceIdentity>(activation);
  const [storedSnapshot, setStoredSnapshot] = useState<TaskSnapshotState | null>(null);
  const storedSnapshotRef = useRef<TaskSnapshotState | null>(null);
  const [loadState, setLoadState] = useState<TaskLoadState>({
    activation,
    status: 'loading',
    error: null,
  });
  const [operationErrorState, setOperationErrorState] = useState<TaskOperationError | null>(null);
  const [pendingTaskOperations, setPendingTaskOperations] = useState<
    ReadonlyMap<string, TaskWorkspaceIdentity>
  >(() => new Map());
  const [pendingConversionOperations, setPendingConversionOperations] = useState<
    ReadonlyMap<string, TaskWorkspaceIdentity>
  >(() => new Map());
  const [pendingCreateActivations, setPendingCreateActivations] = useState<
    ReadonlySet<TaskWorkspaceIdentity>
  >(() => new Set());
  const requestSequenceRef = useRef(0);
  const latestRequestSequenceRef = useRef(-1);
  const appliedSequenceRef = useRef(-1);
  const pendingTaskOperationsRef = useRef(new Map<string, TaskWorkspaceIdentity>());
  const pendingConversionOperationsRef = useRef(new Map<string, TaskWorkspaceIdentity>());
  const pendingCreateActivationsRef = useRef(new Set<TaskWorkspaceIdentity>());

  const setStored = useCallback((value: TaskSnapshotState | null) => {
    storedSnapshotRef.current = value;
    setStoredSnapshot(value);
  }, []);

  const beginRequest = useCallback((target: TaskWorkspaceIdentity): TaskRequestIdentity | null => {
    if (target.workspaceId === null) return null;
    const sequence = ++requestSequenceRef.current;
    latestRequestSequenceRef.current = sequence;
    return createTaskRequestIdentity(target, sequence);
  }, []);

  const requestIsCurrent = useCallback(
    (request: TaskRequestIdentity): boolean =>
      isTaskRequestCurrent(activeActivationRef.current, request),
    [],
  );

  const applySnapshot = useCallback(
    (snapshot: TaskSnapshot, request: TaskRequestIdentity): boolean => {
      if (
        !shouldApplyTaskSnapshot(
          activeActivationRef.current,
          appliedSequenceRef.current,
          request,
          snapshot,
          new Date(),
        )
      ) {
        return false;
      }
      appliedSequenceRef.current = request.sequence;
      setStored({ activation: request.workspace, snapshot });
      setLoadState({
        activation: request.workspace,
        status: 'ready',
        error: null,
      });
      return true;
    },
    [setStored],
  );

  const load = useCallback(
    async (target: TaskWorkspaceIdentity): Promise<void> => {
      const request = beginRequest(target);
      if (!request) return;
      if (requestIsCurrent(request)) {
        setLoadState({
          activation: request.workspace,
          status: 'loading',
          error: null,
        });
      }
      try {
        const snapshot = await window.workbench.task.getSnapshot({
          workspaceId: request.workspaceId,
        });
        applySnapshot(snapshot, request);
      } catch (error) {
        if (
          requestIsCurrent(request) &&
          isTaskRequestLatest(request.sequence, latestRequestSequenceRef.current)
        ) {
          setStored(null);
          setLoadState({
            activation: request.workspace,
            status: 'error',
            error: toMessage(error, '任务暂时无法读取。'),
          });
        }
        throw error;
      }
    },
    [applySnapshot, beginRequest, requestIsCurrent, setStored],
  );

  const prepareSnapshotRefresh = useCallback(async () => {
    const target = activeActivationRef.current;
    const request = beginRequest(target);
    if (!request) throw new Error('当前工作区不可用，无法读取任务。');
    const snapshot = await window.workbench.task.getSnapshot({
      workspaceId: request.workspaceId,
    });
    return {
      snapshot,
      commit: () =>
        isTaskRequestLatest(request.sequence, latestRequestSequenceRef.current) &&
        applySnapshot(snapshot, request),
    };
  }, [applySnapshot, beginRequest]);

  useLayoutEffect(() => {
    activeActivationRef.current = activation;
    return () => {
      if (activeActivationRef.current === activation) {
        activeActivationRef.current = INACTIVE_ACTIVATION;
      }
    };
  }, [activation]);

  useEffect(() => {
    if (activation.workspaceId !== null && activeActivationRef.current === activation) {
      void load(activation).catch(() => undefined);
    }
  }, [activation, load]);

  useEffect(() => {
    if (activation.workspaceId === null) return;
    let timeout = 0;

    const scheduleRollover = () => {
      window.clearTimeout(timeout);
      timeout = window.setTimeout(() => {
        if (activeActivationRef.current !== activation) return;
        const current = storedSnapshotRef.current;
        if (
          current?.activation === activation &&
          !isTaskSnapshotDateCurrent(current.snapshot, new Date())
        ) {
          setStored(null);
          setLoadState({
            activation,
            status: 'loading',
            error: null,
          });
        }
        void load(activation).catch(() => undefined);
        scheduleRollover();
      }, millisecondsUntilNextLocalDay(new Date()));
    };
    const refreshIfDateChanged = () => {
      if (activeActivationRef.current !== activation) return;
      const current = storedSnapshotRef.current;
      if (
        current?.activation !== activation ||
        !isTaskSnapshotDateCurrent(current.snapshot, new Date())
      ) {
        if (current?.activation === activation) {
          setStored(null);
          setLoadState({
            activation,
            status: 'loading',
            error: null,
          });
        }
        void load(activation).catch(() => undefined);
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
  }, [activation, load, setStored]);

  const beginPendingTask = useCallback((target: TaskWorkspaceIdentity, taskId: string): boolean => {
    if (pendingTaskOperationsRef.current.get(taskId) === target) return false;
    pendingTaskOperationsRef.current = new Map(pendingTaskOperationsRef.current).set(
      taskId,
      target,
    );
    setPendingTaskOperations(pendingTaskOperationsRef.current);
    return true;
  }, []);

  const endPendingTask = useCallback((target: TaskWorkspaceIdentity, taskId: string): void => {
    if (pendingTaskOperationsRef.current.get(taskId) !== target) return;
    const next = new Map(pendingTaskOperationsRef.current);
    next.delete(taskId);
    pendingTaskOperationsRef.current = next;
    setPendingTaskOperations(next);
  }, []);

  const beginPendingCreate = useCallback((target: TaskWorkspaceIdentity): boolean => {
    if (pendingCreateActivationsRef.current.has(target)) return false;
    pendingCreateActivationsRef.current = new Set(pendingCreateActivationsRef.current).add(target);
    setPendingCreateActivations(pendingCreateActivationsRef.current);
    return true;
  }, []);

  const endPendingCreate = useCallback((target: TaskWorkspaceIdentity): void => {
    const next = new Set(pendingCreateActivationsRef.current);
    next.delete(target);
    pendingCreateActivationsRef.current = next;
    setPendingCreateActivations(next);
  }, []);

  const beginPendingConversion = useCallback(
    (target: TaskWorkspaceIdentity, entryId: string): boolean => {
      if (pendingConversionOperationsRef.current.get(entryId) === target) return false;
      pendingConversionOperationsRef.current = new Map(pendingConversionOperationsRef.current).set(
        entryId,
        target,
      );
      setPendingConversionOperations(pendingConversionOperationsRef.current);
      return true;
    },
    [],
  );

  const endPendingConversion = useCallback(
    (target: TaskWorkspaceIdentity, entryId: string): void => {
      if (pendingConversionOperationsRef.current.get(entryId) !== target) return;
      const next = new Map(pendingConversionOperationsRef.current);
      next.delete(entryId);
      pendingConversionOperationsRef.current = next;
      setPendingConversionOperations(next);
    },
    [],
  );

  const createOperationError = useCallback(
    (
      error: unknown,
      target: TaskWorkspaceIdentity,
      fallback: string,
      shouldPublish: () => boolean = () => true,
    ): Error => {
      const message = toMessage(error, fallback);
      if (activeActivationRef.current === target && shouldPublish()) {
        setOperationErrorState({ activation: target, message });
      }
      return new Error(message, { cause: error });
    },
    [],
  );

  const create = useCallback(
    async (title: string, planning: TaskPlanning): Promise<TaskCreateCommit> => {
      const target = activeActivationRef.current;
      if (target.workspaceId === null || !beginPendingCreate(target)) {
        throw new Error('这个工作区正在创建另一项任务。');
      }
      const request = beginRequest(target);
      if (!request) {
        endPendingCreate(target);
        throw new Error('当前工作区不可用，无法创建任务。');
      }
      setOperationErrorState(null);
      try {
        let result: TaskCreateResult;
        try {
          result = await window.workbench.task.create({
            workspaceId: request.workspaceId,
            title,
            planning,
          });
        } catch (error) {
          throw createOperationError(error, request.workspace, '任务创建失败，请重试。');
        }

        const reconciliation = await reconcileTaskCreateResult({
          expectedWorkspaceId: request.workspaceId,
          result,
          commitResultSnapshot: () => applySnapshot(result.taskSnapshot, request),
          getCommittedTask: () => {
            const currentSnapshot = taskSnapshotForActivation(
              request.workspace,
              storedSnapshotRef.current,
              new Date(),
            );
            return currentSnapshot
              ? createdTaskFromResult(request.workspaceId, {
                  taskSnapshot: currentSnapshot,
                  createdTaskId: result.createdTaskId,
                })
              : null;
          },
          prepareSnapshotRefresh,
          isCurrent: () => requestIsCurrent(request),
        });

        let reconciliationWarning: string | null = null;
        if (!reconciliation.committed && requestIsCurrent(request)) {
          reconciliationWarning = TASK_CREATE_RECONCILIATION_ERROR;
        }
        return {
          result,
          createdTask: reconciliation.createdTask,
          committed: reconciliation.committed,
          reconciliationWarning,
        };
      } finally {
        endPendingCreate(request.workspace);
      }
    },
    [
      applySnapshot,
      beginPendingCreate,
      beginRequest,
      createOperationError,
      endPendingCreate,
      prepareSnapshotRefresh,
      requestIsCurrent,
    ],
  );

  const runTaskMutation = useCallback(
    async (
      taskId: string,
      action: (workspaceId: string) => Promise<TaskSnapshot>,
    ): Promise<boolean> => {
      const target = activeActivationRef.current;
      if (target.workspaceId === null || !beginPendingTask(target, taskId)) return false;
      const request = beginRequest(target);
      if (!request) {
        endPendingTask(target, taskId);
        return false;
      }
      setOperationErrorState(null);
      try {
        return applySnapshot(await action(request.workspaceId), request);
      } catch (error) {
        throw createOperationError(error, request.workspace, '任务更新失败，请重试。');
      } finally {
        endPendingTask(request.workspace, taskId);
      }
    },
    [applySnapshot, beginPendingTask, beginRequest, createOperationError, endPendingTask],
  );

  const rename = useCallback(
    async (taskId: string, title: string): Promise<void> => {
      await runTaskMutation(taskId, (targetWorkspaceId) =>
        window.workbench.task.rename({ workspaceId: targetWorkspaceId, taskId, title }),
      );
    },
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
    async (
      entryId: string,
      planning: TaskPlanning,
      shouldPublishFailure: () => boolean,
    ): Promise<TaskInboxConversionCommit> => {
      const target = activeActivationRef.current;
      if (target.workspaceId === null || !beginPendingConversion(target, entryId)) {
        throw new Error('这条记录正在转换。');
      }
      const request = beginRequest(target);
      if (!request) {
        endPendingConversion(target, entryId);
        throw new Error('当前工作区不可用，无法转换记录。');
      }
      setOperationErrorState(null);
      try {
        let result: TaskConversionResult;
        try {
          result = await window.workbench.task.convertInbox({
            workspaceId: request.workspaceId,
            entryId,
            planning,
          });
        } catch (error) {
          throw createOperationError(
            error,
            request.workspace,
            '无法转换为任务，请重试。',
            shouldPublishFailure,
          );
        }
        const createdTask = convertedTaskFromResult(request.workspaceId, entryId, result);
        const committed = createdTask !== null && applySnapshot(result.taskSnapshot, request);
        return { result, createdTask, committed };
      } finally {
        endPendingConversion(request.workspace, entryId);
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

  const getCommittedConvertedTask = useCallback(
    (
      expectedWorkspaceId: string,
      expectedSourceEntryId: string,
      expectedCreatedTaskId: string,
    ): Task | null => {
      const current = activeActivationRef.current;
      if (current.workspaceId !== expectedWorkspaceId) return null;
      const committedSnapshot = taskSnapshotForActivation(
        current,
        storedSnapshotRef.current,
        new Date(),
      );
      return committedSnapshot
        ? convertedTaskFromSnapshot(
            expectedWorkspaceId,
            expectedSourceEntryId,
            expectedCreatedTaskId,
            committedSnapshot,
          )
        : null;
    },
    [],
  );

  const snapshot = taskSnapshotForActivation(activation, storedSnapshot, new Date());
  const visibleLoadState =
    loadState.activation === activation && !(loadState.status === 'ready' && snapshot === null)
      ? loadState
      : {
          activation,
          status: 'loading' as const,
          error: null,
        };
  const tasks = snapshot?.tasks ?? EMPTY_TASKS;
  const counts = useMemo(
    () => (snapshot ? countTasks(tasks, snapshot.todayDate) : null),
    [snapshot, tasks],
  );
  const pendingTaskIds = useMemo(
    () =>
      new Set(
        [...pendingTaskOperations]
          .filter(([, target]) => target === activation)
          .map(([taskId]) => taskId),
      ),
    [activation, pendingTaskOperations],
  );
  const pendingConversionEntryIds = useMemo(
    () =>
      new Set(
        [...pendingConversionOperations]
          .filter(([, target]) => target === activation)
          .map(([entryId]) => entryId),
      ),
    [activation, pendingConversionOperations],
  );
  const operationErrorMessage =
    operationErrorState?.activation === activation ? operationErrorState.message : null;

  return {
    snapshot,
    tasks,
    counts,
    status: snapshot !== null ? ('ready' as const) : visibleLoadState.status,
    loadError: visibleLoadState.error,
    operationError: operationErrorMessage,
    pendingTaskIds,
    pendingConversionEntryIds,
    pendingCreate: pendingCreateActivations.has(activation),
    isPending: (taskId: string) =>
      pendingTaskOperationsRef.current.get(taskId) === activeActivationRef.current,
    refresh: async () => {
      const current = activeActivationRef.current;
      if (current.workspaceId !== null) await load(current);
    },
    prepareSnapshotRefresh,
    getCommittedConvertedTask,
    retry: () => {
      const current = activeActivationRef.current;
      if (current.workspaceId !== null) void load(current).catch(() => undefined);
    },
    clearOperationError: () =>
      setOperationErrorState((current) => (current?.activation === activation ? null : current)),
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
