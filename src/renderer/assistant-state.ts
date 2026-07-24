import type { AssistantContextReference, AssistantSnapshot } from '../shared/contracts';

export type AssistantRuntimeStatus = 'loading' | 'ready' | 'error';

export const EMPTY_ASSISTANT_CONTEXT: AssistantContextReference = Object.freeze({ kind: 'none' });

export function assistantEntryContextForWorkspace(
  currentWorkspaceId: string | null,
  entryWorkspaceId: string | null,
  context: AssistantContextReference,
): AssistantContextReference {
  return currentWorkspaceId !== null && entryWorkspaceId === currentWorkspaceId
    ? context
    : EMPTY_ASSISTANT_CONTEXT;
}

export function shouldApplyAssistantSnapshot(
  currentWorkspaceId: string | null,
  latestSequence: number,
  incoming: Pick<AssistantSnapshot, 'workspaceId' | 'sequence'>,
): boolean {
  return (
    currentWorkspaceId !== null &&
    incoming.workspaceId === currentWorkspaceId &&
    incoming.sequence > latestSequence
  );
}

export function visibleAssistantRuntime(
  currentWorkspaceId: string | null,
  snapshot: AssistantSnapshot | null,
  status: AssistantRuntimeStatus,
  error: string | null,
): {
  readonly snapshot: AssistantSnapshot | null;
  readonly status: AssistantRuntimeStatus;
  readonly error: string | null;
} {
  if (snapshot && snapshot.workspaceId !== currentWorkspaceId) {
    return {
      snapshot: null,
      status: 'loading',
      error: null,
    };
  }
  return { snapshot, status, error };
}
