import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type {
  InboxCategory,
  InboxCreateResult,
  InboxEntry,
  InboxSnapshot,
} from '../../shared/contracts';
import { INBOX_UNDO_WINDOW_MS } from '../../shared/inbox-domain';
import {
  countInboxEntries,
  createdInboxEntryFromResult,
  createInboxRequestIdentity,
  createInboxWorkspaceIdentity,
  inboxSnapshotForActivation,
  isInboxConversionSourceArchived,
  isInboxRequestCurrent,
  isInboxRequestLatest,
  reconcileInboxCreateResult,
  shouldApplyInboxSnapshot,
  type InboxRequestIdentity,
  type InboxSnapshotState,
  type InboxWorkspaceIdentity,
} from '../inbox-state';

export interface InboxUndoNotice {
  readonly undoToken: string;
  readonly workspaceId: string;
  readonly content: string;
  readonly expiresAtMonotonicMs: number;
}

export interface InboxCaptureCommit {
  readonly result: InboxCreateResult;
  readonly createdEntry: InboxEntry | null;
  readonly committed: boolean;
  readonly reconciliationWarning: string | null;
}

type InboxStatus = 'loading' | 'ready' | 'error';

interface InboxLoadState {
  readonly activation: InboxWorkspaceIdentity;
  readonly status: InboxStatus;
  readonly error: string | null;
}

interface InboxOperationError {
  readonly activation: InboxWorkspaceIdentity;
  readonly message: string;
}

const EMPTY_ENTRIES: readonly InboxEntry[] = Object.freeze([]);
const INACTIVE_ACTIVATION = Object.freeze(createInboxWorkspaceIdentity(null));
const INBOX_CREATE_RECONCILIATION_ERROR =
  '记录已创建，但当前收件箱未能同步。请重新读取后查看，避免重复添加。';

export function useInboxController(workspaceId: string | null) {
  const activation = useMemo(() => createInboxWorkspaceIdentity(workspaceId), [workspaceId]);
  const activeActivationRef = useRef<InboxWorkspaceIdentity>(activation);
  const [storedSnapshot, setStoredSnapshot] = useState<InboxSnapshotState | null>(null);
  const storedSnapshotRef = useRef<InboxSnapshotState | null>(null);
  const [loadState, setLoadState] = useState<InboxLoadState>({
    activation,
    status: 'loading',
    error: null,
  });
  const [operationErrorState, setOperationErrorState] = useState<InboxOperationError | null>(null);
  const [pendingEntryOperations, setPendingEntryOperations] = useState<
    ReadonlyMap<string, InboxWorkspaceIdentity>
  >(() => new Map());
  const [pendingCaptureActivations, setPendingCaptureActivations] = useState<
    ReadonlySet<InboxWorkspaceIdentity>
  >(() => new Set());
  const [pendingUndoOperations, setPendingUndoOperations] = useState<
    ReadonlyMap<string, InboxWorkspaceIdentity>
  >(() => new Map());
  const [undoNotices, setUndoNotices] = useState<readonly InboxUndoNotice[]>([]);
  const requestSequenceRef = useRef(0);
  const latestRequestSequenceRef = useRef(-1);
  const appliedSequenceRef = useRef(-1);
  const pendingEntryOperationsRef = useRef(new Map<string, InboxWorkspaceIdentity>());
  const pendingCaptureActivationsRef = useRef(new Set<InboxWorkspaceIdentity>());
  const pendingUndoOperationsRef = useRef(new Map<string, InboxWorkspaceIdentity>());

  const setStored = useCallback((value: InboxSnapshotState | null) => {
    storedSnapshotRef.current = value;
    setStoredSnapshot(value);
  }, []);

  const beginPendingEntry = useCallback(
    (target: InboxWorkspaceIdentity, entryId: string): boolean => {
      if (pendingEntryOperationsRef.current.get(entryId) === target) return false;
      pendingEntryOperationsRef.current = new Map(pendingEntryOperationsRef.current).set(
        entryId,
        target,
      );
      setPendingEntryOperations(pendingEntryOperationsRef.current);
      return true;
    },
    [],
  );

  const endPendingEntry = useCallback((target: InboxWorkspaceIdentity, entryId: string): void => {
    if (pendingEntryOperationsRef.current.get(entryId) !== target) return;
    const next = new Map(pendingEntryOperationsRef.current);
    next.delete(entryId);
    pendingEntryOperationsRef.current = next;
    setPendingEntryOperations(next);
  }, []);

  const beginPendingCapture = useCallback((target: InboxWorkspaceIdentity): boolean => {
    if (pendingCaptureActivationsRef.current.has(target)) return false;
    pendingCaptureActivationsRef.current = new Set(pendingCaptureActivationsRef.current).add(
      target,
    );
    setPendingCaptureActivations(pendingCaptureActivationsRef.current);
    return true;
  }, []);

  const endPendingCapture = useCallback((target: InboxWorkspaceIdentity): void => {
    const next = new Set(pendingCaptureActivationsRef.current);
    next.delete(target);
    pendingCaptureActivationsRef.current = next;
    setPendingCaptureActivations(next);
  }, []);

  const beginPendingUndo = useCallback(
    (target: InboxWorkspaceIdentity, undoToken: string): boolean => {
      if (pendingUndoOperationsRef.current.get(undoToken) === target) return false;
      pendingUndoOperationsRef.current = new Map(pendingUndoOperationsRef.current).set(
        undoToken,
        target,
      );
      setPendingUndoOperations(pendingUndoOperationsRef.current);
      return true;
    },
    [],
  );

  const endPendingUndo = useCallback((target: InboxWorkspaceIdentity, undoToken: string): void => {
    if (pendingUndoOperationsRef.current.get(undoToken) !== target) return;
    const next = new Map(pendingUndoOperationsRef.current);
    next.delete(undoToken);
    pendingUndoOperationsRef.current = next;
    setPendingUndoOperations(next);
  }, []);

  const beginRequest = useCallback(
    (target: InboxWorkspaceIdentity): InboxRequestIdentity | null => {
      if (target.workspaceId === null) return null;
      const sequence = ++requestSequenceRef.current;
      latestRequestSequenceRef.current = sequence;
      return createInboxRequestIdentity(target, sequence);
    },
    [],
  );

  const requestIsCurrent = useCallback(
    (request: InboxRequestIdentity): boolean =>
      isInboxRequestCurrent(activeActivationRef.current, request),
    [],
  );

  const applySnapshot = useCallback(
    (snapshot: InboxSnapshot, request: InboxRequestIdentity): boolean => {
      if (
        !shouldApplyInboxSnapshot(
          activeActivationRef.current,
          appliedSequenceRef.current,
          request,
          snapshot,
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
    async (target: InboxWorkspaceIdentity): Promise<void> => {
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
        applySnapshot(
          await window.workbench.inbox.getSnapshot({
            workspaceId: request.workspaceId,
          }),
          request,
        );
      } catch (error) {
        if (
          requestIsCurrent(request) &&
          isInboxRequestLatest(request.sequence, latestRequestSequenceRef.current)
        ) {
          setStored(null);
          setLoadState({
            activation: request.workspace,
            status: 'error',
            error: toMessage(error, '收件箱暂时无法读取。'),
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
    if (!request) throw new Error('当前工作区不可用，无法读取收件箱。');
    const snapshot = await window.workbench.inbox.getSnapshot({
      workspaceId: request.workspaceId,
    });
    return {
      snapshot,
      commit: () =>
        isInboxRequestLatest(request.sequence, latestRequestSequenceRef.current) &&
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
    if (undoNotices.length === 0) return;
    const earliest = Math.min(
      ...undoNotices.map(({ expiresAtMonotonicMs }) => expiresAtMonotonicMs),
    );
    const timeout = window.setTimeout(
      () => {
        const now = window.performance.now();
        setUndoNotices((current) =>
          current.filter(({ expiresAtMonotonicMs }) => expiresAtMonotonicMs > now),
        );
      },
      Math.max(0, earliest - window.performance.now()) + 25,
    );
    return () => window.clearTimeout(timeout);
  }, [undoNotices]);

  const clearOperationErrorFor = useCallback((target: InboxWorkspaceIdentity): void => {
    setOperationErrorState((current) => (current?.activation === target ? null : current));
  }, []);

  const operationFailure = useCallback(
    (
      error: unknown,
      target: InboxWorkspaceIdentity,
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
    async (
      targetWorkspaceId: string,
      content: string,
      category: InboxCategory,
      shouldPublishFailure: () => boolean = () => true,
    ): Promise<InboxCaptureCommit> => {
      const target = activeActivationRef.current;
      if (target.workspaceId === null || target.workspaceId !== targetWorkspaceId) {
        throw new Error('工作区已经切换，请重新打开快速记录。');
      }
      if (!beginPendingCapture(target)) {
        throw new Error('这个工作区正在保存另一条快速记录。');
      }
      const request = beginRequest(target);
      if (!request) {
        endPendingCapture(target);
        throw new Error('当前工作区不可用，无法保存快速记录。');
      }
      clearOperationErrorFor(target);
      try {
        let result: InboxCreateResult;
        try {
          result = await window.workbench.inbox.create({
            workspaceId: request.workspaceId,
            content,
            category,
          });
        } catch (error) {
          throw operationFailure(
            error,
            request.workspace,
            '快速记录失败，请重试。',
            () =>
              shouldPublishFailure() &&
              requestIsCurrent(request) &&
              isInboxRequestLatest(request.sequence, latestRequestSequenceRef.current),
          );
        }

        const reconciliation = await reconcileInboxCreateResult({
          expectedWorkspaceId: request.workspaceId,
          result,
          commitResultSnapshot: () => applySnapshot(result.inboxSnapshot, request),
          getCommittedEntry: () => {
            const currentSnapshot = inboxSnapshotForActivation(
              request.workspace,
              storedSnapshotRef.current,
            );
            return currentSnapshot
              ? createdInboxEntryFromResult(request.workspaceId, {
                  inboxSnapshot: currentSnapshot,
                  createdEntryId: result.createdEntryId,
                })
              : null;
          },
          prepareSnapshotRefresh,
          isCurrent: () => requestIsCurrent(request),
        });

        const reconciliationWarning =
          !reconciliation.committed && requestIsCurrent(request)
            ? INBOX_CREATE_RECONCILIATION_ERROR
            : null;
        return {
          result,
          createdEntry: reconciliation.createdEntry,
          committed: reconciliation.committed,
          reconciliationWarning,
        };
      } finally {
        endPendingCapture(request.workspace);
      }
    },
    [
      applySnapshot,
      beginPendingCapture,
      beginRequest,
      clearOperationErrorFor,
      endPendingCapture,
      operationFailure,
      prepareSnapshotRefresh,
      requestIsCurrent,
    ],
  );

  const categorize = useCallback(
    async (entryId: string, category: InboxCategory) => {
      const target = activeActivationRef.current;
      if (target.workspaceId === null || !beginPendingEntry(target, entryId)) return;
      const request = beginRequest(target);
      if (!request) {
        endPendingEntry(target, entryId);
        return;
      }
      clearOperationErrorFor(target);
      try {
        applySnapshot(
          await window.workbench.inbox.categorize({
            workspaceId: request.workspaceId,
            entryId,
            category,
          }),
          request,
        );
      } catch (error) {
        throw operationFailure(error, request.workspace, '分类更新失败，请重试。');
      } finally {
        endPendingEntry(request.workspace, entryId);
      }
    },
    [
      applySnapshot,
      beginPendingEntry,
      beginRequest,
      clearOperationErrorFor,
      endPendingEntry,
      operationFailure,
    ],
  );

  const archive = useCallback(
    async (entry: InboxEntry) => {
      const target = activeActivationRef.current;
      if (target.workspaceId === null || !beginPendingEntry(target, entry.id)) return;
      const request = beginRequest(target);
      if (!request) {
        endPendingEntry(target, entry.id);
        return;
      }
      clearOperationErrorFor(target);
      try {
        const result = await window.workbench.inbox.archive({
          workspaceId: request.workspaceId,
          entryId: entry.id,
        });
        applySnapshot(result.snapshot, request);
        setUndoNotices((current) => [
          ...current.filter(({ undoToken }) => undoToken !== result.undoToken),
          {
            undoToken: result.undoToken,
            workspaceId: request.workspaceId,
            content: entry.content,
            expiresAtMonotonicMs: window.performance.now() + INBOX_UNDO_WINDOW_MS,
          },
        ]);
      } catch (error) {
        throw operationFailure(error, request.workspace, '归档失败，请重试。');
      } finally {
        endPendingEntry(request.workspace, entry.id);
      }
    },
    [
      applySnapshot,
      beginPendingEntry,
      beginRequest,
      clearOperationErrorFor,
      endPendingEntry,
      operationFailure,
    ],
  );

  const undoArchive = useCallback(
    async (notice: InboxUndoNotice) => {
      const target = activeActivationRef.current;
      if (
        target.workspaceId === null ||
        target.workspaceId !== notice.workspaceId ||
        !beginPendingUndo(target, notice.undoToken)
      ) {
        return;
      }
      const request = beginRequest(target);
      if (!request) {
        endPendingUndo(target, notice.undoToken);
        return;
      }
      clearOperationErrorFor(target);
      try {
        applySnapshot(
          await window.workbench.inbox.undoArchive({
            workspaceId: request.workspaceId,
            undoToken: notice.undoToken,
          }),
          request,
        );
        setUndoNotices((current) =>
          current.filter(({ undoToken }) => undoToken !== notice.undoToken),
        );
      } catch (error) {
        throw operationFailure(error, request.workspace, '撤销失败或已过期。');
      } finally {
        endPendingUndo(request.workspace, notice.undoToken);
      }
    },
    [
      applySnapshot,
      beginPendingUndo,
      beginRequest,
      clearOperationErrorFor,
      endPendingUndo,
      operationFailure,
    ],
  );

  const snapshot = inboxSnapshotForActivation(activation, storedSnapshot);
  const visibleLoadState =
    loadState.activation === activation && !(loadState.status === 'ready' && snapshot === null)
      ? loadState
      : {
          activation,
          status: 'loading' as const,
          error: null,
        };
  const entries = snapshot?.entries ?? EMPTY_ENTRIES;
  const counts = useMemo(() => countInboxEntries(entries), [entries]);
  const operationError =
    operationErrorState?.activation === activation ? operationErrorState.message : null;
  const isCommittedConversionSourceArchived = useCallback(
    (expectedWorkspaceId: string, expectedSourceEntryId: string): boolean => {
      const current = activeActivationRef.current;
      if (current.workspaceId !== expectedWorkspaceId) return false;
      const committedSnapshot = inboxSnapshotForActivation(current, storedSnapshotRef.current);
      return (
        committedSnapshot !== null &&
        isInboxConversionSourceArchived(
          expectedWorkspaceId,
          expectedSourceEntryId,
          committedSnapshot,
        )
      );
    },
    [],
  );
  const pendingEntryIds = useMemo(
    () =>
      new Set(
        [...pendingEntryOperations]
          .filter(([, target]) => target === activation)
          .map(([entryId]) => entryId),
      ),
    [activation, pendingEntryOperations],
  );
  const pendingUndoTokens = useMemo(
    () =>
      new Set(
        [...pendingUndoOperations]
          .filter(([, target]) => target === activation)
          .map(([undoToken]) => undoToken),
      ),
    [activation, pendingUndoOperations],
  );

  return {
    activation,
    snapshot,
    entries,
    counts,
    status: snapshot !== null ? ('ready' as const) : visibleLoadState.status,
    loadError: visibleLoadState.error,
    operationError,
    pendingEntryIds,
    pendingCapture: pendingCaptureActivations.has(activation),
    pendingUndoTokens,
    undoNotices,
    refresh: async () => {
      const current = activeActivationRef.current;
      if (current.workspaceId !== null) await load(current);
    },
    prepareSnapshotRefresh,
    isCommittedConversionSourceArchived,
    retry: () => {
      const current = activeActivationRef.current;
      if (current.workspaceId !== null) void load(current).catch(() => undefined);
    },
    reserveSnapshotRequest: (targetWorkspaceId: string) => {
      const current = activeActivationRef.current;
      return current.workspaceId === targetWorkspaceId ? beginRequest(current) : null;
    },
    applyReservedSnapshot: (
      nextSnapshot: InboxSnapshot,
      request: InboxRequestIdentity | null,
    ): boolean => request !== null && applySnapshot(nextSnapshot, request),
    clearOperationError: () =>
      setOperationErrorState((current) => (current?.activation === activation ? null : current)),
    create,
    categorize,
    archive,
    undoArchive,
    dismissUndo: (undoToken: string) =>
      setUndoNotices((current) => current.filter((notice) => notice.undoToken !== undoToken)),
  };
}

function toMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error) || error.message.trim().length === 0) return fallback;
  const message = error.message.replace(/^Error invoking remote method '[^']+':\s*/u, '').trim();
  return message || fallback;
}
