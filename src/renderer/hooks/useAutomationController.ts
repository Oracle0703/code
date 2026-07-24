import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AutomationAction,
  AutomationChangedEvent,
  AutomationItem,
  AutomationSchedule,
  AutomationSnapshot,
} from '../../shared/contracts';
import {
  isAutomationRequestLatest,
  isAutomationSequenceCurrent,
  isAutomationWorkspaceCurrent,
  sortAutomationItems,
} from '../automation-state';

type AutomationControllerStatus = 'loading' | 'ready' | 'error';

const EMPTY_ITEMS: readonly AutomationItem[] = Object.freeze([]);

export interface AutomationRunOutput {
  readonly workspaceId: string;
  readonly outputKind: 'task' | 'note';
}

export interface UseAutomationControllerOptions {
  readonly onRunOutput?: (output: AutomationRunOutput) => void;
}

export function useAutomationController(
  workspaceId: string | null,
  { onRunOutput }: UseAutomationControllerOptions = {},
) {
  const [storedSnapshot, setStoredSnapshot] = useState<AutomationSnapshot | null>(null);
  const [status, setStatus] = useState<AutomationControllerStatus>('loading');
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
  const onRunOutputRef = useRef(onRunOutput);
  const requestSequenceRef = useRef(0);
  const latestRequestSequenceRef = useRef(new Map<string, number>());
  const appliedSequenceRef = useRef(new Map<string, number>());
  const pendingItemIdsRef = useRef(new Set<string>());
  const pendingCreateWorkspacesRef = useRef(new Set<string>());

  useEffect(() => {
    onRunOutputRef.current = onRunOutput;
  }, [onRunOutput]);

  const beginRequest = useCallback((targetWorkspaceId: string): number => {
    const sequence = ++requestSequenceRef.current;
    latestRequestSequenceRef.current.set(targetWorkspaceId, sequence);
    return sequence;
  }, []);

  const applySnapshot = useCallback((snapshot: AutomationSnapshot, sequence: number): boolean => {
    const lastApplied = appliedSequenceRef.current.get(snapshot.workspaceId) ?? -1;
    if (!isAutomationSequenceCurrent(sequence, lastApplied)) return false;
    appliedSequenceRef.current.set(snapshot.workspaceId, sequence);
    if (!isAutomationWorkspaceCurrent(activeWorkspaceRef.current, snapshot)) return false;
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
        const snapshot = await window.workbench.automation.getSnapshot({
          workspaceId: targetWorkspaceId,
        });
        applySnapshot(snapshot, sequence);
      } catch (error) {
        const latestRequested = latestRequestSequenceRef.current.get(targetWorkspaceId) ?? -1;
        if (
          isAutomationRequestLatest(sequence, latestRequested) &&
          activeWorkspaceRef.current === targetWorkspaceId
        ) {
          setStoredSnapshot(null);
          setStatus('error');
          setLoadError(toMessage(error, '自动化暂时无法读取。'));
        }
      }
    },
    [applySnapshot, beginRequest],
  );

  useEffect(() => {
    activeWorkspaceRef.current = workspaceId;
    if (workspaceId) void load(workspaceId);
  }, [load, workspaceId]);

  useEffect(
    () =>
      window.workbench.automation.onChanged((event: AutomationChangedEvent) => {
        if (activeWorkspaceRef.current !== event.workspaceId) return;
        if (event.reason === 'run' && event.outputKind !== null) {
          onRunOutputRef.current?.({
            workspaceId: event.workspaceId,
            outputKind: event.outputKind,
          });
        }
        void load(event.workspaceId);
      }),
    [load],
  );

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

  const beginPendingItem = useCallback((automationId: string): boolean => {
    if (pendingItemIdsRef.current.has(automationId)) return false;
    pendingItemIdsRef.current = new Set(pendingItemIdsRef.current).add(automationId);
    setPendingItemIds(pendingItemIdsRef.current);
    return true;
  }, []);

  const endPendingItem = useCallback((automationId: string): void => {
    const next = new Set(pendingItemIdsRef.current);
    next.delete(automationId);
    pendingItemIdsRef.current = next;
    setPendingItemIds(next);
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
    async (name: string, schedule: AutomationSchedule, action: AutomationAction): Promise<void> => {
      const targetWorkspaceId = activeWorkspaceRef.current;
      if (!targetWorkspaceId || !beginPendingCreate(targetWorkspaceId)) {
        throw new Error('这个工作区正在创建另一条自动化。');
      }
      const sequence = beginRequest(targetWorkspaceId);
      setOperationErrorState(null);
      try {
        applySnapshot(
          await window.workbench.automation.create({
            workspaceId: targetWorkspaceId,
            name,
            schedule,
            action,
          }),
          sequence,
        );
      } catch (error) {
        throw operationFailure(error, targetWorkspaceId, '自动化创建失败，请重试。');
      } finally {
        endPendingCreate(targetWorkspaceId);
      }
    },
    [applySnapshot, beginPendingCreate, beginRequest, endPendingCreate, operationFailure],
  );

  const runItemMutation = useCallback(
    async (
      item: AutomationItem,
      fallback: string,
      action: (workspaceId: string) => Promise<AutomationSnapshot>,
    ): Promise<void> => {
      const targetWorkspaceId = activeWorkspaceRef.current;
      if (!targetWorkspaceId || !beginPendingItem(item.id)) {
        throw new Error('这条自动化正在保存。');
      }
      const sequence = beginRequest(targetWorkspaceId);
      setOperationErrorState(null);
      try {
        applySnapshot(await action(targetWorkspaceId), sequence);
      } catch (error) {
        throw operationFailure(error, targetWorkspaceId, fallback);
      } finally {
        endPendingItem(item.id);
      }
    },
    [applySnapshot, beginPendingItem, beginRequest, endPendingItem, operationFailure],
  );

  const update = useCallback(
    (item: AutomationItem, name: string, schedule: AutomationSchedule, action: AutomationAction) =>
      runItemMutation(item, '自动化保存失败，可能已在其他操作中更新。', (workspaceId) =>
        window.workbench.automation.update({
          workspaceId,
          automationId: item.id,
          expectedRevision: item.revision,
          name,
          schedule,
          action,
        }),
      ),
    [runItemMutation],
  );

  const setEnabled = useCallback(
    (item: AutomationItem, enabled: boolean) =>
      runItemMutation(item, '自动化状态更新失败，请刷新后重试。', (workspaceId) =>
        window.workbench.automation.setEnabled({
          workspaceId,
          automationId: item.id,
          expectedRevision: item.revision,
          enabled,
        }),
      ),
    [runItemMutation],
  );

  const archive = useCallback(
    (item: AutomationItem) =>
      runItemMutation(item, '自动化归档失败，请刷新后重试。', (workspaceId) =>
        window.workbench.automation.archive({
          workspaceId,
          automationId: item.id,
          expectedRevision: item.revision,
        }),
      ),
    [runItemMutation],
  );

  const snapshot =
    storedSnapshot?.workspaceId === workspaceId && workspaceId !== null ? storedSnapshot : null;
  const items = useMemo(
    () => (snapshot ? sortAutomationItems(snapshot.items) : EMPTY_ITEMS),
    [snapshot],
  );

  return {
    snapshot,
    items,
    status:
      snapshot !== null
        ? ('ready' as const)
        : storedSnapshot !== null && storedSnapshot.workspaceId !== workspaceId
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
    refresh: async () => {
      if (workspaceId) await load(workspaceId);
    },
    clearOperationError: () => setOperationErrorState(null),
    create,
    update,
    setEnabled,
    archive,
  };
}

function toMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error) || error.message.trim().length === 0) return fallback;
  const message = error.message.replace(/^Error invoking remote method '[^']+':\s*/u, '').trim();
  return message || fallback;
}
