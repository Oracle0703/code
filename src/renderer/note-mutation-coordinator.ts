import type { NoteWorkspaceIdentity } from './note-state';

export type NoteMutationKind = 'create' | 'update' | 'archive' | 'inbox-note-convert' | 'recover';

export interface NoteMutationCoordinatorIntent {
  readonly generation: number;
  readonly workspace: NoteWorkspaceIdentity;
  readonly workspaceId: string;
  readonly kind: NoteMutationKind;
}

/**
 * Keeps note mutations and their recovery single-flight per workspace.
 * Activation object identity is part of currency, so leaving and re-entering
 * the same workspace cannot revive an intent from the earlier activation.
 */
export class NoteMutationCoordinator {
  #generation = 0;
  readonly #pending = new Map<string, NoteMutationCoordinatorIntent>();

  begin(
    workspace: NoteWorkspaceIdentity,
    kind: NoteMutationKind,
  ): NoteMutationCoordinatorIntent | null {
    const workspaceId = workspace.workspaceId;
    if (workspaceId === null || this.#pending.has(workspaceId)) return null;
    const intent = Object.freeze({
      generation: ++this.#generation,
      workspace,
      workspaceId,
      kind,
    });
    this.#pending.set(workspaceId, intent);
    return intent;
  }

  isCurrent(
    intent: NoteMutationCoordinatorIntent,
    currentWorkspace: NoteWorkspaceIdentity,
  ): boolean {
    return (
      intent.workspace === currentWorkspace &&
      currentWorkspace.workspaceId === intent.workspaceId &&
      this.isActive(intent)
    );
  }

  isActive(intent: NoteMutationCoordinatorIntent): boolean {
    return this.#pending.get(intent.workspaceId) === intent;
  }

  /**
   * A committed result may publish a fail-closed warning into a newer
   * activation of the same workspace. It still cannot commit the old
   * snapshot there; recovery must perform a fresh authoritative read.
   */
  canPublishWarning(
    intent: NoteMutationCoordinatorIntent,
    currentWorkspace: NoteWorkspaceIdentity,
  ): boolean {
    return currentWorkspace.workspaceId === intent.workspaceId && this.isActive(intent);
  }

  isPending(workspaceId: string | null): boolean {
    return workspaceId !== null && this.#pending.has(workspaceId);
  }

  end(intent: NoteMutationCoordinatorIntent): void {
    if (this.#pending.get(intent.workspaceId) === intent) {
      this.#pending.delete(intent.workspaceId);
    }
  }

  invalidate(workspaceId: string): void {
    this.#pending.delete(workspaceId);
  }

  invalidateAll(): void {
    this.#pending.clear();
  }
}
