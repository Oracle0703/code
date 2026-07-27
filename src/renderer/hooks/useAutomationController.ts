import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type {
  AutomationAction,
  AutomationChangedEvent,
  AutomationCreateResult,
  AutomationItem,
  AutomationSchedule,
  AutomationSnapshot,
} from '../../shared/contracts';
import {
  automationSnapshotForActivation,
  automationRunFeedbackAfterMainSuccess,
  createdAutomationFromResult,
  createAutomationRequestIdentity,
  createAutomationRunRequestIdentity,
  createAutomationWorkspaceIdentity,
  isAutomationRequestLatest,
  isAutomationRequestCurrent,
  reconcileAutomationCreateResult,
  shouldApplyAutomationSnapshot,
  sortAutomationItems,
  type AutomationRequestIdentity,
  type AutomationRunFeedback,
  type AutomationSnapshotState,
  type AutomationWorkspaceIdentity,
} from '../automation-state';

type AutomationControllerStatus = 'loading' | 'ready' | 'error';

const EMPTY_ITEMS: readonly AutomationItem[] = Object.freeze([]);
const INACTIVE_ACTIVATION = Object.freeze(createAutomationWorkspaceIdentity(null));
const AUTOMATION_CREATE_RECONCILIATION_ERROR =
  '自动化已创建，但当前规则列表未能同步。请刷新后查看，避免重复创建。';

export interface AutomationRunOutput {
  readonly workspaceId: string;
  readonly outputKind: 'task' | 'note';
}

export interface UseAutomationControllerOptions {
  readonly onRunOutput?: (output: AutomationRunOutput) => void;
}

export interface AutomationCreateCommit {
  readonly result: AutomationCreateResult;
  readonly createdAutomation: AutomationItem | null;
  readonly committed: boolean;
  readonly reconciliationWarning: string | null;
}

export function useAutomationController(
  workspaceId: string | null,
  { onRunOutput }: UseAutomationControllerOptions = {},
) {
  const [storedSnapshot, setStoredSnapshot] = useState<AutomationSnapshotState | null>(null);
  const storedSnapshotRef = useRef<AutomationSnapshotState | null>(null);
  const [status, setStatus] = useState<AutomationControllerStatus>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [operationErrorState, setOperationErrorState] = useState<{
    readonly activation: AutomationWorkspaceIdentity;
    readonly message: string;
  } | null>(null);
  const [pendingItemIds, setPendingItemIds] = useState<ReadonlySet<string>>(() => new Set());
  const [runningItemIds, setRunningItemIds] = useState<ReadonlySet<string>>(() => new Set());
  const [pendingCreateActivations, setPendingCreateActivations] = useState<
    ReadonlySet<AutomationWorkspaceIdentity>
  >(() => new Set());
  const activeWorkspaceIdentity = useMemo(
    () => createAutomationWorkspaceIdentity(workspaceId),
    [workspaceId],
  );
  const activeWorkspaceIdentityRef = useRef(activeWorkspaceIdentity);
  useLayoutEffect(() => {
    activeWorkspaceIdentityRef.current = activeWorkspaceIdentity;
    return () => {
      if (activeWorkspaceIdentityRef.current === activeWorkspaceIdentity) {
        activeWorkspaceIdentityRef.current = INACTIVE_ACTIVATION;
      }
    };
  }, [activeWorkspaceIdentity]);
  const onRunOutputRef = useRef(onRunOutput);
  const requestSequenceRef = useRef(0);
  const runRequestSequenceRef = useRef(0);
  const latestRequestSequenceRef = useRef(-1);
  const appliedSequenceRef = useRef(-1);
  const pendingItemIdsRef = useRef(new Set<string>());
  const runningItemIdsRef = useRef(new Set<string>());
  const pendingCreateActivationsRef = useRef(new Set<AutomationWorkspaceIdentity>());

  useEffect(() => {
    onRunOutputRef.current = onRunOutput;
  }, [onRunOutput]);

  const setStored = useCallback((value: AutomationSnapshotState | null) => {
    storedSnapshotRef.current = value;
    setStoredSnapshot(value);
  }, []);

  const beginRequest = useCallback(
    (target: AutomationWorkspaceIdentity): AutomationRequestIdentity | null => {
      if (target.workspaceId === null) return null;
      const sequence = ++requestSequenceRef.current;
      latestRequestSequenceRef.current = sequence;
      return createAutomationRequestIdentity(target, sequence);
    },
    [],
  );

  const requestIsCurrent = useCallback(
    (request: AutomationRequestIdentity): boolean =>
      isAutomationRequestCurrent(activeWorkspaceIdentityRef.current, request),
    [],
  );

  const applySnapshot = useCallback(
    (snapshot: AutomationSnapshot, request: AutomationRequestIdentity): boolean => {
      if (
        !shouldApplyAutomationSnapshot(
          activeWorkspaceIdentityRef.current,
          appliedSequenceRef.current,
          request,
          snapshot,
        )
      ) {
        return false;
      }
      appliedSequenceRef.current = request.sequence;
      setStored({ activation: request.workspace, snapshot });
      setStatus('ready');
      setLoadError(null);
      return true;
    },
    [setStored],
  );

  const load = useCallback(
    async (target: AutomationWorkspaceIdentity): Promise<void> => {
      const request = beginRequest(target);
      if (!request) return;
      if (requestIsCurrent(request)) {
        setStatus('loading');
        setLoadError(null);
      }
      try {
        const snapshot = await window.workbench.automation.getSnapshot({
          workspaceId: request.workspaceId,
        });
        applySnapshot(snapshot, request);
      } catch (error) {
        if (
          requestIsCurrent(request) &&
          isAutomationRequestLatest(request.sequence, latestRequestSequenceRef.current)
        ) {
          setStored(null);
          setStatus('error');
          setLoadError(toMessage(error, '自动化暂时无法读取。'));
        }
      }
    },
    [applySnapshot, beginRequest, requestIsCurrent, setStored],
  );

  const prepareSnapshotRefresh = useCallback(async () => {
    const target = activeWorkspaceIdentityRef.current;
    const request = beginRequest(target);
    if (!request) throw new Error('当前工作区不可用，无法读取自动化。');
    const snapshot = await window.workbench.automation.getSnapshot({
      workspaceId: request.workspaceId,
    });
    return {
      snapshot,
      commit: () =>
        isAutomationRequestLatest(request.sequence, latestRequestSequenceRef.current) &&
        applySnapshot(snapshot, request),
    };
  }, [applySnapshot, beginRequest]);

  useEffect(() => {
    if (
      activeWorkspaceIdentity.workspaceId !== null &&
      activeWorkspaceIdentityRef.current === activeWorkspaceIdentity
    ) {
      void load(activeWorkspaceIdentity);
    }
  }, [activeWorkspaceIdentity, load]);

  useEffect(
    () =>
      window.workbench.automation.onChanged((event: AutomationChangedEvent) => {
        const target = activeWorkspaceIdentityRef.current;
        if (target.workspaceId !== event.workspaceId) return;
        if (event.reason === 'run' && event.outputKind !== null) {
          onRunOutputRef.current?.({
            workspaceId: event.workspaceId,
            outputKind: event.outputKind,
          });
        }
        void load(target);
      }),
    [load],
  );

  const beginPendingCreate = useCallback((target: AutomationWorkspaceIdentity): boolean => {
    if (pendingCreateActivationsRef.current.has(target)) return false;
    pendingCreateActivationsRef.current = new Set(pendingCreateActivationsRef.current).add(target);
    setPendingCreateActivations(pendingCreateActivationsRef.current);
    return true;
  }, []);

  const endPendingCreate = useCallback((target: AutomationWorkspaceIdentity): void => {
    const next = new Set(pendingCreateActivationsRef.current);
    next.delete(target);
    pendingCreateActivationsRef.current = next;
    setPendingCreateActivations(next);
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

  const beginRunningItem = useCallback((automationId: string): void => {
    runningItemIdsRef.current = new Set(runningItemIdsRef.current).add(automationId);
    setRunningItemIds(runningItemIdsRef.current);
  }, []);

  const endRunningItem = useCallback((automationId: string): void => {
    const next = new Set(runningItemIdsRef.current);
    next.delete(automationId);
    runningItemIdsRef.current = next;
    setRunningItemIds(next);
  }, []);

  const operationFailure = useCallback(
    (
      error: unknown,
      target: AutomationWorkspaceIdentity,
      fallback: string,
      shouldPublish: () => boolean = () => true,
    ): Error => {
      const message = toMessage(error, fallback);
      if (activeWorkspaceIdentityRef.current === target && shouldPublish()) {
        setOperationErrorState({ activation: target, message });
      }
      return new Error(message, { cause: error });
    },
    [],
  );

  const create = useCallback(
    async (
      name: string,
      schedule: AutomationSchedule,
      action: AutomationAction,
    ): Promise<AutomationCreateCommit> => {
      const target = activeWorkspaceIdentityRef.current;
      if (target.workspaceId === null || !beginPendingCreate(target)) {
        throw new Error('这个工作区正在创建另一条自动化。');
      }
      const request = beginRequest(target);
      if (!request) {
        endPendingCreate(target);
        throw new Error('当前工作区不可用，无法创建自动化。');
      }
      setOperationErrorState(null);
      try {
        let result: AutomationCreateResult;
        try {
          result = await window.workbench.automation.create({
            workspaceId: request.workspaceId,
            name,
            schedule,
            action,
          });
        } catch (error) {
          throw operationFailure(error, request.workspace, '自动化创建失败，请重试。');
        }

        const reconciliation = await reconcileAutomationCreateResult({
          expectedWorkspaceId: request.workspaceId,
          result,
          commitResultSnapshot: () =>
            isAutomationRequestLatest(request.sequence, latestRequestSequenceRef.current) &&
            applySnapshot(result.automationSnapshot, request),
          getCommittedAutomation: () => {
            const currentSnapshot = automationSnapshotForActivation(
              request.workspace,
              storedSnapshotRef.current,
            );
            return currentSnapshot
              ? createdAutomationFromResult(request.workspaceId, {
                  automationSnapshot: currentSnapshot,
                  createdAutomationId: result.createdAutomationId,
                })
              : null;
          },
          prepareSnapshotRefresh,
          isCurrent: () => requestIsCurrent(request),
        });

        return {
          result,
          createdAutomation: reconciliation.createdAutomation,
          committed: reconciliation.committed,
          reconciliationWarning:
            !reconciliation.committed && requestIsCurrent(request)
              ? AUTOMATION_CREATE_RECONCILIATION_ERROR
              : null,
        };
      } finally {
        endPendingCreate(target);
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

  const runItemMutation = useCallback(
    async (
      item: AutomationItem,
      fallback: string,
      action: (workspaceId: string) => Promise<AutomationSnapshot>,
    ): Promise<void> => {
      const target = activeWorkspaceIdentityRef.current;
      if (target.workspaceId === null || !beginPendingItem(item.id)) {
        throw new Error('这条自动化正在保存。');
      }
      const request = beginRequest(target);
      if (!request) {
        endPendingItem(item.id);
        throw new Error('当前工作区不可用，无法保存自动化。');
      }
      setOperationErrorState(null);
      try {
        applySnapshot(await action(request.workspaceId), request);
      } catch (error) {
        throw operationFailure(error, request.workspace, fallback);
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

  const runNow = useCallback(
    async (item: AutomationItem): Promise<AutomationRunFeedback> => {
      const workspaceIdentity = activeWorkspaceIdentityRef.current;
      if (workspaceIdentity.workspaceId === null) {
        throw new Error('当前工作区正在切换，无法立即运行自动化。');
      }
      if (!beginPendingItem(item.id)) {
        throw new Error('这条自动化正在运行或保存。');
      }
      const request = createAutomationRunRequestIdentity(
        workspaceIdentity,
        item.id,
        ++runRequestSequenceRef.current,
      );
      if (!request) {
        endPendingItem(item.id);
        throw new Error('当前工作区不可用，无法立即运行自动化。');
      }
      beginRunningItem(item.id);
      setOperationErrorState(null);
      try {
        let result;
        try {
          result = await window.workbench.automation.runNow({
            workspaceId: request.workspaceId,
            automationId: request.automationId,
            expectedRevision: item.revision,
          });
        } catch (error) {
          throw operationFailure(error, request.workspace, '自动化立即运行失败，请重试。');
        }
        return automationRunFeedbackAfterMainSuccess(request, item, result);
      } finally {
        endRunningItem(item.id);
        endPendingItem(item.id);
      }
    },
    [beginPendingItem, beginRunningItem, endPendingItem, endRunningItem, operationFailure],
  );

  const snapshot = automationSnapshotForActivation(activeWorkspaceIdentity, storedSnapshot);
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
        : storedSnapshot !== null && storedSnapshot.activation !== activeWorkspaceIdentity
          ? ('loading' as const)
          : status,
    loadError,
    operationError:
      operationErrorState?.activation === activeWorkspaceIdentity
        ? operationErrorState.message
        : null,
    pendingItemIds,
    runningItemIds,
    pendingCreate:
      activeWorkspaceIdentity.workspaceId !== null &&
      pendingCreateActivations.has(activeWorkspaceIdentity),
    retry: () => {
      if (activeWorkspaceIdentity.workspaceId !== null) void load(activeWorkspaceIdentity);
    },
    refresh: async () => {
      if (activeWorkspaceIdentity.workspaceId !== null) await load(activeWorkspaceIdentity);
    },
    prepareSnapshotRefresh,
    clearOperationError: () => setOperationErrorState(null),
    create,
    update,
    setEnabled,
    archive,
    runNow,
  };
}

function toMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error) || error.message.trim().length === 0) return fallback;
  const message = error.message.replace(/^Error invoking remote method '[^']+':\s*/u, '').trim();
  return message || fallback;
}
