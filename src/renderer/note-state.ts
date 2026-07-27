import type {
  Note,
  NoteConversionResult,
  NoteCreateResult,
  NoteSnapshot,
} from '../shared/contracts';

export interface NoteWorkspaceIdentity {
  readonly workspaceId: string | null;
}

export interface NoteRequestIdentity {
  readonly workspace: NoteWorkspaceIdentity;
  readonly workspaceId: string;
  readonly sequence: number;
}

export interface NoteSnapshotState {
  readonly activation: NoteWorkspaceIdentity;
  readonly snapshot: NoteSnapshot;
}

export interface NoteCreateSnapshotRefresh {
  readonly snapshot: NoteSnapshot;
  readonly commit: () => boolean;
}

export interface NoteCreateReconciliation {
  readonly createdNote: Note | null;
  readonly committed: boolean;
  readonly error: unknown;
}

export interface NoteCreateSyncWarningTarget {
  readonly result: NoteCreateResult;
  readonly title: string;
  readonly body: string;
  readonly message: string;
}

export interface NoteCreateSyncWarningState extends NoteCreateSyncWarningTarget {
  readonly activation: NoteWorkspaceIdentity;
}

interface NoteCreateReconciliationInput {
  readonly expectedWorkspaceId: string;
  readonly result: NoteCreateResult;
  readonly commitResultSnapshot: () => boolean;
  readonly getCommittedNote: () => Note | null;
  readonly prepareSnapshotRefresh: () => Promise<NoteCreateSnapshotRefresh>;
  readonly isCurrent: () => boolean;
}

const NOTE_CREATE_REFRESH_ATTEMPTS = 2;

export function createNoteWorkspaceIdentity(workspaceId: string | null): NoteWorkspaceIdentity {
  return { workspaceId };
}

export function createNoteRequestIdentity(
  workspace: NoteWorkspaceIdentity,
  sequence: number,
): NoteRequestIdentity | null {
  if (workspace.workspaceId === null || !Number.isSafeInteger(sequence) || sequence < 0) {
    return null;
  }
  return {
    workspace,
    workspaceId: workspace.workspaceId,
    sequence,
  };
}

export function isNoteRequestCurrent(
  currentWorkspace: NoteWorkspaceIdentity,
  request: NoteRequestIdentity,
): boolean {
  return (
    currentWorkspace === request.workspace && currentWorkspace.workspaceId === request.workspaceId
  );
}

export function isNoteSequenceCurrent(sequence: number, lastAppliedSequence: number): boolean {
  return Number.isSafeInteger(sequence) && sequence >= 0 && sequence >= lastAppliedSequence;
}

export function isNoteRequestLatest(sequence: number, latestRequestedSequence: number): boolean {
  return Number.isSafeInteger(sequence) && sequence >= 0 && sequence === latestRequestedSequence;
}

export function isNoteWorkspaceCurrent(
  activeWorkspaceId: string | null,
  snapshot: NoteSnapshot,
): boolean {
  return activeWorkspaceId !== null && snapshot.workspaceId === activeWorkspaceId;
}

export function shouldApplyNoteSnapshot(
  currentWorkspace: NoteWorkspaceIdentity,
  lastAppliedSequence: number,
  request: NoteRequestIdentity,
  snapshot: NoteSnapshot,
): boolean {
  return (
    isNoteRequestCurrent(currentWorkspace, request) &&
    snapshot.workspaceId === request.workspaceId &&
    request.sequence > lastAppliedSequence
  );
}

export function noteSnapshotForActivation(
  currentWorkspace: NoteWorkspaceIdentity,
  state: NoteSnapshotState | null,
): NoteSnapshot | null {
  return state !== null &&
    state.activation === currentWorkspace &&
    state.snapshot.workspaceId === currentWorkspace.workspaceId
    ? state.snapshot
    : null;
}

export function noteCreateSyncWarningForActivation(
  activation: NoteWorkspaceIdentity,
  state: NoteCreateSyncWarningState | null,
): NoteCreateSyncWarningTarget | null {
  return state?.activation === activation ? state : null;
}

export function isNoteCreateNavigationBlocked(
  pendingCreate: boolean,
  warning: NoteCreateSyncWarningTarget | null,
): boolean {
  return pendingCreate || warning !== null;
}

export function beginPendingNoteCreate(
  pendingWorkspaceIds: ReadonlySet<string>,
  workspaceId: string | null,
): Set<string> | null {
  if (workspaceId === null || pendingWorkspaceIds.has(workspaceId)) return null;
  return new Set(pendingWorkspaceIds).add(workspaceId);
}

export function endPendingNoteCreate(
  pendingWorkspaceIds: ReadonlySet<string>,
  workspaceId: string | null,
): ReadonlySet<string> {
  if (workspaceId === null || !pendingWorkspaceIds.has(workspaceId)) return pendingWorkspaceIds;
  const next = new Set(pendingWorkspaceIds);
  next.delete(workspaceId);
  return next;
}

export function clearResolvedNoteCreateSyncWarning(
  state: NoteCreateSyncWarningState | null,
  activation: NoteWorkspaceIdentity,
  resolved: NoteCreateSyncWarningTarget,
): NoteCreateSyncWarningState | null {
  return state?.activation === activation &&
    state.result.createdNoteId === resolved.result.createdNoteId
    ? null
    : state;
}

export function createdNoteFromResult(
  expectedWorkspaceId: string,
  result: NoteCreateResult,
): Note | null {
  if (result.noteSnapshot.workspaceId !== expectedWorkspaceId) return null;
  const matches = result.noteSnapshot.notes.filter(({ id }) => id === result.createdNoteId);
  return matches.length === 1 ? matches[0]! : null;
}

export async function reconcileNoteCreateResult(
  input: NoteCreateReconciliationInput,
): Promise<NoteCreateReconciliation> {
  let createdNote: Note | null = null;
  let committed = false;
  let error: unknown;

  try {
    createdNote = createdNoteFromResult(input.expectedWorkspaceId, input.result);
    committed = createdNote !== null ? input.commitResultSnapshot() : false;
  } catch (caughtError) {
    error = caughtError;
  }

  for (
    let attempt = 0;
    !committed && input.isCurrent() && attempt < NOTE_CREATE_REFRESH_ATTEMPTS;
    attempt += 1
  ) {
    try {
      const currentNote = input.getCommittedNote();
      if (currentNote) {
        createdNote = currentNote;
        committed = true;
        break;
      }
    } catch (caughtError) {
      error = caughtError;
    }
    if (!input.isCurrent()) break;

    try {
      const refresh = await input.prepareSnapshotRefresh();
      if (!input.isCurrent()) break;
      const freshNote = createdNoteFromResult(input.expectedWorkspaceId, {
        noteSnapshot: refresh.snapshot,
        createdNoteId: input.result.createdNoteId,
      });
      if (!freshNote) {
        throw new Error('The committed note was not returned by the authoritative refresh.');
      }
      createdNote = freshNote;
      if (refresh.commit()) {
        committed = true;
        break;
      }
      error = new Error('The authoritative note snapshot could not be committed.');
    } catch (caughtError) {
      error = caughtError;
    }
  }

  if (!committed && input.isCurrent()) {
    try {
      const currentNote = input.getCommittedNote();
      if (currentNote) {
        createdNote = currentNote;
        committed = true;
      }
    } catch (caughtError) {
      error = caughtError;
    }
  }

  return { createdNote, committed, error };
}

export function convertedNoteFromResult(
  expectedWorkspaceId: string,
  expectedSourceEntryId: string,
  result: NoteConversionResult,
): Note | null {
  return convertedNoteFromSnapshot(
    expectedWorkspaceId,
    expectedSourceEntryId,
    result.createdNoteId,
    result.noteSnapshot,
  );
}

export function convertedNoteFromSnapshot(
  expectedWorkspaceId: string,
  expectedSourceEntryId: string,
  expectedCreatedNoteId: string,
  snapshot: NoteSnapshot,
): Note | null {
  if (snapshot.workspaceId !== expectedWorkspaceId) return null;
  const matches = snapshot.notes.filter(({ id }) => id === expectedCreatedNoteId);
  const note = matches.length === 1 ? matches[0]! : null;
  return note?.sourceInboxEntryId === expectedSourceEntryId ? note : null;
}

export function filterNotes(notes: readonly Note[], query: string): readonly Note[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return notes;
  return notes.filter((note) =>
    `${note.title}\n${note.body}`.toLocaleLowerCase().includes(normalizedQuery),
  );
}

export function noteExcerpt(body: string, maximumLength = 180): string {
  if (!Number.isSafeInteger(maximumLength) || maximumLength < 1) {
    throw new TypeError('Note excerpt length must be a positive safe integer.');
  }
  const plainText = body
    .replace(/```[\s\S]*?```/gu, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
    .replace(/^\s{0,3}(?:#{1,6}|>|[-*+]\s|\d+[.)]\s)/gmu, '')
    .replace(/[*_~`]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
  if (!plainText) return '空白 Markdown 笔记';
  const characters = Array.from(plainText);
  return characters.length > maximumLength
    ? `${characters.slice(0, maximumLength).join('')}…`
    : plainText;
}

export function isNoteDraftDirty(
  note: Pick<Note, 'title' | 'body'> | null,
  title: string,
  body: string,
): boolean {
  return title !== (note?.title ?? '') || body !== (note?.body ?? '');
}
