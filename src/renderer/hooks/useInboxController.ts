import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { InboxCategory, InboxEntry, InboxSnapshot } from '../../shared/contracts';
import { INBOX_UNDO_WINDOW_MS } from '../../shared/inbox-domain';
import {
  countInboxEntries,
  isInboxRequestLatest,
  isInboxSequenceCurrent,
  isInboxWorkspaceCurrent,
} from '../inbox-state';

export interface InboxUndoNotice {
  readonly undoToken: string;
  readonly workspaceId: string;
  readonly content: string;
  readonly expiresAtMonotonicMs: number;
}

type InboxStatus = 'loading' | 'ready' | 'error';
const EMPTY_ENTRIES: readonly InboxEntry[] = Object.freeze([]);

export function useInboxController(workspaceId: string | null) {
  const [storedSnapshot, setStoredSnapshot] = useState<InboxSnapshot | null>(null);
  const [status, setStatus] = useState<InboxStatus>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [operationErrorState, setOperationErrorState] = useState<{
    readonly workspaceId: string;
    readonly message: string;
  } | null>(null);
  const [pendingEntryIds, setPendingEntryIds] = useState<ReadonlySet<string>>(() => new Set());
  const [pendingCaptureWorkspaces, setPendingCaptureWorkspaces] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [pendingUndoTokens, setPendingUndoTokens] = useState<ReadonlySet<string>>(() => new Set());
  const [undoNotices, setUndoNotices] = useState<readonly InboxUndoNotice[]>([]);
  const activeWorkspaceRef = useRef(workspaceId);
  const requestSequenceRef = useRef(0);
  const latestRequestSequenceRef = useRef(new Map<string, number>());
  const appliedSequenceRef = useRef(new Map<string, number>());
  const pendingCaptureWorkspacesRef = useRef(new Set<string>());
  const pendingEntryIdsRef = useRef(new Set<string>());
  const pendingUndoTokensRef = useRef(new Set<string>());

  const beginPendingEntry = useCallback((entryId: string): boolean => {
    if (pendingEntryIdsRef.current.has(entryId)) return false;
    pendingEntryIdsRef.current = new Set(pendingEntryIdsRef.current).add(entryId);
    setPendingEntryIds(pendingEntryIdsRef.current);
    return true;
  }, []);

  const beginPendingCapture = useCallback((targetWorkspaceId: string): boolean => {
    if (pendingCaptureWorkspacesRef.current.has(targetWorkspaceId)) return false;
    pendingCaptureWorkspacesRef.current = new Set(pendingCaptureWorkspacesRef.current).add(
      targetWorkspaceId,
    );
    setPendingCaptureWorkspaces(pendingCaptureWorkspacesRef.current);
    return true;
  }, []);

  const endPendingCapture = useCallback((targetWorkspaceId: string): void => {
    const next = new Set(pendingCaptureWorkspacesRef.current);
    next.delete(targetWorkspaceId);
    pendingCaptureWorkspacesRef.current = next;
    setPendingCaptureWorkspaces(next);
  }, []);

  const endPendingEntry = useCallback((entryId: string): void => {
    const next = new Set(pendingEntryIdsRef.current);
    next.delete(entryId);
    pendingEntryIdsRef.current = next;
    setPendingEntryIds(next);
  }, []);

  const beginPendingUndo = useCallback((undoToken: string): boolean => {
    if (pendingUndoTokensRef.current.has(undoToken)) return false;
    pendingUndoTokensRef.current = new Set(pendingUndoTokensRef.current).add(undoToken);
    setPendingUndoTokens(pendingUndoTokensRef.current);
    return true;
  }, []);

  const endPendingUndo = useCallback((undoToken: string): void => {
    const next = new Set(pendingUndoTokensRef.current);
    next.delete(undoToken);
    pendingUndoTokensRef.current = next;
    setPendingUndoTokens(next);
  }, []);

  const beginRequest = useCallback((targetWorkspaceId: string): number => {
    const sequence = ++requestSequenceRef.current;
    latestRequestSequenceRef.current.set(targetWorkspaceId, sequence);
    return sequence;
  }, []);

  const applySnapshot = useCallback((snapshot: InboxSnapshot, sequence: number) => {
    const lastApplied = appliedSequenceRef.current.get(snapshot.workspaceId) ?? -1;
    if (!isInboxSequenceCurrent(sequence, lastApplied)) return;
    appliedSequenceRef.current.set(snapshot.workspaceId, sequence);
    if (!isInboxWorkspaceCurrent(activeWorkspaceRef.current, snapshot)) return;
    setStoredSnapshot(snapshot);
    setStatus('ready');
    setLoadError(null);
  }, []);

  const load = useCallback(
    async (targetWorkspaceId: string) => {
      const sequence = beginRequest(targetWorkspaceId);
      if (activeWorkspaceRef.current === targetWorkspaceId) {
        setStatus('loading');
        setLoadError(null);
      }
      try {
        const snapshot = await window.workbench.inbox.getSnapshot({
          workspaceId: targetWorkspaceId,
        });
        applySnapshot(snapshot, sequence);
      } catch (error) {
        const latestRequested = latestRequestSequenceRef.current.get(targetWorkspaceId) ?? -1;
        if (
          isInboxRequestLatest(sequence, latestRequested) &&
          activeWorkspaceRef.current === targetWorkspaceId
        ) {
          setStoredSnapshot(null);
          setStatus('error');
          setLoadError(toMessage(error, '收件箱暂时无法读取。'));
        }
      }
    },
    [applySnapshot, beginRequest],
  );

  useEffect(() => {
    activeWorkspaceRef.current = workspaceId;
    if (workspaceId) void load(workspaceId);
  }, [workspaceId, load]);

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

  const create = useCallback(
    async (targetWorkspaceId: string, content: string, category: InboxCategory) => {
      if (!beginPendingCapture(targetWorkspaceId)) {
        throw new Error('这个工作区正在保存另一条快速记录。');
      }
      const sequence = beginRequest(targetWorkspaceId);
      setOperationErrorState(null);
      try {
        const snapshot = await window.workbench.inbox.create({
          workspaceId: targetWorkspaceId,
          content,
          category,
        });
        applySnapshot(snapshot, sequence);
      } catch (error) {
        const message = toMessage(error, '快速记录失败，请重试。');
        setOperationErrorState({ workspaceId: targetWorkspaceId, message });
        throw new Error(message, { cause: error });
      } finally {
        endPendingCapture(targetWorkspaceId);
      }
    },
    [applySnapshot, beginPendingCapture, beginRequest, endPendingCapture],
  );

  const categorize = useCallback(
    async (entryId: string, category: InboxCategory) => {
      const targetWorkspaceId = activeWorkspaceRef.current;
      if (!targetWorkspaceId || !beginPendingEntry(entryId)) return;
      const sequence = beginRequest(targetWorkspaceId);
      setOperationErrorState(null);
      try {
        const snapshot = await window.workbench.inbox.categorize({
          workspaceId: targetWorkspaceId,
          entryId,
          category,
        });
        applySnapshot(snapshot, sequence);
      } catch (error) {
        const message = toMessage(error, '分类更新失败，请重试。');
        setOperationErrorState({ workspaceId: targetWorkspaceId, message });
        throw new Error(message, { cause: error });
      } finally {
        endPendingEntry(entryId);
      }
    },
    [applySnapshot, beginPendingEntry, beginRequest, endPendingEntry],
  );

  const archive = useCallback(
    async (entry: InboxEntry) => {
      const targetWorkspaceId = activeWorkspaceRef.current;
      if (!targetWorkspaceId || !beginPendingEntry(entry.id)) return;
      const sequence = beginRequest(targetWorkspaceId);
      setOperationErrorState(null);
      try {
        const result = await window.workbench.inbox.archive({
          workspaceId: targetWorkspaceId,
          entryId: entry.id,
        });
        applySnapshot(result.snapshot, sequence);
        setUndoNotices((current) => [
          ...current.filter(({ undoToken }) => undoToken !== result.undoToken),
          {
            undoToken: result.undoToken,
            workspaceId: targetWorkspaceId,
            content: entry.content,
            expiresAtMonotonicMs: window.performance.now() + INBOX_UNDO_WINDOW_MS,
          },
        ]);
      } catch (error) {
        const message = toMessage(error, '归档失败，请重试。');
        setOperationErrorState({ workspaceId: targetWorkspaceId, message });
        throw new Error(message, { cause: error });
      } finally {
        endPendingEntry(entry.id);
      }
    },
    [applySnapshot, beginPendingEntry, beginRequest, endPendingEntry],
  );

  const undoArchive = useCallback(
    async (notice: InboxUndoNotice) => {
      if (!beginPendingUndo(notice.undoToken)) return;
      const sequence = beginRequest(notice.workspaceId);
      setOperationErrorState(null);
      try {
        const snapshot = await window.workbench.inbox.undoArchive({
          workspaceId: notice.workspaceId,
          undoToken: notice.undoToken,
        });
        applySnapshot(snapshot, sequence);
        setUndoNotices((current) =>
          current.filter(({ undoToken }) => undoToken !== notice.undoToken),
        );
      } catch (error) {
        const message = toMessage(error, '撤销失败或已过期。');
        setOperationErrorState({ workspaceId: notice.workspaceId, message });
        throw new Error(message, { cause: error });
      } finally {
        endPendingUndo(notice.undoToken);
      }
    },
    [applySnapshot, beginPendingUndo, beginRequest, endPendingUndo],
  );

  const snapshot =
    storedSnapshot?.workspaceId === workspaceId && workspaceId !== null ? storedSnapshot : null;
  const entries = snapshot?.entries ?? EMPTY_ENTRIES;
  const counts = useMemo(() => countInboxEntries(entries), [entries]);
  const operationError =
    operationErrorState?.workspaceId === workspaceId ? operationErrorState.message : null;

  return {
    snapshot,
    entries,
    counts,
    status: snapshot ? ('ready' as const) : status,
    loadError,
    operationError,
    pendingEntryIds,
    pendingCapture: workspaceId ? pendingCaptureWorkspaces.has(workspaceId) : false,
    pendingUndoTokens,
    undoNotices,
    refresh: async () => {
      if (workspaceId) await load(workspaceId);
    },
    retry: () => {
      if (workspaceId) void load(workspaceId);
    },
    reserveSnapshotRequest: (targetWorkspaceId: string) => beginRequest(targetWorkspaceId),
    applyReservedSnapshot: (nextSnapshot: InboxSnapshot, sequence: number) =>
      applySnapshot(nextSnapshot, sequence),
    clearOperationError: () => setOperationErrorState(null),
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
