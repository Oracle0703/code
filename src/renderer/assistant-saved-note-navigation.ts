import type { AssistantSnapshot, Note, NoteSnapshot } from '../shared/contracts';

export interface AssistantWorkspaceIdentity {
  readonly workspaceId: string | null;
}

export interface AssistantSavedNoteTarget {
  readonly responseKey: string;
  readonly workspaceId: string;
  readonly noteId: string;
  readonly noteTitle: string;
}

export interface AssistantSavedNoteNavigationIntent {
  readonly generation: number;
  readonly workspace: AssistantWorkspaceIdentity;
  readonly target: Readonly<AssistantSavedNoteTarget>;
}

export interface AssistantSavedNoteSnapshotRefresh {
  readonly snapshot: NoteSnapshot;
  readonly commit: () => boolean;
}

export interface AssistantSavedNoteNavigationTarget {
  readonly workspaceId: string;
  readonly note: Note;
}

export interface AssistantSavedNoteOpenState {
  readonly targetKey: string;
  readonly opening: boolean;
  readonly error: string | null;
}

export function assistantResponseKey(
  snapshot: Pick<AssistantSnapshot, 'workspaceId' | 'runId' | 'sequence'>,
): string;
export function assistantResponseKey(snapshot: null): null;
export function assistantResponseKey(
  snapshot: Pick<AssistantSnapshot, 'workspaceId' | 'runId' | 'sequence'> | null,
): string | null;
export function assistantResponseKey(
  snapshot: Pick<AssistantSnapshot, 'workspaceId' | 'runId' | 'sequence'> | null,
): string | null {
  if (snapshot === null) return null;
  return snapshot.runId === null
    ? JSON.stringify([snapshot.workspaceId, 'sequence', snapshot.sequence])
    : JSON.stringify([snapshot.workspaceId, 'run', snapshot.runId]);
}

export function createAssistantWorkspaceIdentity(
  workspaceId: string | null,
): AssistantWorkspaceIdentity {
  return Object.freeze({ workspaceId });
}

export function assistantSavedNoteMatchesResponse(
  target: Readonly<AssistantSavedNoteTarget> | null,
  responseKey: string | null,
): boolean {
  return target !== null && responseKey !== null && target.responseKey === responseKey;
}

export function assistantSavedNoteTargetKey(target: Readonly<AssistantSavedNoteTarget>): string {
  return JSON.stringify([target.responseKey, target.workspaceId, target.noteId, target.noteTitle]);
}

export class AssistantSavedNoteSaveGate {
  readonly #pendingResponseKeys = new Set<string>();

  begin(responseKey: string): boolean {
    if (this.#pendingResponseKeys.has(responseKey)) return false;
    this.#pendingResponseKeys.add(responseKey);
    return true;
  }

  end(responseKey: string): void {
    this.#pendingResponseKeys.delete(responseKey);
  }
}

export class AssistantSavedNoteOpenGate {
  readonly #pendingTargetKeys = new Set<string>();

  begin(target: Readonly<AssistantSavedNoteTarget>): boolean {
    const key = assistantSavedNoteTargetKey(target);
    if (this.#pendingTargetKeys.has(key)) return false;
    this.#pendingTargetKeys.add(key);
    return true;
  }

  end(target: Readonly<AssistantSavedNoteTarget>): void {
    this.#pendingTargetKeys.delete(assistantSavedNoteTargetKey(target));
  }
}

export class AssistantSavedNoteNavigationCoordinator {
  #generation = 0;

  begin(
    workspace: AssistantWorkspaceIdentity,
    target: AssistantSavedNoteTarget,
  ): AssistantSavedNoteNavigationIntent {
    if (workspace.workspaceId === null || workspace.workspaceId !== target.workspaceId) {
      throw new AssistantSavedNoteSupersededError();
    }
    return Object.freeze({
      generation: ++this.#generation,
      workspace,
      target: Object.freeze({ ...target }),
    });
  }

  invalidate(): void {
    this.#generation += 1;
  }

  isCurrent(
    intent: AssistantSavedNoteNavigationIntent,
    currentWorkspace: AssistantWorkspaceIdentity,
    activeSurface: string,
    currentResponseKey: string | null,
    currentTarget: AssistantSavedNoteTarget | null,
  ): boolean {
    return (
      intent.generation === this.#generation &&
      intent.workspace === currentWorkspace &&
      intent.workspace.workspaceId === intent.target.workspaceId &&
      activeSurface === 'assistant' &&
      assistantSavedNoteMatchesResponse(intent.target, currentResponseKey) &&
      sameAssistantSavedNoteTarget(intent.target, currentTarget)
    );
  }

  assertCurrent(
    intent: AssistantSavedNoteNavigationIntent,
    currentWorkspace: AssistantWorkspaceIdentity,
    activeSurface: string,
    currentResponseKey: string | null,
    currentTarget: AssistantSavedNoteTarget | null,
  ): void {
    if (
      !this.isCurrent(intent, currentWorkspace, activeSurface, currentResponseKey, currentTarget)
    ) {
      throw new AssistantSavedNoteSupersededError();
    }
  }
}

export class AssistantSavedNoteSupersededError extends Error {
  constructor() {
    super('已保存笔记导航已被较新的状态替代。');
    this.name = 'AssistantSavedNoteSupersededError';
  }
}

export class AssistantSavedNoteUnavailableError extends Error {
  constructor() {
    super('已保存的笔记不可用；它可能已被归档或工作区数据已经变化。');
    this.name = 'AssistantSavedNoteUnavailableError';
  }
}

export async function resolveAssistantSavedNoteNavigationTarget(
  intent: AssistantSavedNoteNavigationIntent,
  readNotes: () => Promise<AssistantSavedNoteSnapshotRefresh>,
  assertCurrent: () => void,
): Promise<AssistantSavedNoteNavigationTarget> {
  assertCurrent();
  const refresh = await readNotes();
  assertCurrent();
  if (refresh.snapshot.workspaceId !== intent.target.workspaceId) {
    throw new AssistantSavedNoteUnavailableError();
  }
  const matches = refresh.snapshot.notes.filter(({ id }) => id === intent.target.noteId);
  if (matches.length !== 1) throw new AssistantSavedNoteUnavailableError();
  const note = matches[0]!;
  assertCurrent();
  if (!refresh.commit()) throw new AssistantSavedNoteSupersededError();
  assertCurrent();
  return {
    workspaceId: intent.target.workspaceId,
    note,
  };
}

export function assistantSavedNoteOpenStarted(
  target: Readonly<AssistantSavedNoteTarget>,
): AssistantSavedNoteOpenState {
  return {
    targetKey: assistantSavedNoteTargetKey(target),
    opening: true,
    error: null,
  };
}

export function assistantSavedNoteOpenFailed(
  current: AssistantSavedNoteOpenState | null,
  target: Readonly<AssistantSavedNoteTarget>,
  message: string,
): AssistantSavedNoteOpenState | null {
  const targetKey = assistantSavedNoteTargetKey(target);
  return current?.targetKey === targetKey
    ? {
        targetKey,
        opening: false,
        error: message,
      }
    : current;
}

export function assistantSavedNoteOpenFinished(
  current: AssistantSavedNoteOpenState | null,
  target: Readonly<AssistantSavedNoteTarget>,
): AssistantSavedNoteOpenState | null {
  const targetKey = assistantSavedNoteTargetKey(target);
  return current?.targetKey === targetKey
    ? {
        ...current,
        opening: false,
      }
    : current;
}

export function assistantSavedNoteNavigationError(error: unknown): Error {
  if (
    error instanceof AssistantSavedNoteSupersededError ||
    error instanceof AssistantSavedNoteUnavailableError
  ) {
    return error;
  }
  if (error instanceof Error && error.message.trim().length > 0) {
    const message = error.message.replace(/^Error invoking remote method '[^']+':\s*/u, '').trim();
    if (message.includes('不可用') || message.includes('归档')) {
      return new Error(message, { cause: error });
    }
  }
  return new Error('无法打开已保存的笔记，请重试。', { cause: error });
}

function sameAssistantSavedNoteTarget(
  expected: Readonly<AssistantSavedNoteTarget>,
  current: AssistantSavedNoteTarget | null,
): boolean {
  return (
    current !== null &&
    current.responseKey === expected.responseKey &&
    current.workspaceId === expected.workspaceId &&
    current.noteId === expected.noteId &&
    current.noteTitle === expected.noteTitle
  );
}
