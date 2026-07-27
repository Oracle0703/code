import type {
  Note,
  NoteConversionResult,
  NoteCreateResult,
  NoteSnapshot,
} from '../shared/contracts';
import { normalizeInboxId } from '../shared/inbox-domain';
import {
  normalizeNoteBody,
  normalizeNoteId,
  normalizeNoteRevision,
  normalizeNoteTitle,
} from '../shared/note-domain';
import { normalizeWorkspaceId } from '../shared/workspace-domain';

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

export interface NoteMutationIdentity {
  readonly expectedWorkspaceId: string;
  readonly originalNote: Note;
}

export interface NoteUpdateMutationIntent extends NoteMutationIdentity {
  readonly kind: 'update';
  readonly title: string;
  readonly body: string;
  readonly contentChanged: boolean;
  readonly expectedCommittedRevision: number;
}

export interface NoteArchiveMutationIntent extends NoteMutationIdentity {
  readonly kind: 'archive';
}

export type NoteMutationIntent = NoteUpdateMutationIntent | NoteArchiveMutationIntent;

export interface NoteMutationSnapshotRefresh {
  readonly snapshot: NoteSnapshot;
  readonly commit: () => boolean;
}

export interface NoteUpdateReconciliation {
  readonly authoritativeNote: Note | null;
  readonly committed: boolean;
  readonly error: unknown;
}

export interface NoteArchiveReconciliation {
  readonly confirmed: boolean;
  readonly committed: boolean;
  readonly error: unknown;
}

export interface NoteUpdateReconciliationInput {
  readonly intent: NoteUpdateMutationIntent;
  readonly resultSnapshot: NoteSnapshot;
  readonly commitResultSnapshot: () => boolean;
  readonly getCommittedSnapshot: () => NoteSnapshot | null;
  readonly prepareSnapshotRefresh: () => Promise<NoteMutationSnapshotRefresh>;
  readonly isCurrent: () => boolean;
}

export interface NoteArchiveReconciliationInput {
  readonly intent: NoteArchiveMutationIntent;
  readonly resultSnapshot: NoteSnapshot;
  readonly commitResultSnapshot: () => boolean;
  readonly getCommittedSnapshot: () => NoteSnapshot | null;
  readonly prepareSnapshotRefresh: () => Promise<NoteMutationSnapshotRefresh>;
  readonly isCurrent: () => boolean;
}

interface NoteUpdateMutationSyncWarningTarget {
  readonly kind: 'update';
  readonly intent: NoteUpdateMutationIntent;
  readonly resultSnapshot: NoteSnapshot;
  readonly title: string;
  readonly message: string;
}

interface NoteArchiveMutationSyncWarningTarget {
  readonly kind: 'archive';
  readonly intent: NoteArchiveMutationIntent;
  readonly resultSnapshot: NoteSnapshot;
  readonly title: string;
  readonly message: string;
}

export type NoteMutationSyncWarningTarget =
  NoteUpdateMutationSyncWarningTarget | NoteArchiveMutationSyncWarningTarget;

export type NoteMutationSyncWarningState = NoteMutationSyncWarningTarget & {
  readonly activation: NoteWorkspaceIdentity;
};

export class NoteMutationSupersededError extends Error {
  constructor() {
    super('The note mutation reconciliation is no longer current.');
    this.name = 'NoteMutationSupersededError';
  }
}

export class NoteMutationResultUnavailableError extends Error {
  constructor(kind: NoteMutationIntent['kind']) {
    super(
      kind === 'update'
        ? 'The exact updated note was not returned by the authoritative snapshot.'
        : 'The exact archived note is still present in the authoritative snapshot.',
    );
    this.name = 'NoteMutationResultUnavailableError';
  }
}

export class NoteMutationSnapshotCommitError extends Error {
  constructor() {
    super('The authoritative note snapshot could not be committed.');
    this.name = 'NoteMutationSnapshotCommitError';
  }
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
const NOTE_MUTATION_REFRESH_ATTEMPTS = 2;

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

export function noteMutationSyncWarningForActivation(
  activation: NoteWorkspaceIdentity,
  state: NoteMutationSyncWarningState | null,
): NoteMutationSyncWarningTarget | null {
  return state?.activation === activation ? state : null;
}

export function isNoteCreateNavigationBlocked(
  pendingCreate: boolean,
  warning: NoteCreateSyncWarningTarget | null,
): boolean {
  return pendingCreate || warning !== null;
}

export function isNoteMutationNavigationBlocked(
  pendingMutation: boolean,
  warning: NoteMutationSyncWarningTarget | null,
): boolean {
  return pendingMutation || warning !== null;
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

export function clearResolvedNoteMutationSyncWarning(
  state: NoteMutationSyncWarningState | null,
  activation: NoteWorkspaceIdentity,
  resolved: NoteMutationSyncWarningTarget,
): NoteMutationSyncWarningState | null {
  return state?.activation === activation && state === resolved ? null : state;
}

export function createNoteUpdateMutationIntent(
  expectedWorkspaceId: string,
  originalNote: Note,
  title: string,
  body: string,
): NoteUpdateMutationIntent {
  const normalizedOriginal = normalizeOriginalNote(originalNote);
  const normalizedTitle = normalizeNoteTitle(title);
  const normalizedBody = normalizeNoteBody(body);
  const contentChanged =
    normalizedTitle !== normalizedOriginal.title || normalizedBody !== normalizedOriginal.body;
  if (contentChanged && normalizedOriginal.revision === Number.MAX_SAFE_INTEGER) {
    throw new TypeError('Note revision cannot be incremented safely.');
  }
  return Object.freeze({
    kind: 'update',
    expectedWorkspaceId: normalizeWorkspaceId(expectedWorkspaceId),
    originalNote: normalizedOriginal,
    title: normalizedTitle,
    body: normalizedBody,
    contentChanged,
    expectedCommittedRevision: normalizedOriginal.revision + (contentChanged ? 1 : 0),
  });
}

export function createNoteArchiveMutationIntent(
  expectedWorkspaceId: string,
  originalNote: Note,
): NoteArchiveMutationIntent {
  const normalizedOriginal = normalizeOriginalNote(originalNote);
  if (normalizedOriginal.revision === Number.MAX_SAFE_INTEGER) {
    throw new TypeError('Note revision cannot be incremented safely.');
  }
  return Object.freeze({
    kind: 'archive',
    expectedWorkspaceId: normalizeWorkspaceId(expectedWorkspaceId),
    originalNote: normalizedOriginal,
  });
}

export function updatedNoteFromSnapshot(
  intent: NoteUpdateMutationIntent,
  snapshot: NoteSnapshot,
): Note | null {
  if (snapshot.workspaceId !== intent.expectedWorkspaceId) return null;
  const matches = snapshot.notes.filter(({ id }) => id === intent.originalNote.id);
  if (matches.length !== 1) return null;
  const candidate = matches[0]!;
  if (
    candidate.title !== intent.title ||
    candidate.body !== intent.body ||
    candidate.revision !== intent.expectedCommittedRevision ||
    candidate.sourceInboxEntryId !== intent.originalNote.sourceInboxEntryId ||
    candidate.createdAt !== intent.originalNote.createdAt
  ) {
    return null;
  }
  if (
    intent.contentChanged
      ? !isIsoTimestampAtLeast(candidate.updatedAt, intent.originalNote.updatedAt)
      : candidate.updatedAt !== intent.originalNote.updatedAt
  ) {
    return null;
  }
  return candidate;
}

export function archivedNoteIsAbsent(
  intent: NoteArchiveMutationIntent,
  snapshot: NoteSnapshot,
): boolean {
  return (
    snapshot.workspaceId === intent.expectedWorkspaceId &&
    !snapshot.notes.some(({ id }) => id === intent.originalNote.id)
  );
}

export async function reconcileNoteUpdateResult(
  input: NoteUpdateReconciliationInput,
): Promise<NoteUpdateReconciliation> {
  const result = await reconcileNoteMutation({
    kind: input.intent.kind,
    resultSnapshot: input.resultSnapshot,
    commitResultSnapshot: input.commitResultSnapshot,
    getCommittedSnapshot: input.getCommittedSnapshot,
    prepareSnapshotRefresh: input.prepareSnapshotRefresh,
    isCurrent: input.isCurrent,
    valueFromSnapshot: (snapshot) => updatedNoteFromSnapshot(input.intent, snapshot),
  });
  return {
    authoritativeNote: result.value,
    committed: result.committed,
    error: result.error,
  };
}

export async function reconcileNoteArchiveResult(
  input: NoteArchiveReconciliationInput,
): Promise<NoteArchiveReconciliation> {
  const result = await reconcileNoteMutation({
    kind: input.intent.kind,
    resultSnapshot: input.resultSnapshot,
    commitResultSnapshot: input.commitResultSnapshot,
    getCommittedSnapshot: input.getCommittedSnapshot,
    prepareSnapshotRefresh: input.prepareSnapshotRefresh,
    isCurrent: input.isCurrent,
    valueFromSnapshot: (snapshot) => (archivedNoteIsAbsent(input.intent, snapshot) ? true : null),
  });
  return {
    confirmed: result.value === true && result.committed,
    committed: result.committed,
    error: result.error,
  };
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

interface NoteMutationReconciliationInput<Value> {
  readonly kind: NoteMutationIntent['kind'];
  readonly resultSnapshot: NoteSnapshot;
  readonly commitResultSnapshot: () => boolean;
  readonly getCommittedSnapshot: () => NoteSnapshot | null;
  readonly prepareSnapshotRefresh: () => Promise<NoteMutationSnapshotRefresh>;
  readonly isCurrent: () => boolean;
  readonly valueFromSnapshot: (snapshot: NoteSnapshot) => Value | null;
}

interface NoteMutationReconciliation<Value> {
  readonly value: Value | null;
  readonly committed: boolean;
  readonly error: unknown;
}

async function reconcileNoteMutation<Value>(
  input: NoteMutationReconciliationInput<Value>,
): Promise<NoteMutationReconciliation<Value>> {
  let error: unknown;

  const superseded = (): NoteMutationReconciliation<Value> => ({
    value: null,
    committed: false,
    error: new NoteMutationSupersededError(),
  });
  const unavailable = (): NoteMutationResultUnavailableError =>
    new NoteMutationResultUnavailableError(input.kind);
  const committedValue = (): NoteMutationReconciliation<Value> | null => {
    if (!input.isCurrent()) return superseded();
    try {
      const snapshot = input.getCommittedSnapshot();
      if (!input.isCurrent()) return superseded();
      if (snapshot === null) return null;
      const value = input.valueFromSnapshot(snapshot);
      if (value === null) {
        error = unavailable();
        return null;
      }
      return { value, committed: true, error };
    } catch (caughtError) {
      error = caughtError;
      return input.isCurrent() ? null : superseded();
    }
  };

  if (!input.isCurrent()) return superseded();

  let responseValue: Value | null = null;
  try {
    responseValue = input.valueFromSnapshot(input.resultSnapshot);
  } catch (caughtError) {
    error = caughtError;
  }
  if (responseValue === null) {
    error ??= unavailable();
  } else {
    if (!input.isCurrent()) return superseded();
    try {
      const committed = input.commitResultSnapshot();
      if (!input.isCurrent()) return superseded();
      if (committed) return { value: responseValue, committed: true, error };
      error = new NoteMutationSnapshotCommitError();
    } catch (caughtError) {
      error = caughtError;
      if (!input.isCurrent()) return superseded();
    }
  }

  const currentValue = committedValue();
  if (currentValue !== null) return currentValue;

  for (let attempt = 0; attempt < NOTE_MUTATION_REFRESH_ATTEMPTS; attempt += 1) {
    if (!input.isCurrent()) return superseded();
    try {
      const refresh = await input.prepareSnapshotRefresh();
      if (!input.isCurrent()) return superseded();
      const value = input.valueFromSnapshot(refresh.snapshot);
      if (value === null) {
        error = unavailable();
        continue;
      }
      if (!input.isCurrent()) return superseded();
      const committed = refresh.commit();
      if (!input.isCurrent()) return superseded();
      if (committed) return { value, committed: true, error };
      error = new NoteMutationSnapshotCommitError();
    } catch (caughtError) {
      error = caughtError;
      if (!input.isCurrent()) return superseded();
    }
  }

  if (!input.isCurrent()) return superseded();
  const finalValue = committedValue();
  if (finalValue !== null) return finalValue;

  return {
    value: null,
    committed: false,
    error: error ?? unavailable(),
  };
}

function normalizeOriginalNote(note: Note): Note {
  const normalizedTitle = normalizeNoteTitle(note.title);
  const normalizedBody = normalizeNoteBody(note.body);
  const sourceInboxEntryId =
    note.sourceInboxEntryId === null ? null : normalizeInboxId(note.sourceInboxEntryId);
  if (normalizedTitle !== note.title || normalizedBody !== note.body) {
    throw new TypeError('Original note text must already be normalized.');
  }
  if (
    !isIsoTimestampAtLeast(note.updatedAt, note.createdAt) ||
    !isExactIsoTimestamp(note.createdAt)
  ) {
    throw new TypeError('Original note timestamps are invalid.');
  }
  return Object.freeze({
    id: normalizeNoteId(note.id),
    title: normalizedTitle,
    body: normalizedBody,
    revision: normalizeNoteRevision(note.revision),
    sourceInboxEntryId,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
  });
}

function isExactIsoTimestamp(value: string): boolean {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function isIsoTimestampAtLeast(value: string, lowerBound: string): boolean {
  return isExactIsoTimestamp(value) && isExactIsoTimestamp(lowerBound) && value >= lowerBound;
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
