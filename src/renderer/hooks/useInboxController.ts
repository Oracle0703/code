import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type {
  InboxArchiveResult,
  InboxCategory,
  InboxCreateResult,
  InboxEntry,
  InboxSnapshot,
} from '../../shared/contracts';
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
import {
  InboxArchiveCoordinator,
  type InboxArchiveCoordinatorIntent,
} from '../inbox-archive-coordinator';
import {
  createInboxArchiveMutationIntent,
  createInboxUndoMutationIntent,
  inboxUndoMonotonicDeadline,
  reconcileInboxArchiveResult,
  reconcileInboxUndoResult,
  type InboxArchiveMutationIntent,
  type InboxUndoMutationIntent,
} from '../inbox-archive-reconciliation';

export interface InboxUndoNotice {
  readonly undoToken: string;
  readonly workspaceId: string;
  readonly entry: InboxEntry;
  readonly undoExpiresAt: string;
  readonly expiresAtMonotonicMs: number;
  readonly phase: 'archived' | 'archive-recovery' | 'undo-recovery';
  readonly undoAvailable: boolean;
  readonly refreshing: boolean;
  readonly refreshError: string | null;
  readonly focusActionOnMount: boolean;
}

interface InboxUndoNoticeState extends InboxUndoNotice {
  readonly generation: number;
  readonly archiveIntent: InboxArchiveMutationIntent;
  readonly undoIntent: InboxUndoMutationIntent | null;
  readonly resultSnapshot: InboxSnapshot;
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

interface InboxPendingEntryOperation {
  readonly generation: number;
  readonly workspace: InboxWorkspaceIdentity;
}

const EMPTY_ENTRIES: readonly InboxEntry[] = Object.freeze([]);
const INACTIVE_ACTIVATION = Object.freeze(createInboxWorkspaceIdentity(null));
const INBOX_CREATE_RECONCILIATION_ERROR =
  '记录已创建，但当前收件箱未能同步。请重新读取后查看，避免重复添加。';
const INBOX_ARCHIVE_RECONCILIATION_ERROR =
  '记录已经归档，但当前收件箱未能同步。请重新读取确认，避免重复归档。';
const INBOX_UNDO_RECONCILIATION_ERROR =
  '归档已经撤销，但当前收件箱未能同步。请重新读取确认，不要再次撤销。';
const INBOX_ARCHIVE_MUTATION_BLOCKED_ERROR =
  '上一项收件箱归档或撤销仍在确认，请先重新读取完成对账。';

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
    ReadonlyMap<string, InboxPendingEntryOperation>
  >(() => new Map());
  const [pendingCaptureActivations, setPendingCaptureActivations] = useState<
    ReadonlySet<InboxWorkspaceIdentity>
  >(() => new Set());
  const [pendingUndoOperations, setPendingUndoOperations] = useState<
    ReadonlyMap<string, InboxArchiveCoordinatorIntent>
  >(() => new Map());
  const [undoNotices, setUndoNotices] = useState<readonly InboxUndoNoticeState[]>([]);
  const [archiveCoordinator] = useState(() => new InboxArchiveCoordinator());
  const requestSequenceRef = useRef(0);
  const latestRequestSequenceRef = useRef(-1);
  const appliedSequenceRef = useRef(-1);
  const pendingEntryGenerationRef = useRef(0);
  const pendingEntryOperationsRef = useRef(new Map<string, InboxPendingEntryOperation>());
  const pendingCaptureActivationsRef = useRef(new Set<InboxWorkspaceIdentity>());
  const pendingUndoOperationsRef = useRef(new Map<string, InboxArchiveCoordinatorIntent>());
  const undoNoticesRef = useRef<readonly InboxUndoNoticeState[]>([]);
  const undoNoticeGenerationRef = useRef(0);

  const setStored = useCallback((value: InboxSnapshotState | null) => {
    storedSnapshotRef.current = value;
    setStoredSnapshot(value);
  }, []);

  const beginPendingEntry = useCallback(
    (target: InboxWorkspaceIdentity, entryId: string): InboxPendingEntryOperation | null => {
      if (pendingEntryOperationsRef.current.has(entryId)) return null;
      if (pendingEntryGenerationRef.current === Number.MAX_SAFE_INTEGER) {
        throw new RangeError('Inbox pending-entry generation is exhausted.');
      }
      const operation = Object.freeze({
        generation: ++pendingEntryGenerationRef.current,
        workspace: target,
      });
      pendingEntryOperationsRef.current = new Map(pendingEntryOperationsRef.current).set(
        entryId,
        operation,
      );
      setPendingEntryOperations(pendingEntryOperationsRef.current);
      return operation;
    },
    [],
  );

  const endPendingEntry = useCallback(
    (operation: InboxPendingEntryOperation, entryId: string): void => {
      if (pendingEntryOperationsRef.current.get(entryId) !== operation) return;
      const next = new Map(pendingEntryOperationsRef.current);
      next.delete(entryId);
      pendingEntryOperationsRef.current = next;
      setPendingEntryOperations(next);
    },
    [],
  );

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

  const beginPendingUndo = useCallback((intent: InboxArchiveCoordinatorIntent): void => {
    if (intent.undoToken === null) return;
    pendingUndoOperationsRef.current = new Map(pendingUndoOperationsRef.current).set(
      intent.undoToken,
      intent,
    );
    setPendingUndoOperations(pendingUndoOperationsRef.current);
  }, []);

  const endPendingUndo = useCallback((intent: InboxArchiveCoordinatorIntent): void => {
    if (
      intent.undoToken === null ||
      pendingUndoOperationsRef.current.get(intent.undoToken) !== intent
    ) {
      return;
    }
    const next = new Map(pendingUndoOperationsRef.current);
    next.delete(intent.undoToken);
    pendingUndoOperationsRef.current = next;
    setPendingUndoOperations(next);
  }, []);

  const replaceUndoNotices = useCallback(
    (
      update: (current: readonly InboxUndoNoticeState[]) => readonly InboxUndoNoticeState[],
    ): readonly InboxUndoNoticeState[] => {
      const next = update(undoNoticesRef.current);
      undoNoticesRef.current = next;
      setUndoNotices(next);
      return next;
    },
    [],
  );

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
    const expiringNotices = undoNotices.filter(({ undoAvailable }) => undoAvailable);
    if (expiringNotices.length === 0) return;
    const earliest = Math.min(
      ...expiringNotices.map(({ expiresAtMonotonicMs }) => expiresAtMonotonicMs),
    );
    const timeout = window.setTimeout(
      () => {
        const now = window.performance.now();
        replaceUndoNotices((current) =>
          current.flatMap((notice) => {
            if (!notice.undoAvailable || notice.expiresAtMonotonicMs > now) return [notice];
            return notice.phase === 'archived' &&
              !pendingUndoOperationsRef.current.has(notice.undoToken)
              ? []
              : [{ ...notice, undoAvailable: false, focusActionOnMount: true }];
          }),
        );
      },
      Math.max(0, earliest - window.performance.now()) + 25,
    );
    return () => window.clearTimeout(timeout);
  }, [replaceUndoNotices, undoNotices]);

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

  const getCommittedSnapshot = useCallback((expectedWorkspaceId: string): InboxSnapshot | null => {
    const current = activeActivationRef.current;
    if (current.workspaceId !== expectedWorkspaceId) return null;
    return inboxSnapshotForActivation(current, storedSnapshotRef.current);
  }, []);

  const findUndoNotice = useCallback(
    (undoToken: string, generation?: number): InboxUndoNoticeState | null =>
      undoNoticesRef.current.find(
        (notice) =>
          notice.undoToken === undoToken &&
          (generation === undefined || notice.generation === generation),
      ) ?? null,
    [],
  );

  const hasArchiveRecovery = useCallback(
    (expectedWorkspaceId: string | null): boolean =>
      expectedWorkspaceId !== null &&
      undoNoticesRef.current.some(
        ({ workspaceId: noticeWorkspaceId, phase }) =>
          noticeWorkspaceId === expectedWorkspaceId && phase !== 'archived',
      ),
    [],
  );

  const assertArchiveMutationAvailable = useCallback((): void => {
    const workspaceId = activeActivationRef.current.workspaceId;
    if (
      workspaceId === null ||
      archiveCoordinator.isPending(workspaceId) ||
      hasArchiveRecovery(workspaceId)
    ) {
      throw new Error(INBOX_ARCHIVE_MUTATION_BLOCKED_ERROR);
    }
  }, [archiveCoordinator, hasArchiveRecovery]);

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
      if (target.workspaceId === null) return;
      assertArchiveMutationAvailable();
      const pendingEntry = beginPendingEntry(target, entryId);
      if (pendingEntry === null) return;
      const request = beginRequest(target);
      if (!request) {
        endPendingEntry(pendingEntry, entryId);
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
        endPendingEntry(pendingEntry, entryId);
      }
    },
    [
      applySnapshot,
      assertArchiveMutationAvailable,
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
      if (target.workspaceId === null) return;
      assertArchiveMutationAvailable();
      const mutationIntent = createInboxArchiveMutationIntent(target.workspaceId, entry);
      if (undoNoticeGenerationRef.current === Number.MAX_SAFE_INTEGER) {
        throw new RangeError('Inbox undo notice generation is exhausted.');
      }
      const noticeGeneration = ++undoNoticeGenerationRef.current;
      const coordinatorIntent = archiveCoordinator.begin(target, 'archive');
      if (coordinatorIntent === null) {
        throw new Error('这个工作区正在处理另一项收件箱归档或撤销。');
      }
      const pendingEntry = beginPendingEntry(target, mutationIntent.originalEntry.id);
      if (pendingEntry === null) {
        archiveCoordinator.end(coordinatorIntent);
        return;
      }
      const request = beginRequest(target);
      if (!request) {
        endPendingEntry(pendingEntry, mutationIntent.originalEntry.id);
        archiveCoordinator.end(coordinatorIntent);
        return;
      }
      const focusActionOnMount = inboxArchiveActionOwnsFocus(mutationIntent.originalEntry.id);
      clearOperationErrorFor(target);
      try {
        let result: InboxArchiveResult;
        try {
          result = await window.workbench.inbox.archive({
            workspaceId: request.workspaceId,
            entryId: mutationIntent.originalEntry.id,
          });
        } catch (error) {
          throw operationFailure(error, request.workspace, '归档失败，请重试。');
        }

        const reconciliation = await reconcileInboxArchiveResult({
          intent: mutationIntent,
          resultSnapshot: result.snapshot,
          commitResultSnapshot: () => applySnapshot(result.snapshot, request),
          getCommittedSnapshot: () => getCommittedSnapshot(request.workspaceId),
          prepareSnapshotRefresh,
          isCurrent: () =>
            archiveCoordinator.isCurrent(coordinatorIntent, activeActivationRef.current),
        });
        if (!archiveCoordinator.isActive(coordinatorIntent)) return;

        const monotonicNowMs = window.performance.now();
        const expiresAtMonotonicMs =
          inboxUndoMonotonicDeadline(result.undoExpiresAt, Date.now(), monotonicNowMs) ??
          monotonicNowMs;
        let undoIntent: InboxUndoMutationIntent | null = null;
        try {
          undoIntent = createInboxUndoMutationIntent(
            request.workspaceId,
            mutationIntent.originalEntry,
            result.undoToken,
            result.undoExpiresAt,
          );
        } catch {
          // Main has already committed the archive. A malformed undo identity
          // must fail closed without turning the archive into a retryable error.
        }
        const notice: InboxUndoNoticeState = {
          undoToken: result.undoToken,
          workspaceId: request.workspaceId,
          entry: mutationIntent.originalEntry,
          undoExpiresAt: result.undoExpiresAt,
          expiresAtMonotonicMs,
          phase: reconciliation.committed ? 'archived' : 'archive-recovery',
          undoAvailable: undoIntent !== null && expiresAtMonotonicMs > window.performance.now(),
          refreshing: false,
          refreshError: null,
          focusActionOnMount:
            focusActionOnMount && activeActivationRef.current.workspaceId === request.workspaceId,
          generation: noticeGeneration,
          archiveIntent: mutationIntent,
          undoIntent,
          resultSnapshot: result.snapshot,
        };
        replaceUndoNotices((current) => [
          ...current.filter(({ undoToken }) => undoToken !== result.undoToken),
          notice,
        ]);
      } finally {
        endPendingEntry(pendingEntry, mutationIntent.originalEntry.id);
        archiveCoordinator.end(coordinatorIntent);
      }
    },
    [
      applySnapshot,
      archiveCoordinator,
      assertArchiveMutationAvailable,
      beginPendingEntry,
      beginRequest,
      clearOperationErrorFor,
      endPendingEntry,
      getCommittedSnapshot,
      operationFailure,
      prepareSnapshotRefresh,
      replaceUndoNotices,
    ],
  );

  const undoArchive = useCallback(
    async (notice: InboxUndoNotice) => {
      const target = activeActivationRef.current;
      const currentNotice = findUndoNotice(notice.undoToken);
      if (
        target.workspaceId === null ||
        target.workspaceId !== notice.workspaceId ||
        currentNotice === null ||
        currentNotice !== notice ||
        currentNotice.phase === 'undo-recovery' ||
        (currentNotice.phase === 'archived' && hasArchiveRecovery(target.workspaceId)) ||
        !currentNotice.undoAvailable ||
        currentNotice.undoIntent === null
      )
        return;
      if (window.performance.now() >= currentNotice.expiresAtMonotonicMs) {
        replaceUndoNotices((current) =>
          current.flatMap((candidate) =>
            candidate.undoToken !== currentNotice.undoToken ||
            candidate.generation !== currentNotice.generation
              ? [candidate]
              : candidate.phase === 'archived'
                ? []
                : [{ ...candidate, undoAvailable: false, focusActionOnMount: false }],
          ),
        );
        return;
      }
      const coordinatorIntent = archiveCoordinator.begin(target, 'undo', currentNotice.undoToken);
      if (coordinatorIntent === null) return;
      beginPendingUndo(coordinatorIntent);
      replaceUndoNotices((current) =>
        current.map((candidate) =>
          candidate.undoToken === currentNotice.undoToken &&
          candidate.generation === currentNotice.generation
            ? { ...candidate, refreshError: null }
            : candidate,
        ),
      );
      const request = beginRequest(target);
      if (!request) {
        endPendingUndo(coordinatorIntent);
        archiveCoordinator.end(coordinatorIntent);
        return;
      }
      clearOperationErrorFor(target);
      try {
        let result: InboxSnapshot;
        try {
          result = await window.workbench.inbox.undoArchive({
            workspaceId: request.workspaceId,
            undoToken: currentNotice.undoToken,
          });
        } catch (error) {
          const failure = operationFailure(error, request.workspace, '撤销失败或已过期。');
          if (archiveCoordinator.isActive(coordinatorIntent)) {
            replaceUndoNotices((current) =>
              current.map((candidate) =>
                candidate.undoToken === currentNotice.undoToken &&
                candidate.generation === currentNotice.generation
                  ? { ...candidate, refreshError: failure.message }
                  : candidate,
              ),
            );
          }
          throw failure;
        }

        const reconciliation = await reconcileInboxUndoResult({
          intent: currentNotice.undoIntent,
          resultSnapshot: result,
          commitResultSnapshot: () => applySnapshot(result, request),
          getCommittedSnapshot: () => getCommittedSnapshot(request.workspaceId),
          prepareSnapshotRefresh,
          isCurrent: () =>
            archiveCoordinator.isCurrent(coordinatorIntent, activeActivationRef.current),
        });
        if (!archiveCoordinator.isActive(coordinatorIntent)) return;
        replaceUndoNotices((current) =>
          current.flatMap((candidate) => {
            if (
              candidate.undoToken !== currentNotice.undoToken ||
              candidate.generation !== currentNotice.generation
            ) {
              return [candidate];
            }
            if (reconciliation.committed && reconciliation.restoredEntry !== null) return [];
            return [
              {
                ...candidate,
                phase: 'undo-recovery',
                undoAvailable: false,
                refreshing: false,
                refreshError: null,
                focusActionOnMount: true,
                undoIntent: currentNotice.undoIntent,
                resultSnapshot: result,
              },
            ];
          }),
        );
      } finally {
        endPendingUndo(coordinatorIntent);
        archiveCoordinator.end(coordinatorIntent);
      }
    },
    [
      applySnapshot,
      archiveCoordinator,
      beginPendingUndo,
      beginRequest,
      clearOperationErrorFor,
      endPendingUndo,
      findUndoNotice,
      getCommittedSnapshot,
      hasArchiveRecovery,
      operationFailure,
      prepareSnapshotRefresh,
      replaceUndoNotices,
    ],
  );

  const refreshArchiveNotice = useCallback(
    async (notice: InboxUndoNotice): Promise<void> => {
      const target = activeActivationRef.current;
      const currentNotice = findUndoNotice(notice.undoToken);
      if (
        target.workspaceId === null ||
        target.workspaceId !== notice.workspaceId ||
        currentNotice === null ||
        currentNotice !== notice ||
        currentNotice.phase === 'archived'
      ) {
        return;
      }
      const coordinatorIntent = archiveCoordinator.begin(
        target,
        'recover',
        currentNotice.undoIntent?.undoToken ?? null,
      );
      if (coordinatorIntent === null) return;
      replaceUndoNotices((current) =>
        current.map((candidate) =>
          candidate.undoToken === currentNotice.undoToken &&
          candidate.generation === currentNotice.generation
            ? {
                ...candidate,
                refreshing: true,
                refreshError: null,
                focusActionOnMount: false,
              }
            : candidate,
        ),
      );

      const noticeIsCurrent = (): boolean =>
        archiveCoordinator.isCurrent(coordinatorIntent, activeActivationRef.current) &&
        findUndoNotice(currentNotice.undoToken, currentNotice.generation) !== null;
      try {
        const reconciliation =
          currentNotice.phase === 'archive-recovery'
            ? await reconcileInboxArchiveResult({
                intent: currentNotice.archiveIntent,
                resultSnapshot: currentNotice.resultSnapshot,
                commitResultSnapshot: () => false,
                getCommittedSnapshot: () => getCommittedSnapshot(currentNotice.workspaceId),
                prepareSnapshotRefresh,
                isCurrent: noticeIsCurrent,
              })
            : currentNotice.undoIntent === null
              ? null
              : await reconcileInboxUndoResult({
                  intent: currentNotice.undoIntent,
                  resultSnapshot: currentNotice.resultSnapshot,
                  commitResultSnapshot: () => false,
                  getCommittedSnapshot: () => getCommittedSnapshot(currentNotice.workspaceId),
                  prepareSnapshotRefresh,
                  isCurrent: noticeIsCurrent,
                });
        if (!archiveCoordinator.isActive(coordinatorIntent)) return;

        const committed =
          currentNotice.phase === 'archive-recovery'
            ? reconciliation?.committed === true &&
              'confirmed' in reconciliation &&
              reconciliation.confirmed
            : reconciliation?.committed === true &&
              'restoredEntry' in reconciliation &&
              reconciliation.restoredEntry !== null;
        replaceUndoNotices((current) =>
          current.flatMap((candidate) => {
            if (
              candidate.undoToken !== currentNotice.undoToken ||
              candidate.generation !== currentNotice.generation
            ) {
              return [candidate];
            }
            if (!committed) {
              return [
                {
                  ...candidate,
                  refreshing: false,
                  refreshError:
                    currentNotice.phase === 'archive-recovery'
                      ? INBOX_ARCHIVE_RECONCILIATION_ERROR
                      : INBOX_UNDO_RECONCILIATION_ERROR,
                  focusActionOnMount: false,
                },
              ];
            }
            if (currentNotice.phase === 'undo-recovery') return [];
            if (
              !candidate.undoAvailable ||
              window.performance.now() >= candidate.expiresAtMonotonicMs
            ) {
              return [];
            }
            return [
              {
                ...candidate,
                phase: 'archived',
                refreshing: false,
                refreshError: null,
                focusActionOnMount: true,
              },
            ];
          }),
        );
      } finally {
        if (archiveCoordinator.isActive(coordinatorIntent)) {
          const active = activeActivationRef.current;
          if (active.workspaceId !== currentNotice.workspaceId) {
            replaceUndoNotices((current) =>
              current.map((candidate) =>
                candidate.undoToken === currentNotice.undoToken &&
                candidate.generation === currentNotice.generation
                  ? { ...candidate, refreshing: false, focusActionOnMount: false }
                  : candidate,
              ),
            );
          }
        }
        archiveCoordinator.end(coordinatorIntent);
      }
    },
    [
      archiveCoordinator,
      findUndoNotice,
      getCommittedSnapshot,
      prepareSnapshotRefresh,
      replaceUndoNotices,
    ],
  );

  const invalidateArchiveMutations = useCallback((): void => {
    archiveCoordinator.invalidateAll();
    pendingEntryOperationsRef.current = new Map();
    pendingUndoOperationsRef.current = new Map();
    undoNoticesRef.current = [];
    setPendingEntryOperations(pendingEntryOperationsRef.current);
    setPendingUndoOperations(pendingUndoOperationsRef.current);
    setUndoNotices(undoNoticesRef.current);
  }, [archiveCoordinator]);

  const dismissUndo = useCallback(
    (undoToken: string): void => {
      const notice = findUndoNotice(undoToken);
      if (
        notice === null ||
        notice.phase !== 'archived' ||
        hasArchiveRecovery(notice.workspaceId) ||
        (notice.undoIntent !== null &&
          archiveCoordinator.isTokenPending(notice.undoIntent.undoToken))
      ) {
        return;
      }
      replaceUndoNotices((current) =>
        current.filter(
          (candidate) =>
            candidate.undoToken !== notice.undoToken || candidate.generation !== notice.generation,
        ),
      );
    },
    [archiveCoordinator, findUndoNotice, hasArchiveRecovery, replaceUndoNotices],
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
          .filter(([, operation]) => operation.workspace === activation)
          .map(([entryId]) => entryId),
      ),
    [activation, pendingEntryOperations],
  );
  const pendingUndoTokens = useMemo(
    () =>
      new Set(
        [...pendingUndoOperations]
          .filter(([, intent]) => intent.workspaceId === activation.workspaceId)
          .map(([undoToken]) => undoToken),
      ),
    [activation, pendingUndoOperations],
  );
  const archiveRecoveryPending =
    activation.workspaceId !== null &&
    undoNotices.some(
      ({ workspaceId: noticeWorkspaceId, phase }) =>
        noticeWorkspaceId === activation.workspaceId && phase !== 'archived',
    );
  const archiveMutationBlocked =
    archiveCoordinator.isPending(activation.workspaceId) || archiveRecoveryPending;
  const archiveMutationBlockReason = archiveRecoveryPending
    ? INBOX_ARCHIVE_MUTATION_BLOCKED_ERROR
    : archiveMutationBlocked
      ? '正在确认收件箱归档或撤销，请稍候。'
      : null;

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
    archiveOperationPending: archiveCoordinator.isPending(activation.workspaceId),
    archiveRecoveryPending,
    archiveMutationBlocked,
    archiveMutationBlockReason,
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
    refreshArchiveNotice,
    dismissUndo,
    assertArchiveMutationAvailable,
    invalidateArchiveMutations,
  };
}

function toMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error) || error.message.trim().length === 0) return fallback;
  const message = error.message.replace(/^Error invoking remote method '[^']+':\s*/u, '').trim();
  return message || fallback;
}

function inboxArchiveActionOwnsFocus(entryId: string): boolean {
  const active = document.activeElement;
  return active instanceof HTMLButtonElement && active.dataset.inboxArchiveId === entryId;
}
