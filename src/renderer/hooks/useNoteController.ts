import { useCallback, useEffect, useRef, useState } from 'react';
import type { Note, NoteConversionResult, NoteSnapshot } from '../../shared/contracts';
import { isNoteRequestLatest, isNoteSequenceCurrent, isNoteWorkspaceCurrent } from '../note-state';

type NoteControllerStatus = 'loading' | 'ready' | 'error';
const EMPTY_NOTES: readonly Note[] = Object.freeze([]);

export function useNoteController(workspaceId: string | null) {
  const [storedSnapshot, setStoredSnapshot] = useState<NoteSnapshot | null>(null);
  const [status, setStatus] = useState<NoteControllerStatus>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [operationErrorState, setOperationErrorState] = useState<{
    readonly workspaceId: string;
    readonly message: string;
  } | null>(null);
  const [pendingNoteIds, setPendingNoteIds] = useState<ReadonlySet<string>>(() => new Set());
  const [pendingCreateWorkspaces, setPendingCreateWorkspaces] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [pendingConversionEntryIds, setPendingConversionEntryIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const activeWorkspaceRef = useRef(workspaceId);
  const snapshotRef = useRef<NoteSnapshot | null>(null);
  const requestSequenceRef = useRef(0);
  const latestRequestSequenceRef = useRef(new Map<string, number>());
  const appliedSequenceRef = useRef(new Map<string, number>());
  const pendingNoteIdsRef = useRef(new Set<string>());
  const pendingCreateWorkspacesRef = useRef(new Set<string>());
  const pendingConversionEntryIdsRef = useRef(new Set<string>());

  const beginRequest = useCallback((targetWorkspaceId: string): number => {
    const sequence = ++requestSequenceRef.current;
    latestRequestSequenceRef.current.set(targetWorkspaceId, sequence);
    return sequence;
  }, []);

  const applySnapshot = useCallback((snapshot: NoteSnapshot, sequence: number): boolean => {
    const lastApplied = appliedSequenceRef.current.get(snapshot.workspaceId) ?? -1;
    if (!isNoteSequenceCurrent(sequence, lastApplied)) return false;
    appliedSequenceRef.current.set(snapshot.workspaceId, sequence);
    if (!isNoteWorkspaceCurrent(activeWorkspaceRef.current, snapshot)) return false;
    snapshotRef.current = snapshot;
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
          await window.workbench.note.getSnapshot({ workspaceId: targetWorkspaceId }),
          sequence,
        );
      } catch (error) {
        const latestRequested = latestRequestSequenceRef.current.get(targetWorkspaceId) ?? -1;
        if (
          isNoteRequestLatest(sequence, latestRequested) &&
          activeWorkspaceRef.current === targetWorkspaceId
        ) {
          snapshotRef.current = null;
          setStoredSnapshot(null);
          setStatus('error');
          setLoadError(toMessage(error, '笔记暂时无法读取。'));
        }
      }
    },
    [applySnapshot, beginRequest],
  );

  useEffect(() => {
    activeWorkspaceRef.current = workspaceId;
    if (workspaceId) void load(workspaceId);
  }, [load, workspaceId]);

  const beginPendingNote = useCallback((noteId: string): boolean => {
    if (pendingNoteIdsRef.current.has(noteId)) return false;
    pendingNoteIdsRef.current = new Set(pendingNoteIdsRef.current).add(noteId);
    setPendingNoteIds(pendingNoteIdsRef.current);
    return true;
  }, []);

  const endPendingNote = useCallback((noteId: string): void => {
    const next = new Set(pendingNoteIdsRef.current);
    next.delete(noteId);
    pendingNoteIdsRef.current = next;
    setPendingNoteIds(next);
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

  const beginPendingConversion = useCallback((entryId: string): boolean => {
    if (pendingConversionEntryIdsRef.current.has(entryId)) return false;
    pendingConversionEntryIdsRef.current = new Set(pendingConversionEntryIdsRef.current).add(
      entryId,
    );
    setPendingConversionEntryIds(pendingConversionEntryIdsRef.current);
    return true;
  }, []);

  const endPendingConversion = useCallback((entryId: string): void => {
    const next = new Set(pendingConversionEntryIdsRef.current);
    next.delete(entryId);
    pendingConversionEntryIdsRef.current = next;
    setPendingConversionEntryIds(next);
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
    async (title: string, body: string): Promise<Note> => {
      const targetWorkspaceId = activeWorkspaceRef.current;
      if (!targetWorkspaceId || !beginPendingCreate(targetWorkspaceId)) {
        throw new Error('这个工作区正在创建另一篇笔记。');
      }
      const previousIds = new Set(
        snapshotRef.current?.workspaceId === targetWorkspaceId
          ? snapshotRef.current.notes.map(({ id }) => id)
          : [],
      );
      const sequence = beginRequest(targetWorkspaceId);
      setOperationErrorState(null);
      try {
        const snapshot = await window.workbench.note.create({
          workspaceId: targetWorkspaceId,
          title,
          body,
        });
        applySnapshot(snapshot, sequence);
        const created = snapshot.notes.find(({ id }) => !previousIds.has(id));
        if (!created) throw new Error('The created note was not returned.');
        return created;
      } catch (error) {
        throw operationFailure(error, targetWorkspaceId, '笔记创建失败，请重试。');
      } finally {
        endPendingCreate(targetWorkspaceId);
      }
    },
    [applySnapshot, beginPendingCreate, beginRequest, endPendingCreate, operationFailure],
  );

  const update = useCallback(
    async (note: Note, title: string, body: string): Promise<Note> => {
      const targetWorkspaceId = activeWorkspaceRef.current;
      if (!targetWorkspaceId || !beginPendingNote(note.id)) {
        throw new Error('这篇笔记正在保存。');
      }
      const sequence = beginRequest(targetWorkspaceId);
      setOperationErrorState(null);
      try {
        const snapshot = await window.workbench.note.update({
          workspaceId: targetWorkspaceId,
          noteId: note.id,
          title,
          body,
          expectedRevision: note.revision,
        });
        applySnapshot(snapshot, sequence);
        const updated = snapshot.notes.find(({ id }) => id === note.id);
        if (!updated) throw new Error('The updated note was not returned.');
        return updated;
      } catch (error) {
        throw operationFailure(error, targetWorkspaceId, '笔记保存失败，可能已在其他操作中更新。');
      } finally {
        endPendingNote(note.id);
      }
    },
    [applySnapshot, beginPendingNote, beginRequest, endPendingNote, operationFailure],
  );

  const archive = useCallback(
    async (note: Note): Promise<void> => {
      const targetWorkspaceId = activeWorkspaceRef.current;
      if (!targetWorkspaceId || !beginPendingNote(note.id)) return;
      const sequence = beginRequest(targetWorkspaceId);
      setOperationErrorState(null);
      try {
        applySnapshot(
          await window.workbench.note.archive({
            workspaceId: targetWorkspaceId,
            noteId: note.id,
            expectedRevision: note.revision,
          }),
          sequence,
        );
      } catch (error) {
        throw operationFailure(error, targetWorkspaceId, '笔记归档失败，请重试。');
      } finally {
        endPendingNote(note.id);
      }
    },
    [applySnapshot, beginPendingNote, beginRequest, endPendingNote, operationFailure],
  );

  const convertInbox = useCallback(
    async (entryId: string): Promise<NoteConversionResult> => {
      const targetWorkspaceId = activeWorkspaceRef.current;
      if (!targetWorkspaceId || !beginPendingConversion(entryId)) {
        throw new Error('这条记录正在转换。');
      }
      const sequence = beginRequest(targetWorkspaceId);
      setOperationErrorState(null);
      try {
        const result = await window.workbench.note.convertInbox({
          workspaceId: targetWorkspaceId,
          entryId,
        });
        applySnapshot(result.noteSnapshot, sequence);
        return result;
      } catch (error) {
        throw operationFailure(error, targetWorkspaceId, '无法转换为笔记，请重试。');
      } finally {
        endPendingConversion(entryId);
      }
    },
    [applySnapshot, beginPendingConversion, beginRequest, endPendingConversion, operationFailure],
  );

  const snapshot =
    storedSnapshot?.workspaceId === workspaceId && workspaceId !== null ? storedSnapshot : null;

  return {
    snapshot,
    notes: snapshot?.notes ?? EMPTY_NOTES,
    status:
      snapshot !== null
        ? ('ready' as const)
        : storedSnapshot !== null && storedSnapshot.workspaceId !== workspaceId
          ? ('loading' as const)
          : status,
    loadError,
    operationError:
      operationErrorState?.workspaceId === workspaceId ? operationErrorState.message : null,
    pendingNoteIds,
    pendingCreate: workspaceId ? pendingCreateWorkspaces.has(workspaceId) : false,
    pendingConversionEntryIds,
    retry: () => {
      if (workspaceId) void load(workspaceId);
    },
    clearOperationError: () => setOperationErrorState(null),
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
