import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ScheduleItem, ScheduleKind, ScheduleSnapshot } from '../../shared/contracts';
import {
  isScheduleRequestLatest,
  isScheduleSequenceCurrent,
  isScheduleSnapshotDateCurrent,
  isScheduleWorkspaceCurrent,
  sortScheduleItems,
} from '../schedule-state';
import { millisecondsUntilNextLocalDay } from '../task-state';

type ScheduleControllerStatus = 'loading' | 'ready' | 'error';
const EMPTY_ITEMS: readonly ScheduleItem[] = Object.freeze([]);

export function useScheduleController(workspaceId: string | null) {
  const [storedSnapshot, setStoredSnapshot] = useState<ScheduleSnapshot | null>(null);
  const [status, setStatus] = useState<ScheduleControllerStatus>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [operationErrorState, setOperationErrorState] = useState<{
    readonly workspaceId: string;
    readonly message: string;
  } | null>(null);
  const [pendingItemIds, setPendingItemIds] = useState<ReadonlySet<string>>(() => new Set());
  const [pendingCreateWorkspaces, setPendingCreateWorkspaces] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const activeWorkspaceRef = useRef(workspaceId);
  const storedSnapshotRef = useRef<ScheduleSnapshot | null>(null);
  const requestSequenceRef = useRef(0);
  const latestRequestSequenceRef = useRef(new Map<string, number>());
  const appliedSequenceRef = useRef(new Map<string, number>());
  const pendingItemIdsRef = useRef(new Set<string>());
  const pendingCreateWorkspacesRef = useRef(new Set<string>());

  const beginRequest = useCallback((targetWorkspaceId: string): number => {
    const sequence = ++requestSequenceRef.current;
    latestRequestSequenceRef.current.set(targetWorkspaceId, sequence);
    return sequence;
  }, []);

  const applySnapshot = useCallback((snapshot: ScheduleSnapshot, sequence: number): boolean => {
    if (!isScheduleSnapshotDateCurrent(snapshot, new Date())) return false;
    const lastApplied = appliedSequenceRef.current.get(snapshot.workspaceId) ?? -1;
    if (!isScheduleSequenceCurrent(sequence, lastApplied)) return false;
    appliedSequenceRef.current.set(snapshot.workspaceId, sequence);
    if (!isScheduleWorkspaceCurrent(activeWorkspaceRef.current, snapshot)) return false;
    storedSnapshotRef.current = snapshot;
    setStoredSnapshot(snapshot);
    setStatus('ready');
    setLoadError(null);
    return true;
  }, []);

  const load = useCallback(
    async (targetWorkspaceId: string): Promise<void> => {
      const sequence = beginRequest(targetWorkspaceId);
      if (activeWorkspaceRef.current === targetWorkspaceId) {
        setStatus('loading');
        setLoadError(null);
      }
      try {
        applySnapshot(
          await window.workbench.schedule.getSnapshot({ workspaceId: targetWorkspaceId }),
          sequence,
        );
      } catch (error) {
        const latestRequested = latestRequestSequenceRef.current.get(targetWorkspaceId) ?? -1;
        if (
          isScheduleRequestLatest(sequence, latestRequested) &&
          activeWorkspaceRef.current === targetWorkspaceId
        ) {
          storedSnapshotRef.current = null;
          setStoredSnapshot(null);
          setStatus('error');
          setLoadError(toMessage(error, '今日日程暂时无法读取。'));
        }
      }
    },
    [applySnapshot, beginRequest],
  );

  useEffect(() => {
    activeWorkspaceRef.current = workspaceId;
    if (workspaceId) void load(workspaceId);
  }, [load, workspaceId]);

  useEffect(() => {
    if (!workspaceId) return;
    let timeout = 0;
    const scheduleRollover = () => {
      window.clearTimeout(timeout);
      timeout = window.setTimeout(() => {
        const current = storedSnapshotRef.current;
        if (current && !isScheduleSnapshotDateCurrent(current, new Date())) {
          storedSnapshotRef.current = null;
          setStoredSnapshot(null);
          setStatus('loading');
          setLoadError(null);
        }
        void load(workspaceId);
        scheduleRollover();
      }, millisecondsUntilNextLocalDay(new Date()));
    };
    const refreshIfDateChanged = () => {
      const current = storedSnapshotRef.current;
      if (!current || !isScheduleSnapshotDateCurrent(current, new Date())) {
        if (current) {
          storedSnapshotRef.current = null;
          setStoredSnapshot(null);
          setStatus('loading');
          setLoadError(null);
        }
        void load(workspaceId);
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

  const beginPendingItem = useCallback((itemId: string): boolean => {
    if (pendingItemIdsRef.current.has(itemId)) return false;
    pendingItemIdsRef.current = new Set(pendingItemIdsRef.current).add(itemId);
    setPendingItemIds(pendingItemIdsRef.current);
    return true;
  }, []);

  const endPendingItem = useCallback((itemId: string): void => {
    const next = new Set(pendingItemIdsRef.current);
    next.delete(itemId);
    pendingItemIdsRef.current = next;
    setPendingItemIds(next);
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

  const operationFailure = useCallback(
    (error: unknown, targetWorkspaceId: string, fallback: string): Error => {
      const message = toMessage(error, fallback);
      setOperationErrorState({ workspaceId: targetWorkspaceId, message });
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
    ): Promise<void> => {
      const targetWorkspaceId = activeWorkspaceRef.current;
      if (!targetWorkspaceId || !beginPendingCreate(targetWorkspaceId)) {
        throw new Error('这个工作区正在创建另一条日程。');
      }
      const sequence = beginRequest(targetWorkspaceId);
      setOperationErrorState(null);
      try {
        applySnapshot(
          await window.workbench.schedule.create({
            workspaceId: targetWorkspaceId,
            expectedDate,
            title,
            kind,
            startMinute,
            endMinute,
          }),
          sequence,
        );
      } catch (error) {
        throw operationFailure(
          error,
          targetWorkspaceId,
          '日程创建失败；如果日期已经变化，请刷新后重试。',
        );
      } finally {
        endPendingCreate(targetWorkspaceId);
      }
    },
    [applySnapshot, beginPendingCreate, beginRequest, endPendingCreate, operationFailure],
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
      const targetWorkspaceId = activeWorkspaceRef.current;
      if (!targetWorkspaceId || !beginPendingItem(item.id)) {
        throw new Error('这条日程正在保存。');
      }
      const sequence = beginRequest(targetWorkspaceId);
      setOperationErrorState(null);
      try {
        applySnapshot(
          await window.workbench.schedule.update({
            workspaceId: targetWorkspaceId,
            scheduleId: item.id,
            expectedDate,
            expectedRevision: item.revision,
            title,
            kind,
            startMinute,
            endMinute,
          }),
          sequence,
        );
      } catch (error) {
        throw operationFailure(
          error,
          targetWorkspaceId,
          '日程保存失败，可能已经跨日或在其他操作中更新。',
        );
      } finally {
        endPendingItem(item.id);
      }
    },
    [applySnapshot, beginPendingItem, beginRequest, endPendingItem, operationFailure],
  );

  const archive = useCallback(
    async (item: ScheduleItem, expectedDate: string): Promise<void> => {
      const targetWorkspaceId = activeWorkspaceRef.current;
      if (!targetWorkspaceId || !beginPendingItem(item.id)) return;
      const sequence = beginRequest(targetWorkspaceId);
      setOperationErrorState(null);
      try {
        applySnapshot(
          await window.workbench.schedule.archive({
            workspaceId: targetWorkspaceId,
            scheduleId: item.id,
            expectedDate,
            expectedRevision: item.revision,
          }),
          sequence,
        );
      } catch (error) {
        throw operationFailure(
          error,
          targetWorkspaceId,
          '日程归档失败，可能已经跨日或在其他操作中更新。',
        );
      } finally {
        endPendingItem(item.id);
      }
    },
    [applySnapshot, beginPendingItem, beginRequest, endPendingItem, operationFailure],
  );

  const snapshot =
    storedSnapshot?.workspaceId === workspaceId &&
    workspaceId !== null &&
    isScheduleSnapshotDateCurrent(storedSnapshot, new Date())
      ? storedSnapshot
      : null;
  const items = useMemo(
    () => (snapshot ? sortScheduleItems(snapshot.items) : EMPTY_ITEMS),
    [snapshot],
  );

  return {
    snapshot,
    items,
    status:
      snapshot !== null
        ? ('ready' as const)
        : storedSnapshot !== null
          ? ('loading' as const)
          : status,
    loadError,
    operationError:
      operationErrorState?.workspaceId === workspaceId ? operationErrorState.message : null,
    pendingItemIds,
    pendingCreate: workspaceId ? pendingCreateWorkspaces.has(workspaceId) : false,
    retry: () => {
      if (workspaceId) void load(workspaceId);
    },
    clearOperationError: () => setOperationErrorState(null),
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
