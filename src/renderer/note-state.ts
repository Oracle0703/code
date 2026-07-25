import type { Note, NoteCreateResult, NoteSnapshot } from '../shared/contracts';

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

export function createdNoteFromResult(
  expectedWorkspaceId: string,
  result: NoteCreateResult,
): Note | null {
  if (result.noteSnapshot.workspaceId !== expectedWorkspaceId) return null;
  return result.noteSnapshot.notes.find(({ id }) => id === result.createdNoteId) ?? null;
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
