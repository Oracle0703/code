import { randomUUID } from 'node:crypto';
import type {
  WindowCloseReason,
  WindowCloseRequest,
  WindowCloseResponse,
} from '../shared/contracts';

interface PendingCloseRequest {
  readonly request: WindowCloseRequest;
  readonly promise: Promise<boolean>;
  readonly resolve: (approved: boolean) => void;
}

export interface WindowCloseCoordinatorOptions {
  readonly sendRequest: (request: WindowCloseRequest) => void;
  readonly idFactory?: () => string;
}

export class WindowCloseCoordinator {
  readonly #sendRequest;
  readonly #idFactory;
  #ready = false;
  #disposed = false;
  #pending: PendingCloseRequest | null = null;

  public constructor({ sendRequest, idFactory = randomUUID }: WindowCloseCoordinatorOptions) {
    this.#sendRequest = sendRequest;
    this.#idFactory = idFactory;
  }

  public markReady(): void {
    if (!this.#disposed) this.#ready = true;
  }

  public markUnavailable(): void {
    this.#ready = false;
    this.#settlePending(true);
  }

  public requestApproval(reason: WindowCloseReason): Promise<boolean> {
    if (this.#disposed || !this.#ready) return Promise.resolve(true);
    if (this.#pending) return this.#pending.promise;

    let resolve!: (approved: boolean) => void;
    const promise = new Promise<boolean>((resolvePromise) => {
      resolve = resolvePromise;
    });
    const pending: PendingCloseRequest = {
      request: { requestId: this.#idFactory(), reason },
      promise,
      resolve,
    };
    this.#pending = pending;
    try {
      this.#sendRequest(pending.request);
    } catch {
      this.#settlePending(false);
    }
    return promise;
  }

  public respond(response: WindowCloseResponse): void {
    if (response.requestId !== this.#pending?.request.requestId) return;
    this.#settlePending(response.approved);
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#ready = false;
    this.#settlePending(true);
  }

  #settlePending(approved: boolean): void {
    const pending = this.#pending;
    if (!pending) return;
    this.#pending = null;
    pending.resolve(approved);
  }
}
