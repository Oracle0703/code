import type { BrowserBounds } from '../shared/contracts';

export interface BrowserViewSyncRequest {
  readonly workspaceId: string;
  readonly bounds: BrowserBounds;
  readonly setBounds: (bounds: BrowserBounds) => Promise<boolean>;
  readonly setVisible: (visible: boolean) => Promise<boolean>;
}

export class BrowserViewSyncCoordinator {
  #generation = 0;
  #workspaceId: string | null = null;
  #tail: Promise<void> = Promise.resolve();

  public synchronize(request: BrowserViewSyncRequest): Promise<boolean> {
    const generation = ++this.#generation;
    this.#workspaceId = request.workspaceId;
    return this.#enqueue(async () => {
      if (!this.#isCurrent(generation, request.workspaceId)) return false;
      if (!(await request.setVisible(false))) return false;
      if (!this.#isCurrent(generation, request.workspaceId)) return false;
      if (!(await request.setBounds(request.bounds))) return false;
      if (!this.#isCurrent(generation, request.workspaceId)) return false;
      const shown = await request.setVisible(true);
      return shown && this.#isCurrent(generation, request.workspaceId);
    });
  }

  public hide(
    workspaceId: string,
    setVisible: (visible: boolean) => Promise<boolean>,
  ): Promise<boolean> {
    if (this.#workspaceId === null || this.#workspaceId === workspaceId) {
      ++this.#generation;
      this.#workspaceId = null;
    }
    return this.#enqueue(() => setVisible(false));
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  #isCurrent(generation: number, workspaceId: string): boolean {
    return generation === this.#generation && workspaceId === this.#workspaceId;
  }
}
