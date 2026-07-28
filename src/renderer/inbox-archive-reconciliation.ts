import type { InboxEntry, InboxSnapshot } from '../shared/contracts';
import {
  INBOX_UNDO_WINDOW_MS,
  normalizeInboxCategory,
  normalizeInboxContent,
  normalizeInboxId,
  normalizeInboxUndoToken,
} from '../shared/inbox-domain';
import { normalizeWorkspaceId } from '../shared/workspace-domain';

export interface InboxArchiveMutationIdentity {
  readonly expectedWorkspaceId: string;
  readonly originalEntry: InboxEntry;
}

export interface InboxArchiveMutationIntent extends InboxArchiveMutationIdentity {
  readonly kind: 'archive';
}

export interface InboxUndoMutationIntent extends InboxArchiveMutationIdentity {
  readonly kind: 'undo';
  readonly undoToken: string;
  readonly undoExpiresAt: string;
}

export type InboxArchiveReconciliationIntent = InboxArchiveMutationIntent | InboxUndoMutationIntent;

export interface InboxArchiveSnapshotRefresh {
  readonly snapshot: InboxSnapshot;
  readonly commit: () => boolean;
}

export interface InboxArchiveReconciliationInput {
  readonly intent: InboxArchiveMutationIntent;
  readonly resultSnapshot: InboxSnapshot;
  readonly commitResultSnapshot: () => boolean;
  readonly getCommittedSnapshot: () => InboxSnapshot | null;
  readonly prepareSnapshotRefresh: () => Promise<InboxArchiveSnapshotRefresh>;
  readonly isCurrent: () => boolean;
}

export interface InboxUndoReconciliationInput {
  readonly intent: InboxUndoMutationIntent;
  readonly resultSnapshot: InboxSnapshot;
  readonly commitResultSnapshot: () => boolean;
  readonly getCommittedSnapshot: () => InboxSnapshot | null;
  readonly prepareSnapshotRefresh: () => Promise<InboxArchiveSnapshotRefresh>;
  readonly isCurrent: () => boolean;
}

export interface InboxArchiveReconciliation {
  readonly confirmed: boolean;
  readonly committed: boolean;
  readonly error: unknown;
}

export interface InboxUndoReconciliation {
  readonly restoredEntry: InboxEntry | null;
  readonly committed: boolean;
  readonly error: unknown;
}

export class InboxArchiveMutationSupersededError extends Error {
  constructor() {
    super('The inbox archive reconciliation is no longer current.');
    this.name = 'InboxArchiveMutationSupersededError';
  }
}

export class InboxArchiveMutationResultUnavailableError extends Error {
  constructor(kind: InboxArchiveReconciliationIntent['kind']) {
    super(
      kind === 'archive'
        ? 'The exact archived inbox entry is still present in the authoritative snapshot.'
        : 'The exact restored inbox entry was not returned by the authoritative snapshot.',
    );
    this.name = 'InboxArchiveMutationResultUnavailableError';
  }
}

export class InboxArchiveMutationSnapshotCommitError extends Error {
  constructor() {
    super('The authoritative inbox snapshot could not be committed.');
    this.name = 'InboxArchiveMutationSnapshotCommitError';
  }
}

const INBOX_ARCHIVE_REFRESH_ATTEMPTS = 2;

export function createInboxArchiveMutationIntent(
  expectedWorkspaceId: string,
  originalEntry: InboxEntry,
): InboxArchiveMutationIntent {
  return Object.freeze({
    kind: 'archive',
    expectedWorkspaceId: normalizeWorkspaceId(expectedWorkspaceId),
    originalEntry: normalizeOriginalEntry(originalEntry),
  });
}

export function createInboxUndoMutationIntent(
  expectedWorkspaceId: string,
  originalEntry: InboxEntry,
  undoToken: string,
  undoExpiresAt: string,
): InboxUndoMutationIntent {
  if (!isExactIsoTimestamp(undoExpiresAt)) {
    throw new TypeError('Inbox undo expiration must be an exact ISO timestamp.');
  }
  return Object.freeze({
    kind: 'undo',
    expectedWorkspaceId: normalizeWorkspaceId(expectedWorkspaceId),
    originalEntry: normalizeOriginalEntry(originalEntry),
    undoToken: normalizeInboxUndoToken(undoToken),
    undoExpiresAt,
  });
}

export function archivedInboxEntryIsAbsent(
  intent: InboxArchiveMutationIdentity,
  snapshot: InboxSnapshot,
): boolean {
  return (
    snapshot.workspaceId === intent.expectedWorkspaceId &&
    !snapshot.entries.some(({ id }) => id === intent.originalEntry.id)
  );
}

export function restoredInboxEntryFromSnapshot(
  intent: InboxArchiveMutationIdentity,
  snapshot: InboxSnapshot,
): InboxEntry | null {
  if (snapshot.workspaceId !== intent.expectedWorkspaceId) return null;
  const matches = snapshot.entries.filter(({ id }) => id === intent.originalEntry.id);
  if (matches.length !== 1) return null;
  const candidate = matches[0]!;
  if (
    candidate.content !== intent.originalEntry.content ||
    candidate.category !== intent.originalEntry.category ||
    candidate.createdAt !== intent.originalEntry.createdAt ||
    !isExactIsoTimestampAtLeast(candidate.updatedAt, intent.originalEntry.updatedAt)
  ) {
    return null;
  }
  return candidate;
}

/**
 * Maps Main's wall-clock expiration onto Renderer monotonic time without
 * granting a fresh undo window when an IPC response arrives late.
 */
export function inboxUndoMonotonicDeadline(
  undoExpiresAt: string,
  wallNowMs: number,
  monotonicNowMs: number,
): number | null {
  if (
    !isExactIsoTimestamp(undoExpiresAt) ||
    !Number.isFinite(wallNowMs) ||
    wallNowMs < 0 ||
    !Number.isFinite(monotonicNowMs) ||
    monotonicNowMs < 0
  ) {
    return null;
  }
  const remainingMs = Date.parse(undoExpiresAt) - wallNowMs;
  if (!Number.isFinite(remainingMs) || remainingMs <= 0 || remainingMs > INBOX_UNDO_WINDOW_MS) {
    return null;
  }
  const deadline = monotonicNowMs + remainingMs;
  return Number.isFinite(deadline) && deadline > monotonicNowMs ? deadline : null;
}

export async function reconcileInboxArchiveResult(
  input: InboxArchiveReconciliationInput,
): Promise<InboxArchiveReconciliation> {
  const result = await reconcileInboxArchiveMutation({
    ...input,
    valueFromSnapshot: (snapshot) =>
      archivedInboxEntryIsAbsent(input.intent, snapshot) ? true : null,
  });
  return {
    confirmed: result.value === true && result.committed,
    committed: result.committed,
    error: result.error,
  };
}

export async function reconcileInboxUndoResult(
  input: InboxUndoReconciliationInput,
): Promise<InboxUndoReconciliation> {
  const result = await reconcileInboxArchiveMutation({
    ...input,
    valueFromSnapshot: (snapshot) => restoredInboxEntryFromSnapshot(input.intent, snapshot),
  });
  return {
    restoredEntry: result.value,
    committed: result.committed,
    error: result.error,
  };
}

interface GenericInboxArchiveReconciliationInput<Value> {
  readonly intent: InboxArchiveReconciliationIntent;
  readonly resultSnapshot: InboxSnapshot;
  readonly commitResultSnapshot: () => boolean;
  readonly getCommittedSnapshot: () => InboxSnapshot | null;
  readonly prepareSnapshotRefresh: () => Promise<InboxArchiveSnapshotRefresh>;
  readonly isCurrent: () => boolean;
  readonly valueFromSnapshot: (snapshot: InboxSnapshot) => Value | null;
}

interface GenericInboxArchiveReconciliation<Value> {
  readonly value: Value | null;
  readonly committed: boolean;
  readonly error: unknown;
}

async function reconcileInboxArchiveMutation<Value>(
  input: GenericInboxArchiveReconciliationInput<Value>,
): Promise<GenericInboxArchiveReconciliation<Value>> {
  let error: unknown;

  const superseded = (): GenericInboxArchiveReconciliation<Value> => ({
    value: null,
    committed: false,
    error: new InboxArchiveMutationSupersededError(),
  });
  const unavailable = (): InboxArchiveMutationResultUnavailableError =>
    new InboxArchiveMutationResultUnavailableError(input.intent.kind);
  const committedValue = (): GenericInboxArchiveReconciliation<Value> | null => {
    if (!input.isCurrent()) return superseded();
    try {
      const snapshot = input.getCommittedSnapshot();
      if (!input.isCurrent()) return superseded();
      if (snapshot === null) return null;
      const value = input.valueFromSnapshot(snapshot);
      if (!input.isCurrent()) return superseded();
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
  if (!input.isCurrent()) return superseded();
  if (responseValue === null) {
    error ??= unavailable();
  } else {
    try {
      const committed = input.commitResultSnapshot();
      if (!input.isCurrent()) return superseded();
      if (committed) return { value: responseValue, committed: true, error };
      error = new InboxArchiveMutationSnapshotCommitError();
    } catch (caughtError) {
      error = caughtError;
      if (!input.isCurrent()) return superseded();
    }
  }

  const currentValue = committedValue();
  if (currentValue !== null) return currentValue;

  for (let attempt = 0; attempt < INBOX_ARCHIVE_REFRESH_ATTEMPTS; attempt += 1) {
    if (!input.isCurrent()) return superseded();
    try {
      const refresh = await input.prepareSnapshotRefresh();
      if (!input.isCurrent()) return superseded();
      const value = input.valueFromSnapshot(refresh.snapshot);
      if (!input.isCurrent()) return superseded();
      if (value === null) {
        error = unavailable();
        continue;
      }
      const committed = refresh.commit();
      if (!input.isCurrent()) return superseded();
      if (committed) return { value, committed: true, error };
      error = new InboxArchiveMutationSnapshotCommitError();
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

function normalizeOriginalEntry(entry: InboxEntry): InboxEntry {
  const id = normalizeInboxId(entry.id);
  const content = normalizeInboxContent(entry.content);
  const category = normalizeInboxCategory(entry.category);
  if (content !== entry.content || category !== entry.category) {
    throw new TypeError('Original inbox entry must already be normalized.');
  }
  if (
    !isExactIsoTimestamp(entry.createdAt) ||
    !isExactIsoTimestampAtLeast(entry.updatedAt, entry.createdAt)
  ) {
    throw new TypeError('Original inbox entry timestamps are invalid.');
  }
  return Object.freeze({
    id,
    content,
    category,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  });
}

function isExactIsoTimestamp(value: string): boolean {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function isExactIsoTimestampAtLeast(value: string, lowerBound: string): boolean {
  return isExactIsoTimestamp(value) && isExactIsoTimestamp(lowerBound) && value >= lowerBound;
}
