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
  return result.inboxSnapshot.entries.find(({ id }) => id === result.createdEntryId) ?? null;
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
