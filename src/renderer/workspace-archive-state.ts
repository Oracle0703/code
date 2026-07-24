export type WorkspaceArchiveStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface WorkspaceArchiveLoadRequest {
  readonly session: number;
  readonly sequence: number;
}

export interface WorkspaceArchiveRestoreRequest {
  readonly session: number;
  readonly sequence: number;
  readonly workspaceId: string;
}

/**
 * Keeps the on-demand archive surface isolated from late async responses.
 * A restore is intentionally non-dismissible once Main has accepted the
 * request, while an ordinary list read may be abandoned by closing the dialog.
 */
export class WorkspaceArchiveRequestGate {
  #session = 0;
  #sequence = 0;
  #open = false;
  #activeLoad: WorkspaceArchiveLoadRequest | null = null;
  #activeRestore: WorkspaceArchiveRestoreRequest | null = null;

  open(): { readonly session: number; readonly opened: boolean } {
    if (this.#open) return { session: this.#session, opened: false };
    this.#open = true;
    this.#session += 1;
    this.#activeLoad = null;
    this.#activeRestore = null;
    return { session: this.#session, opened: true };
  }

  beginLoad(): WorkspaceArchiveLoadRequest | null {
    if (!this.#open || this.#activeLoad || this.#activeRestore) return null;
    const request = { session: this.#session, sequence: ++this.#sequence };
    this.#activeLoad = request;
    return request;
  }

  finishLoad(request: WorkspaceArchiveLoadRequest): boolean {
    if (!this.#matchesLoad(request)) return false;
    this.#activeLoad = null;
    return true;
  }

  beginRestore(workspaceId: string): WorkspaceArchiveRestoreRequest | null {
    if (!this.#open || this.#activeLoad || this.#activeRestore) return null;
    const request = {
      session: this.#session,
      sequence: ++this.#sequence,
      workspaceId,
    };
    this.#activeRestore = request;
    return request;
  }

  finishRestore(request: WorkspaceArchiveRestoreRequest): boolean {
    if (!this.#matchesRestore(request)) return false;
    this.#activeRestore = null;
    return true;
  }

  close(): boolean {
    if (this.#activeRestore) return false;
    this.#invalidate();
    return true;
  }

  dispose(): void {
    this.#invalidate();
  }

  isOpen(): boolean {
    return this.#open;
  }

  #matchesLoad(request: WorkspaceArchiveLoadRequest): boolean {
    return (
      this.#open &&
      this.#session === request.session &&
      this.#activeLoad?.sequence === request.sequence
    );
  }

  #matchesRestore(request: WorkspaceArchiveRestoreRequest): boolean {
    return (
      this.#open &&
      this.#session === request.session &&
      this.#activeRestore?.sequence === request.sequence &&
      this.#activeRestore.workspaceId === request.workspaceId
    );
  }

  #invalidate(): void {
    this.#open = false;
    this.#session += 1;
    this.#activeLoad = null;
    this.#activeRestore = null;
  }
}
