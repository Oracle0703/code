import { normalizeInboxUndoToken } from '../shared/inbox-domain';
import { normalizeWorkspaceId } from '../shared/workspace-domain';
import type { InboxWorkspaceIdentity } from './inbox-state';

export type InboxArchiveCoordinatorKind = 'archive' | 'undo' | 'recover';

export interface InboxArchiveCoordinatorIntent {
  readonly epoch: number;
  readonly generation: number;
  readonly workspace: InboxWorkspaceIdentity;
  readonly workspaceId: string;
  readonly kind: InboxArchiveCoordinatorKind;
  readonly undoToken: string | null;
}

/**
 * Owns one archive/undo/recovery lease per workspace and one undo request per
 * globally opaque token. Database replacement advances the epoch; object
 * identity prevents an old finally block from releasing a replacement lease.
 */
export class InboxArchiveCoordinator {
  #epoch = 0;
  #generation = 0;
  readonly #workspaceLeases = new Map<string, InboxArchiveCoordinatorIntent>();
  readonly #tokenLeases = new Map<string, InboxArchiveCoordinatorIntent>();

  get epoch(): number {
    return this.#epoch;
  }

  begin(
    workspace: InboxWorkspaceIdentity,
    kind: InboxArchiveCoordinatorKind,
    undoToken: string | null = null,
  ): InboxArchiveCoordinatorIntent | null {
    const workspaceId = workspace.workspaceId;
    if (workspaceId === null) return null;
    const normalizedWorkspaceId = normalizeWorkspaceId(workspaceId);
    if (normalizedWorkspaceId !== workspaceId) {
      throw new TypeError('Inbox archive workspace identity must already be normalized.');
    }
    if (kind === 'archive' && undoToken !== null) {
      throw new TypeError('An archive lease cannot own an undo token.');
    }
    if (kind === 'undo' && undoToken === null) {
      throw new TypeError('An undo lease requires an undo token.');
    }
    const normalizedToken = undoToken === null ? null : normalizeInboxUndoToken(undoToken);
    if (
      this.#workspaceLeases.has(workspaceId) ||
      (normalizedToken !== null && this.#tokenLeases.has(normalizedToken))
    ) {
      return null;
    }
    if (this.#generation === Number.MAX_SAFE_INTEGER) {
      throw new RangeError('Inbox archive coordinator generation is exhausted.');
    }
    const intent = Object.freeze({
      epoch: this.#epoch,
      generation: ++this.#generation,
      workspace,
      workspaceId,
      kind,
      undoToken: normalizedToken,
    });
    this.#workspaceLeases.set(workspaceId, intent);
    if (normalizedToken !== null) this.#tokenLeases.set(normalizedToken, intent);
    return intent;
  }

  isCurrent(
    intent: InboxArchiveCoordinatorIntent,
    currentWorkspace: InboxWorkspaceIdentity,
  ): boolean {
    return (
      intent.workspace === currentWorkspace &&
      currentWorkspace.workspaceId === intent.workspaceId &&
      this.isActive(intent)
    );
  }

  isActive(intent: InboxArchiveCoordinatorIntent): boolean {
    return (
      intent.epoch === this.#epoch &&
      this.#workspaceLeases.get(intent.workspaceId) === intent &&
      (intent.undoToken === null || this.#tokenLeases.get(intent.undoToken) === intent)
    );
  }

  canPublishWarning(
    intent: InboxArchiveCoordinatorIntent,
    currentWorkspace: InboxWorkspaceIdentity,
  ): boolean {
    return currentWorkspace.workspaceId === intent.workspaceId && this.isActive(intent);
  }

  isPending(workspaceId: string | null): boolean {
    return workspaceId !== null && this.#workspaceLeases.has(workspaceId);
  }

  isTokenPending(undoToken: string): boolean {
    return this.#tokenLeases.has(normalizeInboxUndoToken(undoToken));
  }

  end(intent: InboxArchiveCoordinatorIntent): void {
    if (this.#workspaceLeases.get(intent.workspaceId) === intent) {
      this.#workspaceLeases.delete(intent.workspaceId);
    }
    if (intent.undoToken !== null && this.#tokenLeases.get(intent.undoToken) === intent) {
      this.#tokenLeases.delete(intent.undoToken);
    }
  }

  invalidate(workspaceId: string): void {
    const normalizedWorkspaceId = normalizeWorkspaceId(workspaceId);
    const intent = this.#workspaceLeases.get(normalizedWorkspaceId);
    if (!intent) return;
    this.#workspaceLeases.delete(normalizedWorkspaceId);
    if (intent.undoToken !== null && this.#tokenLeases.get(intent.undoToken) === intent) {
      this.#tokenLeases.delete(intent.undoToken);
    }
  }

  advanceEpoch(): void {
    if (this.#epoch === Number.MAX_SAFE_INTEGER) {
      throw new RangeError('Inbox archive coordinator epoch is exhausted.');
    }
    this.#epoch += 1;
    this.#workspaceLeases.clear();
    this.#tokenLeases.clear();
  }

  invalidateAll(): void {
    this.advanceEpoch();
  }
}
