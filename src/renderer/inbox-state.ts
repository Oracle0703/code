import type {
  InboxCategory,
  InboxCreateResult,
  InboxEntry,
  InboxSnapshot,
} from '../shared/contracts';

export type InboxFilter = 'all' | InboxCategory;

export interface InboxWorkspaceIdentity {
  readonly workspaceId: string | null;
}

export interface InboxRequestIdentity {
  readonly workspace: InboxWorkspaceIdentity;
  readonly workspaceId: string;
  readonly sequence: number;
}

export interface InboxSnapshotState {
  readonly activation: InboxWorkspaceIdentity;
  readonly snapshot: InboxSnapshot;
}

export interface InboxCreateSnapshotRefresh {
  readonly snapshot: InboxSnapshot;
  readonly commit: () => boolean;
}

export interface InboxCreateReconciliation {
  readonly createdEntry: InboxEntry | null;
  readonly committed: boolean;
  readonly error: unknown;
}

interface InboxCreateReconciliationInput {
  readonly expectedWorkspaceId: string;
  readonly result: InboxCreateResult;
  readonly commitResultSnapshot: () => boolean;
  readonly getCommittedEntry: () => InboxEntry | null;
  readonly prepareSnapshotRefresh: () => Promise<InboxCreateSnapshotRefresh>;
  readonly isCurrent: () => boolean;
}

const INBOX_CREATE_REFRESH_ATTEMPTS = 2;

export function createInboxWorkspaceIdentity(workspaceId: string | null): InboxWorkspaceIdentity {
  return { workspaceId };
}

export function createInboxRequestIdentity(
  workspace: InboxWorkspaceIdentity,
  sequence: number,
): InboxRequestIdentity | null {
  if (workspace.workspaceId === null || !Number.isSafeInteger(sequence) || sequence < 0) {
    return null;
  }
  return {
    workspace,
    workspaceId: workspace.workspaceId,
    sequence,
  };
}

export function isInboxRequestCurrent(
  currentWorkspace: InboxWorkspaceIdentity,
  request: InboxRequestIdentity,
): boolean {
  return (
    currentWorkspace === request.workspace && currentWorkspace.workspaceId === request.workspaceId
  );
}

export function isInboxSequenceCurrent(sequence: number, lastAppliedSequence: number): boolean {
  return Number.isSafeInteger(sequence) && sequence >= 0 && sequence >= lastAppliedSequence;
}

export function isInboxRequestLatest(sequence: number, latestRequestedSequence: number): boolean {
  return Number.isSafeInteger(sequence) && sequence >= 0 && sequence === latestRequestedSequence;
}

export function isInboxWorkspaceCurrent(
  activeWorkspaceId: string | null,
  snapshot: InboxSnapshot,
): boolean {
  return activeWorkspaceId !== null && snapshot.workspaceId === activeWorkspaceId;
}

export function shouldApplyInboxSnapshot(
  currentWorkspace: InboxWorkspaceIdentity,
  lastAppliedSequence: number,
  request: InboxRequestIdentity,
  snapshot: InboxSnapshot,
): boolean {
  return (
    isInboxRequestCurrent(currentWorkspace, request) &&
    snapshot.workspaceId === request.workspaceId &&
    request.sequence > lastAppliedSequence
  );
}

export function inboxSnapshotForActivation(
  currentWorkspace: InboxWorkspaceIdentity,
  state: InboxSnapshotState | null,
): InboxSnapshot | null {
  return state !== null &&
    state.activation === currentWorkspace &&
    state.snapshot.workspaceId === currentWorkspace.workspaceId
    ? state.snapshot
    : null;
}

export function createdInboxEntryFromResult(
  expectedWorkspaceId: string,
  result: InboxCreateResult,
): InboxEntry | null {
  if (result.inboxSnapshot.workspaceId !== expectedWorkspaceId) return null;
  const matches = result.inboxSnapshot.entries.filter(({ id }) => id === result.createdEntryId);
  return matches.length === 1 ? matches[0]! : null;
}

export function isInboxConversionSourceArchived(
  expectedWorkspaceId: string,
  expectedSourceEntryId: string,
  snapshot: InboxSnapshot,
): boolean {
  return (
    snapshot.workspaceId === expectedWorkspaceId &&
    !snapshot.entries.some(({ id }) => id === expectedSourceEntryId)
  );
}

export async function reconcileInboxCreateResult(
  input: InboxCreateReconciliationInput,
): Promise<InboxCreateReconciliation> {
  let createdEntry: InboxEntry | null = null;
  let committed = false;
  let error: unknown;

  try {
    createdEntry = createdInboxEntryFromResult(input.expectedWorkspaceId, input.result);
    committed = createdEntry !== null ? input.commitResultSnapshot() : false;
  } catch (caughtError) {
    error = caughtError;
  }

  for (
    let attempt = 0;
    !committed && input.isCurrent() && attempt < INBOX_CREATE_REFRESH_ATTEMPTS;
    attempt += 1
  ) {
    try {
      const currentEntry = input.getCommittedEntry();
      if (currentEntry) {
        createdEntry = currentEntry;
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
      const freshEntry = createdInboxEntryFromResult(input.expectedWorkspaceId, {
        inboxSnapshot: refresh.snapshot,
        createdEntryId: input.result.createdEntryId,
      });
      if (!freshEntry) {
        throw new Error('The committed inbox entry was not returned by the authoritative refresh.');
      }
      createdEntry = freshEntry;
      if (refresh.commit()) {
        committed = true;
        break;
      }
      error = new Error('The authoritative inbox snapshot could not be committed.');
    } catch (caughtError) {
      error = caughtError;
    }
  }

  if (!committed && input.isCurrent()) {
    try {
      const currentEntry = input.getCommittedEntry();
      if (currentEntry) {
        createdEntry = currentEntry;
        committed = true;
      }
    } catch (caughtError) {
      error = caughtError;
    }
  }

  return { createdEntry, committed, error };
}

export function countInboxEntries(entries: readonly InboxEntry[]) {
  return {
    total: entries.length,
    uncategorized: entries.filter(({ category }) => category === 'uncategorized').length,
    task: entries.filter(({ category }) => category === 'task').length,
    note: entries.filter(({ category }) => category === 'note').length,
    link: entries.filter(({ category }) => category === 'link').length,
  } as const;
}

export function filterInboxEntries(
  entries: readonly InboxEntry[],
  query: string,
  filter: InboxFilter,
  requestedEntryId: string | null,
): readonly InboxEntry[] {
  const locatingRequestedEntry = Boolean(
    requestedEntryId && entries.some(({ id }) => id === requestedEntryId),
  );
  const normalizedQuery = locatingRequestedEntry ? '' : query.trim().toLocaleLowerCase();
  const effectiveFilter = locatingRequestedEntry ? 'all' : filter;
  return entries.filter(
    (entry) =>
      (effectiveFilter === 'all' || entry.category === effectiveFilter) &&
      (!normalizedQuery || entry.content.toLocaleLowerCase().includes(normalizedQuery)),
  );
}
