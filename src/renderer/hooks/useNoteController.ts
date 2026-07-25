import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Note, NoteConversionResult, NoteSnapshot } from '../../shared/contracts';
import {
  createdNoteFromResult,
  createNoteRequestIdentity,
  createNoteWorkspaceIdentity,
  isNoteRequestCurrent,
  isNoteRequestLatest,
  noteSnapshotForActivation,
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

export function useNoteController(workspaceId: string | null) {
  const activation = useMemo(() => createNoteWorkspaceIdentity(workspaceId), [workspaceId]);
  const activeActivationRef = useRef<NoteWorkspaceIdentity>(activation);
  const [storedSnapshot, setStoredSnapshot] = useState<NoteSnapshotState | null>(null);
  const [loadState, setLoadState] = useState<NoteLoadState>({
    activation,
    status: 'loading',
    error: null,
  });
  const [operationErrorState, setOperationErrorState] = useState<NoteOperationError | null>(null);
  const [pendingNoteOperations, setPendingNoteOperations] = useState<
    ReadonlyMap<string, NoteWorkspaceIdentity>
  >(() => new Map());
  const [pendingCreateActivations, setPendingCreateActivations] = useState<
    ReadonlySet<NoteWorkspaceIdentity>
  >(() => new Set());
  const [pendingConversionOperations, setPendingConversionOperations] = useState<
    ReadonlyMap<string, NoteWorkspaceIdentity>
  >(() => new Map());
  const requestSequenceRef = useRef(0);
  const latestRequestSequenceRef = useRef(-1);
  const appliedSequenceRef = useRef(-1);
  const pendingNoteOperationsRef = useRef(new Map<string, NoteWorkspaceIdentity>());
  const pendingCreateActivationsRef = useRef(new Set<NoteWorkspaceIdentity>());
  const pendingConversionOperationsRef = useRef(new Map<string, NoteWorkspaceIdentity>());

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
      setStoredSnapshot({ activation: request.workspace, snapshot });
      setLoadState({
        activation: request.workspace,
        status: 'ready',
        error: null,
      });
      return true;
    },
    [],
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
          setStoredSnapshot(null);
          setLoadState({
            activation: request.workspace,
            status: 'error',
            error: toMessage(error, '笔记暂时无法读取。'),
          });
        }
        throw error;
      }
    },
    [applySnapshot, beginRequest, requestIsCurrent],
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
    if (pendingCreateActivationsRef.current.has(target)) return false;
    pendingCreateActivationsRef.current = new Set(pendingCreateActivationsRef.current).add(target);
    setPendingCreateActivations(pendingCreateActivationsRef.current);
    return true;
  }, []);

  const endPendingCreate = useCallback((target: NoteWorkspaceIdentity): void => {
    const next = new Set(pendingCreateActivationsRef.current);
    next.delete(target);
    pendingCreateActivationsRef.current = next;
    setPendingCreateActivations(next);
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
    (error: unknown, target: NoteWorkspaceIdentity, fallback: string): Error => {
      const message = toMessage(error, fallback);
      if (activeActivationRef.current === target) {
        setOperationErrorState({ activation: target, message });
      }
      return new Error(message, { cause: error });
    },
    [],
  );

  const create = useCallback(
    async (title: string, body: string): Promise<Note> => {
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
        const result = await window.workbench.note.create({
          workspaceId: request.workspaceId,
          title,
          body,
        });
        applySnapshot(result.noteSnapshot, request);
        const created = createdNoteFromResult(request.workspaceId, result);
        if (!created) throw new Error('The created note was not returned.');
        return created;
      } catch (error) {
        throw operationFailure(error, request.workspace, '笔记创建失败，请重试。');
      } finally {
        endPendingCreate(request.workspace);
      }
    },
    [applySnapshot, beginPendingCreate, beginRequest, endPendingCreate, operationFailure],
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
    async (entryId: string): Promise<NoteConversionResult> => {
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
        const result = await window.workbench.note.convertInbox({
          workspaceId: request.workspaceId,
          entryId,
        });
        applySnapshot(result.noteSnapshot, request);
        return result;
      } catch (error) {
        throw operationFailure(error, request.workspace, '无法转换为笔记，请重试。');
      } finally {
        endPendingConversion(request.workspace, entryId);
      }
    },
    [applySnapshot, beginPendingConversion, beginRequest, endPendingConversion, operationFailure],
  );

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
    pendingCreate: pendingCreateActivations.has(activation),
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
    clearOperationError: () =>
      setOperationErrorState((current) => (current?.activation === activation ? null : current)),
    create,
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
