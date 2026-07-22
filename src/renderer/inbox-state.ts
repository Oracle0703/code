import type { InboxEntry, InboxSnapshot } from '../shared/contracts';

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

export function countInboxEntries(entries: readonly InboxEntry[]) {
  return {
    total: entries.length,
    uncategorized: entries.filter(({ category }) => category === 'uncategorized').length,
    task: entries.filter(({ category }) => category === 'task').length,
    note: entries.filter(({ category }) => category === 'note').length,
    link: entries.filter(({ category }) => category === 'link').length,
  } as const;
}
