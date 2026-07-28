import type { ScheduleWorkspaceIdentity } from './schedule-state';

export type ScheduleMutationKind = 'create' | 'update' | 'archive' | 'recover';

export interface ScheduleMutationCoordinatorIntent {
  readonly generation: number;
  readonly workspace: ScheduleWorkspaceIdentity;
  readonly workspaceId: string;
  readonly kind: ScheduleMutationKind;
}

/**
 * Keeps schedule mutations and their recovery single-flight per workspace.
 * Activation object identity is part of currency, so leaving and re-entering
 * the same workspace cannot revive an intent from the earlier activation.
 */
export class ScheduleMutationCoordinator {
  #generation = 0;
  readonly #pending = new Map<string, ScheduleMutationCoordinatorIntent>();

  begin(
    workspace: ScheduleWorkspaceIdentity,
    kind: ScheduleMutationKind,
  ): ScheduleMutationCoordinatorIntent | null {
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
    intent: ScheduleMutationCoordinatorIntent,
    currentWorkspace: ScheduleWorkspaceIdentity,
  ): boolean {
    return (
      intent.workspace === currentWorkspace &&
      currentWorkspace.workspaceId === intent.workspaceId &&
      this.isActive(intent)
    );
  }

  isActive(intent: ScheduleMutationCoordinatorIntent): boolean {
    return this.#pending.get(intent.workspaceId) === intent;
  }

  /**
   * A committed result may publish a fail-closed warning into a newer
   * activation of the same workspace. It still cannot commit the old
   * snapshot there; recovery must perform a fresh authoritative read.
   */
  canPublishWarning(
    intent: ScheduleMutationCoordinatorIntent,
    currentWorkspace: ScheduleWorkspaceIdentity,
  ): boolean {
    return currentWorkspace.workspaceId === intent.workspaceId && this.isActive(intent);
  }

  isPending(workspaceId: string | null): boolean {
    return workspaceId !== null && this.#pending.has(workspaceId);
  }

  end(intent: ScheduleMutationCoordinatorIntent): void {
    if (this.#pending.get(intent.workspaceId) === intent) {
      this.#pending.delete(intent.workspaceId);
    }
  }

  invalidateAll(): void {
    this.#pending.clear();
  }
}
