import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type {
  Note,
  NoteConversionResult,
  NoteCreateResult,
  NoteSnapshot,
} from '../../shared/contracts';
import {
  beginPendingNoteCreate,
  convertedNoteFromResult,
  convertedNoteFromSnapshot,
  createdNoteFromResult,
  createNoteRequestIdentity,
  createNoteWorkspaceIdentity,
  endPendingNoteCreate,
  isNoteRequestCurrent,
  isNoteRequestLatest,
  noteSnapshotForActivation,
  reconcileNoteCreateResult,
  shouldApplyNoteSnapshot,
  type NoteRequestIdentity,
  type NoteSnapshotState,
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

const EMPTY_NOTES: readonly Note[] = Object.freeze([]);
const INACTIVE_ACTIVATION = Object.freeze(createNoteWorkspaceIdentity(null));
const NOTE_CREATE_RECONCILIATION_ERROR =
  '笔记已创建，但当前笔记列表未能同步。请重新读取后查看，避免重复创建。';

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
  const [pendingNoteOperations, setPendingNoteOperations] = useState<
    ReadonlyMap<string, NoteWorkspaceIdentity>
  >(() => new Map());
  const [pendingCreateWorkspaceIds, setPendingCreateWorkspaceIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [pendingConversionOperations, setPendingConversionOperations] = useState<
    ReadonlyMap<string, NoteWorkspaceIdentity>
  >(() => new Map());
  const requestSequenceRef = useRef(0);
  const latestRequestSequenceRef = useRef(-1);
  const appliedSequenceRef = useRef(-1);
  const pendingNoteOperationsRef = useRef(new Map<string, NoteWorkspaceIdentity>());
  const pendingCreateWorkspaceIdsRef = useRef(new Set<string>());
  const pendingConversionOperationsRef = useRef(new Map<string, NoteWorkspaceIdentity>());

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

  const beginPendingNote = useCallback((target: NoteWorkspaceIdentity, noteId: string): boolean => {
    if (pendingNoteOperationsRef.current.get(noteId) === target) return false;
    pendingNoteOperationsRef.current = new Map(pendingNoteOperationsRef.current).set(
      noteId,
      target,
    );
    setPendingNoteOperations(pendingNoteOperationsRef.current);
    return true;
  }, []);

  const endPendingNote = useCallback((target: NoteWorkspaceIdentity, noteId: string): void => {
    if (pendingNoteOperationsRef.current.get(noteId) !== target) return;
    const next = new Map(pendingNoteOperationsRef.current);
    next.delete(noteId);
    pendingNoteOperationsRef.current = next;
    setPendingNoteOperations(next);
  }, []);

  const beginPendingCreate = useCallback((target: NoteWorkspaceIdentity): boolean => {
    const next = beginPendingNoteCreate(pendingCreateWorkspaceIdsRef.current, target.workspaceId);
    if (next === null) return false;
    pendingCreateWorkspaceIdsRef.current = new Set(next);
    setPendingCreateWorkspaceIds(next);
    return true;
  }, []);

  const endPendingCreate = useCallback((target: NoteWorkspaceIdentity): void => {
    const next = endPendingNoteCreate(pendingCreateWorkspaceIdsRef.current, target.workspaceId);
    if (next === pendingCreateWorkspaceIdsRef.current) return;
    pendingCreateWorkspaceIdsRef.current = new Set(next);
    setPendingCreateWorkspaceIds(next);
  }, []);

  const beginPendingConversion = useCallback(
    (target: NoteWorkspaceIdentity, entryId: string): boolean => {
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
    (target: NoteWorkspaceIdentity, entryId: string): void => {
      if (pendingConversionOperationsRef.current.get(entryId) !== target) return;
      const next = new Map(pendingConversionOperationsRef.current);
      next.delete(entryId);
      pendingConversionOperationsRef.current = next;
      setPendingConversionOperations(next);
    },
    [],
  );

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
      if (target.workspaceId === null || !beginPendingCreate(target)) {
        throw new Error('这个工作区正在创建另一篇笔记。');
      }
      const request = beginRequest(target);
      if (!request) {
        endPendingCreate(target);
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
    async (note: Note, title: string, body: string): Promise<Note> => {
      const target = activeActivationRef.current;
      if (target.workspaceId === null || !beginPendingNote(target, note.id)) {
        throw new Error('这篇笔记正在保存。');
      }
      const request = beginRequest(target);
      if (!request) {
        endPendingNote(target, note.id);
        throw new Error('当前工作区不可用，无法保存笔记。');
      }
      setOperationErrorState(null);
      try {
        const snapshot = await window.workbench.note.update({
          workspaceId: request.workspaceId,
          noteId: note.id,
          title,
          body,
          expectedRevision: note.revision,
        });
        applySnapshot(snapshot, request);
        const updated =
          snapshot.workspaceId === request.workspaceId
            ? snapshot.notes.find(({ id }) => id === note.id)
            : undefined;
        if (!updated) throw new Error('The updated note was not returned.');
        return updated;
      } catch (error) {
        throw operationFailure(error, request.workspace, '笔记保存失败，可能已在其他操作中更新。');
      } finally {
        endPendingNote(request.workspace, note.id);
      }
    },
    [applySnapshot, beginPendingNote, beginRequest, endPendingNote, operationFailure],
  );

  const archive = useCallback(
    async (note: Note): Promise<void> => {
      const target = activeActivationRef.current;
      if (target.workspaceId === null || !beginPendingNote(target, note.id)) return;
      const request = beginRequest(target);
      if (!request) {
        endPendingNote(target, note.id);
        return;
      }
      setOperationErrorState(null);
      try {
        applySnapshot(
          await window.workbench.note.archive({
            workspaceId: request.workspaceId,
            noteId: note.id,
            expectedRevision: note.revision,
          }),
          request,
        );
      } catch (error) {
        throw operationFailure(error, request.workspace, '笔记归档失败，请重试。');
      } finally {
        endPendingNote(request.workspace, note.id);
      }
    },
    [applySnapshot, beginPendingNote, beginRequest, endPendingNote, operationFailure],
  );

  const convertInbox = useCallback(
    async (
      entryId: string,
      shouldPublishFailure: () => boolean,
    ): Promise<NoteInboxConversionCommit> => {
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
        endPendingConversion(request.workspace, entryId);
      }
    },
    [applySnapshot, beginPendingConversion, beginRequest, endPendingConversion, operationFailure],
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
  const pendingNoteIds = useMemo(
    () =>
      new Set(
        [...pendingNoteOperations]
          .filter(([, target]) => target === activation)
          .map(([noteId]) => noteId),
      ),
    [activation, pendingNoteOperations],
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
    notes: snapshot?.notes ?? EMPTY_NOTES,
    status: snapshot !== null ? ('ready' as const) : visibleLoadState.status,
    loadError: visibleLoadState.error,
    operationError: operationErrorMessage,
    pendingNoteIds,
    pendingCreate:
      activation.workspaceId !== null && pendingCreateWorkspaceIds.has(activation.workspaceId),
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
    convertInbox,
  };
}

function toMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error) || error.message.trim().length === 0) return fallback;
  const message = error.message.replace(/^Error invoking remote method '[^']+':\s*/u, '').trim();
  return message || fallback;
}
