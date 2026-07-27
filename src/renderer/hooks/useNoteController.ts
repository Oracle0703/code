import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type {
  Note,
  NoteConversionResult,
  NoteCreateResult,
  NoteSnapshot,
} from '../../shared/contracts';
import {
  convertedNoteFromResult,
  convertedNoteFromSnapshot,
  createNoteArchiveMutationIntent,
  createdNoteFromResult,
  createNoteRequestIdentity,
  createNoteUpdateMutationIntent,
  createNoteWorkspaceIdentity,
  isNoteRequestCurrent,
  isNoteRequestLatest,
  noteSnapshotForActivation,
  reconcileNoteArchiveResult,
  reconcileNoteCreateResult,
  reconcileNoteUpdateResult,
  shouldApplyNoteSnapshot,
  type NoteArchiveMutationIntent,
  type NoteMutationSyncWarningTarget,
  type NoteRequestIdentity,
  type NoteSnapshotState,
  type NoteUpdateMutationIntent,
  type NoteWorkspaceIdentity,
} from '../note-state';

type NoteControllerStatus = 'loading' | 'ready' | 'error';

interface NoteLoadState {
  readonly activation: NoteWorkspaceIdentity;
  readonly status: NoteControllerStatus;
  readonly error: string | null;
}

interface NoteOperationError {
  readonly activation: NoteWorkspaceIdentity;
  readonly message: string;
}

type PendingNoteWrite =
  | {
      readonly activation: NoteWorkspaceIdentity;
      readonly kind: 'create';
    }
  | {
      readonly activation: NoteWorkspaceIdentity;
      readonly kind: 'mutation';
      readonly noteId: string;
      readonly operation: 'update' | 'archive' | 'recover';
    }
  | {
      readonly activation: NoteWorkspaceIdentity;
      readonly kind: 'conversion';
      readonly entryId: string;
    };

type PendingNoteWriteInput =
  | { readonly kind: 'create' }
  | {
      readonly kind: 'mutation';
      readonly noteId: string;
      readonly operation: 'update' | 'archive' | 'recover';
    }
  | {
      readonly kind: 'conversion';
      readonly entryId: string;
    };

const EMPTY_NOTES: readonly Note[] = Object.freeze([]);
const INACTIVE_ACTIVATION = Object.freeze(createNoteWorkspaceIdentity(null));
const NOTE_CREATE_RECONCILIATION_ERROR =
  '笔记已创建，但当前笔记列表未能同步。请重新读取后查看，避免重复创建。';
const NOTE_UPDATE_RECONCILIATION_ERROR =
  '笔记已保存，但当前笔记列表未能同步。请重新读取后查看，避免重复保存。';
const NOTE_ARCHIVE_RECONCILIATION_ERROR =
  '笔记已归档，但当前笔记列表未能同步。请重新读取后确认，避免重复归档。';

export interface NoteInboxConversionCommit {
  readonly result: NoteConversionResult;
  readonly createdNote: Note | null;
  readonly committed: boolean;
}

export interface NoteCreateCommit {
  readonly result: NoteCreateResult;
  readonly createdNote: Note | null;
  readonly committed: boolean;
  readonly reconciliationWarning: string | null;
}

export interface NoteUpdateCommit {
  readonly intent: NoteUpdateMutationIntent;
  readonly result: NoteSnapshot;
  readonly updatedNote: Note | null;
  readonly committed: boolean;
  readonly reconciliationWarning: string | null;
}

export interface NoteArchiveCommit {
  readonly intent: NoteArchiveMutationIntent;
  readonly result: NoteSnapshot;
  readonly confirmed: boolean;
  readonly committed: boolean;
  readonly reconciliationWarning: string | null;
}

export type NoteMutationRecovery =
  | {
      readonly kind: 'update';
      readonly updatedNote: Note | null;
      readonly committed: boolean;
    }
  | {
      readonly kind: 'archive';
      readonly confirmed: boolean;
      readonly committed: boolean;
    };

export function useNoteController(workspaceId: string | null) {
  const activation = useMemo(() => createNoteWorkspaceIdentity(workspaceId), [workspaceId]);
  const activeActivationRef = useRef<NoteWorkspaceIdentity>(activation);
  const [storedSnapshot, setStoredSnapshot] = useState<NoteSnapshotState | null>(null);
  const storedSnapshotRef = useRef<NoteSnapshotState | null>(null);
  const [loadState, setLoadState] = useState<NoteLoadState>({
    activation,
    status: 'loading',
    error: null,
  });
  const [operationErrorState, setOperationErrorState] = useState<NoteOperationError | null>(null);
  const [pendingWrites, setPendingWrites] = useState<ReadonlyMap<string, PendingNoteWrite>>(
    () => new Map(),
  );
  const requestSequenceRef = useRef(0);
  const latestRequestSequenceRef = useRef(-1);
  const appliedSequenceRef = useRef(-1);
  const pendingWritesRef = useRef(new Map<string, PendingNoteWrite>());

  const setStored = useCallback((value: NoteSnapshotState | null) => {
    storedSnapshotRef.current = value;
    setStoredSnapshot(value);
  }, []);

  const beginRequest = useCallback((target: NoteWorkspaceIdentity): NoteRequestIdentity | null => {
    if (target.workspaceId === null) return null;
    const sequence = ++requestSequenceRef.current;
    latestRequestSequenceRef.current = sequence;
    return createNoteRequestIdentity(target, sequence);
  }, []);

  const requestIsCurrent = useCallback(
    (request: NoteRequestIdentity): boolean =>
      isNoteRequestCurrent(activeActivationRef.current, request),
    [],
  );

  const applySnapshot = useCallback(
    (snapshot: NoteSnapshot, request: NoteRequestIdentity): boolean => {
      if (
        !shouldApplyNoteSnapshot(
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
    async (target: NoteWorkspaceIdentity): Promise<void> => {
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
          await window.workbench.note.getSnapshot({ workspaceId: request.workspaceId }),
          request,
        );
      } catch (error) {
        if (
          requestIsCurrent(request) &&
          isNoteRequestLatest(request.sequence, latestRequestSequenceRef.current)
        ) {
          setStored(null);
          setLoadState({
            activation: request.workspace,
            status: 'error',
            error: toMessage(error, '笔记暂时无法读取。'),
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
    if (!request) throw new Error('当前工作区不可用，无法读取笔记。');
    const snapshot = await window.workbench.note.getSnapshot({
      workspaceId: request.workspaceId,
    });
    return {
      snapshot,
      commit: () =>
        isNoteRequestLatest(request.sequence, latestRequestSequenceRef.current) &&
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

  const beginPendingWrite = useCallback(
    (target: NoteWorkspaceIdentity, pending: PendingNoteWriteInput): PendingNoteWrite | null => {
      if (target.workspaceId === null || pendingWritesRef.current.has(target.workspaceId)) {
        return null;
      }
      const token = Object.freeze({ ...pending, activation: target }) as PendingNoteWrite;
      pendingWritesRef.current = new Map(pendingWritesRef.current).set(target.workspaceId, token);
      setPendingWrites(pendingWritesRef.current);
      return token;
    },
    [],
  );

  const endPendingWrite = useCallback((token: PendingNoteWrite): void => {
    const workspaceId = token.activation.workspaceId;
    if (workspaceId === null || pendingWritesRef.current.get(workspaceId) !== token) return;
    const next = new Map(pendingWritesRef.current);
    next.delete(workspaceId);
    pendingWritesRef.current = next;
    setPendingWrites(next);
  }, []);

  const operationFailure = useCallback(
    (
      error: unknown,
      target: NoteWorkspaceIdentity,
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
    async (title: string, body: string): Promise<NoteCreateCommit> => {
      const target = activeActivationRef.current;
      const pending = beginPendingWrite(target, { kind: 'create' });
      if (target.workspaceId === null || pending === null) {
        throw new Error('这个工作区正在创建另一篇笔记。');
      }
      const request = beginRequest(target);
      if (!request) {
        endPendingWrite(pending);
        throw new Error('当前工作区不可用，无法创建笔记。');
      }
      setOperationErrorState(null);
      try {
        let result: NoteCreateResult;
        try {
          result = await window.workbench.note.create({
            workspaceId: request.workspaceId,
            title,
            body,
          });
        } catch (error) {
          throw operationFailure(error, request.workspace, '笔记创建失败，请重试。');
        }

        const reconciliation = await reconcileNoteCreateResult({
          expectedWorkspaceId: request.workspaceId,
          result,
          commitResultSnapshot: () => applySnapshot(result.noteSnapshot, request),
          getCommittedNote: () => {
            const currentSnapshot = noteSnapshotForActivation(
              request.workspace,
              storedSnapshotRef.current,
            );
            return currentSnapshot
              ? createdNoteFromResult(request.workspaceId, {
                  noteSnapshot: currentSnapshot,
                  createdNoteId: result.createdNoteId,
                })
              : null;
          },
          prepareSnapshotRefresh,
          isCurrent: () => requestIsCurrent(request),
        });

        return {
          result,
          createdNote: reconciliation.createdNote,
          committed: reconciliation.committed,
          reconciliationWarning:
            !reconciliation.committed && requestIsCurrent(request)
              ? NOTE_CREATE_RECONCILIATION_ERROR
              : null,
        };
      } finally {
        endPendingWrite(pending);
      }
    },
    [
      applySnapshot,
      beginPendingWrite,
      beginRequest,
      endPendingWrite,
      operationFailure,
      prepareSnapshotRefresh,
      requestIsCurrent,
    ],
  );

  const recoverCreatedNote = useCallback(
    async (result: NoteCreateResult): Promise<Note | null> => {
      const target = activeActivationRef.current;
      if (target.workspaceId === null || result.noteSnapshot.workspaceId !== target.workspaceId) {
        return null;
      }

      try {
        const refresh = await prepareSnapshotRefresh();
        if (
          activeActivationRef.current !== target ||
          refresh.snapshot.workspaceId !== target.workspaceId
        ) {
          return null;
        }
        const createdNote = createdNoteFromResult(target.workspaceId, {
          noteSnapshot: refresh.snapshot,
          createdNoteId: result.createdNoteId,
        });
        if (!createdNote || !refresh.commit()) return null;

        const committedSnapshot = noteSnapshotForActivation(target, storedSnapshotRef.current);
        return committedSnapshot
          ? createdNoteFromResult(target.workspaceId, {
              noteSnapshot: committedSnapshot,
              createdNoteId: result.createdNoteId,
            })
          : null;
      } catch {
        return null;
      }
    },
    [prepareSnapshotRefresh],
  );

  const update = useCallback(
    async (note: Note, title: string, body: string): Promise<NoteUpdateCommit> => {
      const target = activeActivationRef.current;
      if (target.workspaceId === null) {
        throw new Error('当前工作区不可用，无法保存笔记。');
      }
      const intent = createNoteUpdateMutationIntent(target.workspaceId, note, title, body);
      const pending = beginPendingWrite(target, {
        kind: 'mutation',
        noteId: intent.originalNote.id,
        operation: 'update',
      });
      if (pending === null) {
        throw new Error('这个工作区正在处理另一项笔记写入。');
      }
      const request = beginRequest(target);
      if (!request) {
        endPendingWrite(pending);
        throw new Error('当前工作区不可用，无法保存笔记。');
      }
      setOperationErrorState(null);
      try {
        let result: NoteSnapshot;
        try {
          result = await window.workbench.note.update({
            workspaceId: request.workspaceId,
            noteId: intent.originalNote.id,
            title: intent.title,
            body: intent.body,
            expectedRevision: intent.originalNote.revision,
          });
        } catch (error) {
          throw operationFailure(
            error,
            request.workspace,
            '笔记保存失败，可能已在其他操作中更新。',
          );
        }

        const reconciliation = await reconcileNoteUpdateResult({
          intent,
          resultSnapshot: result,
          commitResultSnapshot: () => applySnapshot(result, request),
          getCommittedSnapshot: () =>
            noteSnapshotForActivation(request.workspace, storedSnapshotRef.current),
          prepareSnapshotRefresh,
          isCurrent: () => requestIsCurrent(request),
        });

        return {
          intent,
          result,
          updatedNote: reconciliation.authoritativeNote,
          committed: reconciliation.committed,
          reconciliationWarning: reconciliation.committed ? null : NOTE_UPDATE_RECONCILIATION_ERROR,
        };
      } finally {
        endPendingWrite(pending);
      }
    },
    [
      applySnapshot,
      beginPendingWrite,
      beginRequest,
      endPendingWrite,
      operationFailure,
      prepareSnapshotRefresh,
      requestIsCurrent,
    ],
  );

  const archive = useCallback(
    async (note: Note): Promise<NoteArchiveCommit> => {
      const target = activeActivationRef.current;
      if (target.workspaceId === null) {
        throw new Error('当前工作区不可用，无法归档笔记。');
      }
      const intent = createNoteArchiveMutationIntent(target.workspaceId, note);
      const pending = beginPendingWrite(target, {
        kind: 'mutation',
        noteId: intent.originalNote.id,
        operation: 'archive',
      });
      if (pending === null) {
        throw new Error('这个工作区正在处理另一项笔记写入。');
      }
      const request = beginRequest(target);
      if (!request) {
        endPendingWrite(pending);
        throw new Error('当前工作区不可用，无法归档笔记。');
      }
      setOperationErrorState(null);
      try {
        let result: NoteSnapshot;
        try {
          result = await window.workbench.note.archive({
            workspaceId: request.workspaceId,
            noteId: intent.originalNote.id,
            expectedRevision: intent.originalNote.revision,
          });
        } catch (error) {
          throw operationFailure(error, request.workspace, '笔记归档失败，请重试。');
        }

        const reconciliation = await reconcileNoteArchiveResult({
          intent,
          resultSnapshot: result,
          commitResultSnapshot: () => applySnapshot(result, request),
          getCommittedSnapshot: () =>
            noteSnapshotForActivation(request.workspace, storedSnapshotRef.current),
          prepareSnapshotRefresh,
          isCurrent: () => requestIsCurrent(request),
        });

        return {
          intent,
          result,
          confirmed: reconciliation.confirmed,
          committed: reconciliation.committed,
          reconciliationWarning: reconciliation.committed
            ? null
            : NOTE_ARCHIVE_RECONCILIATION_ERROR,
        };
      } finally {
        endPendingWrite(pending);
      }
    },
    [
      applySnapshot,
      beginPendingWrite,
      beginRequest,
      endPendingWrite,
      operationFailure,
      prepareSnapshotRefresh,
      requestIsCurrent,
    ],
  );

  const recoverNoteMutation = useCallback(
    async (warning: NoteMutationSyncWarningTarget): Promise<NoteMutationRecovery> => {
      const target = activeActivationRef.current;
      if (
        target.workspaceId === null ||
        target.workspaceId !== warning.intent.expectedWorkspaceId
      ) {
        return warning.kind === 'update'
          ? { kind: 'update', updatedNote: null, committed: false }
          : { kind: 'archive', confirmed: false, committed: false };
      }
      const pending = beginPendingWrite(target, {
        kind: 'mutation',
        noteId: warning.intent.originalNote.id,
        operation: 'recover',
      });
      if (pending === null) {
        throw new Error('这个工作区正在处理另一项笔记写入。');
      }

      try {
        const reconciliationInput = {
          resultSnapshot: warning.resultSnapshot,
          commitResultSnapshot: () => false,
          getCommittedSnapshot: () => noteSnapshotForActivation(target, storedSnapshotRef.current),
          prepareSnapshotRefresh,
          isCurrent: () => activeActivationRef.current === target,
        };
        if (warning.kind === 'update') {
          const reconciliation = await reconcileNoteUpdateResult({
            ...reconciliationInput,
            intent: warning.intent,
          });
          return {
            kind: 'update',
            updatedNote: reconciliation.authoritativeNote,
            committed: reconciliation.committed,
          };
        }
        const reconciliation = await reconcileNoteArchiveResult({
          ...reconciliationInput,
          intent: warning.intent,
        });
        return {
          kind: 'archive',
          confirmed: reconciliation.confirmed,
          committed: reconciliation.committed,
        };
      } finally {
        endPendingWrite(pending);
      }
    },
    [beginPendingWrite, endPendingWrite, prepareSnapshotRefresh],
  );

  const convertInbox = useCallback(
    async (
      entryId: string,
      shouldPublishFailure: () => boolean,
    ): Promise<NoteInboxConversionCommit> => {
      const target = activeActivationRef.current;
      const pending = beginPendingWrite(target, { kind: 'conversion', entryId });
      if (target.workspaceId === null || pending === null) {
        throw new Error('这条记录正在转换。');
      }
      const request = beginRequest(target);
      if (!request) {
        endPendingWrite(pending);
        throw new Error('当前工作区不可用，无法转换记录。');
      }
      setOperationErrorState(null);
      try {
        let result: NoteConversionResult;
        try {
          result = await window.workbench.note.convertInbox({
            workspaceId: request.workspaceId,
            entryId,
          });
        } catch (error) {
          throw operationFailure(
            error,
            request.workspace,
            '无法转换为笔记，请重试。',
            shouldPublishFailure,
          );
        }
        const createdNote = convertedNoteFromResult(request.workspaceId, entryId, result);
        const committed = createdNote !== null && applySnapshot(result.noteSnapshot, request);
        return { result, createdNote, committed };
      } finally {
        endPendingWrite(pending);
      }
    },
    [applySnapshot, beginPendingWrite, beginRequest, endPendingWrite, operationFailure],
  );

  const getCommittedConvertedNote = useCallback(
    (
      expectedWorkspaceId: string,
      expectedSourceEntryId: string,
      expectedCreatedNoteId: string,
    ): Note | null => {
      const current = activeActivationRef.current;
      if (current.workspaceId !== expectedWorkspaceId) return null;
      const committedSnapshot = noteSnapshotForActivation(current, storedSnapshotRef.current);
      return committedSnapshot
        ? convertedNoteFromSnapshot(
            expectedWorkspaceId,
            expectedSourceEntryId,
            expectedCreatedNoteId,
            committedSnapshot,
          )
        : null;
    },
    [],
  );

  const getCommittedSnapshot = useCallback((expectedWorkspaceId: string): NoteSnapshot | null => {
    const current = activeActivationRef.current;
    if (current.workspaceId !== expectedWorkspaceId) return null;
    return noteSnapshotForActivation(current, storedSnapshotRef.current);
  }, []);

  const snapshot = noteSnapshotForActivation(activation, storedSnapshot);
  const visibleLoadState =
    loadState.activation === activation && !(loadState.status === 'ready' && snapshot === null)
      ? loadState
      : {
          activation,
          status: 'loading' as const,
          error: null,
        };
  const pendingWrite =
    activation.workspaceId === null ? undefined : pendingWrites.get(activation.workspaceId);
  const pendingNoteIds = useMemo(
    () => (pendingWrite?.kind === 'mutation' ? new Set([pendingWrite.noteId]) : new Set<string>()),
    [pendingWrite],
  );
  const pendingConversionEntryIds = useMemo(
    () =>
      pendingWrite?.kind === 'conversion' ? new Set([pendingWrite.entryId]) : new Set<string>(),
    [pendingWrite],
  );
  const operationErrorMessage =
    operationErrorState?.activation === activation ? operationErrorState.message : null;

  return {
    snapshot,
    notes: snapshot?.notes ?? EMPTY_NOTES,
    status: snapshot !== null ? ('ready' as const) : visibleLoadState.status,
    loadError: visibleLoadState.error,
    operationError: operationErrorMessage,
    pendingNoteIds,
    pendingCreate: pendingWrite?.kind === 'create',
    pendingMutation: pendingWrite?.kind === 'mutation',
    pendingConversionEntryIds,
    retry: () => {
      const current = activeActivationRef.current;
      if (current.workspaceId !== null) void load(current).catch(() => undefined);
    },
    refresh: async () => {
      const current = activeActivationRef.current;
      if (current.workspaceId !== null) await load(current);
    },
    prepareSnapshotRefresh,
    getCommittedSnapshot,
    getCommittedConvertedNote,
    clearOperationError: () =>
      setOperationErrorState((current) => (current?.activation === activation ? null : current)),
    create,
    recoverCreatedNote,
    update,
    archive,
    recoverNoteMutation,
    convertInbox,
  };
}

function toMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error) || error.message.trim().length === 0) return fallback;
  const message = error.message.replace(/^Error invoking remote method '[^']+':\s*/u, '').trim();
  return message || fallback;
}
