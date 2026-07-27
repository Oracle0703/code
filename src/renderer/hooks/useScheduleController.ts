import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type {
  ScheduleCreateResult,
  ScheduleItem,
  ScheduleKind,
  ScheduleSnapshot,
} from '../../shared/contracts';
import {
  createdScheduleFromResult,
  createScheduleRequestIdentity,
  createScheduleWorkspaceIdentity,
  isScheduleRequestCurrent,
  isScheduleRequestLatest,
  isScheduleSnapshotDateCurrent,
  reconcileScheduleCreateResult,
  scheduleSnapshotForActivation,
  shouldApplyScheduleSnapshot,
  sortScheduleItems,
  type ScheduleRequestIdentity,
  type ScheduleSnapshotState,
  type ScheduleWorkspaceIdentity,
} from '../schedule-state';
import { millisecondsUntilNextLocalDay } from '../task-state';

type ScheduleControllerStatus = 'loading' | 'ready' | 'error';

interface ScheduleLoadState {
  readonly activation: ScheduleWorkspaceIdentity;
  readonly status: ScheduleControllerStatus;
  readonly error: string | null;
}

interface ScheduleOperationError {
  readonly activation: ScheduleWorkspaceIdentity;
  readonly message: string;
}

const EMPTY_ITEMS: readonly ScheduleItem[] = Object.freeze([]);
const INACTIVE_ACTIVATION = Object.freeze(createScheduleWorkspaceIdentity(null));
const SCHEDULE_CREATE_RECONCILIATION_ERROR =
  '日程已创建，但当前计划未能同步。请重新读取后查看，避免重复创建。';

export interface ScheduleCreateCommit {
  readonly result: ScheduleCreateResult;
  readonly createdSchedule: ScheduleItem | null;
  readonly committed: boolean;
  readonly committedTodayDate: string | null;
  readonly reconciliationWarning: string | null;
}

export function useScheduleController(workspaceId: string | null) {
  const activation = useMemo(() => createScheduleWorkspaceIdentity(workspaceId), [workspaceId]);
  const activeActivationRef = useRef<ScheduleWorkspaceIdentity>(activation);
  const [storedSnapshot, setStoredSnapshot] = useState<ScheduleSnapshotState | null>(null);
  const storedSnapshotRef = useRef<ScheduleSnapshotState | null>(null);
  const [loadState, setLoadState] = useState<ScheduleLoadState>({
    activation,
    status: 'loading',
    error: null,
  });
  const [operationErrorState, setOperationErrorState] = useState<ScheduleOperationError | null>(
    null,
  );
  const [pendingItemOperations, setPendingItemOperations] = useState<
    ReadonlyMap<string, ScheduleWorkspaceIdentity>
  >(() => new Map());
  const [pendingCreateActivations, setPendingCreateActivations] = useState<
    ReadonlySet<ScheduleWorkspaceIdentity>
  >(() => new Set());
  const requestSequenceRef = useRef(0);
  const latestRequestSequenceRef = useRef(-1);
  const appliedSequenceRef = useRef(-1);
  const pendingItemOperationsRef = useRef(new Map<string, ScheduleWorkspaceIdentity>());
  const pendingCreateActivationsRef = useRef(new Set<ScheduleWorkspaceIdentity>());

  const setStored = useCallback((value: ScheduleSnapshotState | null) => {
    storedSnapshotRef.current = value;
    setStoredSnapshot(value);
  }, []);

  const beginRequest = useCallback(
    (target: ScheduleWorkspaceIdentity): ScheduleRequestIdentity | null => {
      if (target.workspaceId === null) return null;
      const sequence = ++requestSequenceRef.current;
      latestRequestSequenceRef.current = sequence;
      return createScheduleRequestIdentity(target, sequence);
    },
    [],
  );

  const requestIsCurrent = useCallback(
    (request: ScheduleRequestIdentity): boolean =>
      isScheduleRequestCurrent(activeActivationRef.current, request),
    [],
  );

  const applySnapshot = useCallback(
    (snapshot: ScheduleSnapshot, request: ScheduleRequestIdentity): boolean => {
      if (
        !shouldApplyScheduleSnapshot(
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
    async (target: ScheduleWorkspaceIdentity): Promise<void> => {
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
        const snapshot = await window.workbench.schedule.getSnapshot({
          workspaceId: request.workspaceId,
        });
        applySnapshot(snapshot, request);
      } catch (error) {
        if (
          requestIsCurrent(request) &&
          isScheduleRequestLatest(request.sequence, latestRequestSequenceRef.current)
        ) {
          setStored(null);
          setLoadState({
            activation: request.workspace,
            status: 'error',
            error: toMessage(error, '今日日程暂时无法读取。'),
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
    if (!request) throw new Error('当前工作区不可用，无法读取日程。');
    const snapshot = await window.workbench.schedule.getSnapshot({
      workspaceId: request.workspaceId,
    });
    return {
      snapshot,
      commit: () =>
        isScheduleRequestLatest(request.sequence, latestRequestSequenceRef.current) &&
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
          !isScheduleSnapshotDateCurrent(current.snapshot, new Date())
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
        !isScheduleSnapshotDateCurrent(current.snapshot, new Date())
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

  const beginPendingItem = useCallback(
    (target: ScheduleWorkspaceIdentity, itemId: string): boolean => {
      if (pendingItemOperationsRef.current.get(itemId) === target) return false;
      pendingItemOperationsRef.current = new Map(pendingItemOperationsRef.current).set(
        itemId,
        target,
      );
      setPendingItemOperations(pendingItemOperationsRef.current);
      return true;
    },
    [],
  );

  const endPendingItem = useCallback((target: ScheduleWorkspaceIdentity, itemId: string): void => {
    if (pendingItemOperationsRef.current.get(itemId) !== target) return;
    const next = new Map(pendingItemOperationsRef.current);
    next.delete(itemId);
    pendingItemOperationsRef.current = next;
    setPendingItemOperations(next);
  }, []);

  const beginPendingCreate = useCallback((target: ScheduleWorkspaceIdentity): boolean => {
    if (pendingCreateActivationsRef.current.has(target)) return false;
    pendingCreateActivationsRef.current = new Set(pendingCreateActivationsRef.current).add(target);
    setPendingCreateActivations(pendingCreateActivationsRef.current);
    return true;
  }, []);

  const endPendingCreate = useCallback((target: ScheduleWorkspaceIdentity): void => {
    const next = new Set(pendingCreateActivationsRef.current);
    next.delete(target);
    pendingCreateActivationsRef.current = next;
    setPendingCreateActivations(next);
  }, []);

  const operationFailure = useCallback(
    (error: unknown, target: ScheduleWorkspaceIdentity, fallback: string): Error => {
      const message = toMessage(error, fallback);
      if (activeActivationRef.current === target) {
        setOperationErrorState({ activation: target, message });
      }
      return new Error(message, { cause: error });
    },
    [],
  );

  const create = useCallback(
    async (
      expectedDate: string,
      title: string,
      kind: ScheduleKind,
      startMinute: number,
      endMinute: number,
    ): Promise<ScheduleCreateCommit> => {
      const target = activeActivationRef.current;
      if (target.workspaceId === null || !beginPendingCreate(target)) {
        throw new Error('这个工作区正在创建另一条日程。');
      }
      const request = beginRequest(target);
      if (!request) {
        endPendingCreate(target);
        throw new Error('当前工作区不可用，无法创建日程。');
      }
      setOperationErrorState(null);
      try {
        let result: ScheduleCreateResult;
        try {
          result = await window.workbench.schedule.create({
            workspaceId: request.workspaceId,
            expectedDate,
            title,
            kind,
            startMinute,
            endMinute,
          });
        } catch (error) {
          throw operationFailure(
            error,
            request.workspace,
            '日程创建失败；如果日期已经变化，请刷新后重试。',
          );
        }

        const reconciliation = await reconcileScheduleCreateResult({
          expectedWorkspaceId: request.workspaceId,
          expectedScheduledFor: expectedDate,
          result,
          commitResultSnapshot: () => applySnapshot(result.scheduleSnapshot, request),
          getCommittedSchedule: () => {
            const currentSnapshot = scheduleSnapshotForActivation(
              request.workspace,
              storedSnapshotRef.current,
              new Date(),
            );
            return currentSnapshot
              ? createdScheduleFromResult(request.workspaceId, expectedDate, {
                  scheduleSnapshot: currentSnapshot,
                  createdScheduleId: result.createdScheduleId,
                })
              : null;
          },
          prepareSnapshotRefresh,
          isCurrent: () => requestIsCurrent(request),
        });
        const committedSnapshot = scheduleSnapshotForActivation(
          request.workspace,
          storedSnapshotRef.current,
          new Date(),
        );
        const committedSchedule = committedSnapshot
          ? createdScheduleFromResult(request.workspaceId, expectedDate, {
              scheduleSnapshot: committedSnapshot,
              createdScheduleId: result.createdScheduleId,
            })
          : null;
        const committed = reconciliation.committed && committedSchedule !== null;

        return {
          result,
          createdSchedule: committedSchedule ?? reconciliation.createdSchedule,
          committed,
          committedTodayDate: committed ? committedSnapshot!.todayDate : null,
          reconciliationWarning:
            !committed && requestIsCurrent(request) ? SCHEDULE_CREATE_RECONCILIATION_ERROR : null,
        };
      } finally {
        endPendingCreate(request.workspace);
      }
    },
    [
      applySnapshot,
      beginPendingCreate,
      beginRequest,
      endPendingCreate,
      operationFailure,
      prepareSnapshotRefresh,
      requestIsCurrent,
    ],
  );

  const update = useCallback(
    async (
      item: ScheduleItem,
      expectedDate: string,
      title: string,
      kind: ScheduleKind,
      startMinute: number,
      endMinute: number,
    ): Promise<void> => {
      const target = activeActivationRef.current;
      if (target.workspaceId === null || !beginPendingItem(target, item.id)) {
        throw new Error('这条日程正在保存。');
      }
      const request = beginRequest(target);
      if (!request) {
        endPendingItem(target, item.id);
        throw new Error('当前工作区不可用，无法保存日程。');
      }
      setOperationErrorState(null);
      try {
        applySnapshot(
          await window.workbench.schedule.update({
            workspaceId: request.workspaceId,
            scheduleId: item.id,
            expectedDate,
            expectedRevision: item.revision,
            title,
            kind,
            startMinute,
            endMinute,
          }),
          request,
        );
      } catch (error) {
        throw operationFailure(
          error,
          request.workspace,
          '日程保存失败，可能已经跨日或在其他操作中更新。',
        );
      } finally {
        endPendingItem(request.workspace, item.id);
      }
    },
    [applySnapshot, beginPendingItem, beginRequest, endPendingItem, operationFailure],
  );

  const archive = useCallback(
    async (item: ScheduleItem, expectedDate: string): Promise<void> => {
      const target = activeActivationRef.current;
      if (target.workspaceId === null || !beginPendingItem(target, item.id)) return;
      const request = beginRequest(target);
      if (!request) {
        endPendingItem(target, item.id);
        return;
      }
      setOperationErrorState(null);
      try {
        applySnapshot(
          await window.workbench.schedule.archive({
            workspaceId: request.workspaceId,
            scheduleId: item.id,
            expectedDate,
            expectedRevision: item.revision,
          }),
          request,
        );
      } catch (error) {
        throw operationFailure(
          error,
          request.workspace,
          '日程归档失败，可能已经跨日或在其他操作中更新。',
        );
      } finally {
        endPendingItem(request.workspace, item.id);
      }
    },
    [applySnapshot, beginPendingItem, beginRequest, endPendingItem, operationFailure],
  );

  const snapshot = scheduleSnapshotForActivation(activation, storedSnapshot, new Date());
  const visibleLoadState =
    loadState.activation === activation && !(loadState.status === 'ready' && snapshot === null)
      ? loadState
      : {
          activation,
          status: 'loading' as const,
          error: null,
        };
  const items = useMemo(
    () => (snapshot ? sortScheduleItems(snapshot.items) : EMPTY_ITEMS),
    [snapshot],
  );
  const pendingItemIds = useMemo(
    () =>
      new Set(
        [...pendingItemOperations]
          .filter(([, target]) => target === activation)
          .map(([itemId]) => itemId),
      ),
    [activation, pendingItemOperations],
  );

  return {
    activation,
    snapshot,
    items,
    status: snapshot !== null ? ('ready' as const) : visibleLoadState.status,
    loadError: visibleLoadState.error,
    operationError:
      operationErrorState?.activation === activation ? operationErrorState.message : null,
    pendingItemIds,
    pendingCreate: pendingCreateActivations.has(activation),
    refresh: async () => {
      const current = activeActivationRef.current;
      if (current.workspaceId !== null) await load(current);
    },
    prepareSnapshotRefresh,
    retry: () => {
      const current = activeActivationRef.current;
      if (current.workspaceId !== null) void load(current).catch(() => undefined);
    },
    clearOperationError: () =>
      setOperationErrorState((current) => (current?.activation === activation ? null : current)),
    create,
    update,
    archive,
  };
}

function toMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error) || error.message.trim().length === 0) return fallback;
  const message = error.message.replace(/^Error invoking remote method '[^']+':\s*/u, '').trim();
  return message || fallback;
}
