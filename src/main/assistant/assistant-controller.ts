import { randomUUID } from 'node:crypto';
import type {
  AssistantCancelInput,
  AssistantContextSummary,
  AssistantCredentialInput,
  AssistantCredentialStatus,
  AssistantError,
  AssistantSnapshot,
  AssistantStartInput,
} from '../../shared/contracts';
import { ASSISTANT_RESPONSE_MAX_LENGTH } from '../../shared/assistant-domain';
import { normalizeWorkspaceId } from '../../shared/workspace-domain';
import type {
  AssistantContextBuilder,
  ResolvedAssistantContext,
} from './assistant-context-builder';
import type { AssistantCredentialStore } from './assistant-credential-store';
import {
  AssistantContextError,
  AssistantCredentialError,
  AssistantProviderError,
} from './assistant-errors';
import type { AssistantProvider } from './openai-responses-provider';

interface ActiveAssistantRun {
  readonly id: string;
  readonly workspaceId: string;
  readonly abort: AbortController;
  promise: Promise<void>;
  cancellationPromise?: Promise<void>;
}

interface ActiveAssistantSetup {
  readonly generation: number;
  readonly workspaceId: string;
  readonly workspaceEpoch: number;
  readonly abort: AbortController;
}

export const ASSISTANT_CANCEL_WAIT_MS = 5_000;

export interface AssistantControllerOptions {
  readonly initialWorkspaceId: string;
  readonly contextBuilder: AssistantContextBuilder;
  readonly credentialStore: AssistantCredentialStore;
  readonly provider: AssistantProvider;
  readonly onChanged?: (snapshot: AssistantSnapshot) => void;
  readonly now?: () => Date;
  readonly idFactory?: () => string;
}

export class AssistantController {
  readonly #contextBuilder: AssistantContextBuilder;
  readonly #credentialStore: AssistantCredentialStore;
  readonly #provider: AssistantProvider;
  readonly #onChanged: (snapshot: AssistantSnapshot) => void;
  readonly #now: () => Date;
  readonly #idFactory: () => string;
  readonly #snapshots = new Map<string, AssistantSnapshot>();
  #currentWorkspaceId: string;
  #activeSetup: ActiveAssistantSetup | null = null;
  #activeRun: ActiveAssistantRun | null = null;
  #controlQueue: Promise<void> = Promise.resolve();
  #workspaceEpoch = 0;
  #startGeneration = 0;
  #sequence = 0;
  #stopped = false;

  constructor({
    initialWorkspaceId,
    contextBuilder,
    credentialStore,
    provider,
    onChanged = () => undefined,
    now = () => new Date(),
    idFactory = randomUUID,
  }: AssistantControllerOptions) {
    this.#currentWorkspaceId = normalizeWorkspaceId(initialWorkspaceId);
    this.#contextBuilder = contextBuilder;
    this.#credentialStore = credentialStore;
    this.#provider = provider;
    this.#onChanged = onChanged;
    this.#now = now;
    this.#idFactory = idFactory;
    this.#snapshots.set(this.#currentWorkspaceId, idleSnapshot(this.#currentWorkspaceId));
  }

  getCredentialStatus(): Promise<AssistantCredentialStatus> {
    return this.#credentialStore.getStatus();
  }

  configureCredential(input: AssistantCredentialInput): Promise<AssistantCredentialStatus> {
    return this.#serializeControl(async () => {
      this.#requireRunningController();
      await this.cancelActive();
      this.#requireRunningController();
      return this.#credentialStore.save(input.apiKey);
    });
  }

  removeCredential(): Promise<AssistantCredentialStatus> {
    return this.#serializeControl(async () => {
      this.#requireRunningController();
      await this.cancelActive();
      this.#requireRunningController();
      return this.#credentialStore.remove();
    });
  }

  getSnapshot(): AssistantSnapshot {
    return this.#snapshotFor(this.#currentWorkspaceId);
  }

  start(input: AssistantStartInput): Promise<AssistantSnapshot> {
    const startGeneration = this.#startGeneration;
    return this.#serializeControl(async () => this.#startUnlocked(input, startGeneration));
  }

  cancel(input: AssistantCancelInput): Promise<AssistantSnapshot> {
    return this.#serializeControl(async () => {
      const run = this.#activeRun;
      if (!run || run.id !== input.runId || run.workspaceId !== this.#currentWorkspaceId) {
        throw new Error('The assistant run is no longer active.');
      }
      await this.#cancelRun(run);
      return this.#snapshotFor(this.#currentWorkspaceId);
    });
  }

  setActiveWorkspace(workspaceId: string): void {
    const normalized = normalizeWorkspaceId(workspaceId);
    if (normalized === this.#currentWorkspaceId) return;
    this.#invalidatePendingStarts();
    this.#abortActiveSetup();
    this.#workspaceEpoch += 1;
    const activeRun = this.#activeRun;
    if (activeRun) {
      void this.#cancelRun(activeRun);
    }
    this.#currentWorkspaceId = normalized;
    this.#update(normalized, this.#snapshotFor(normalized));
  }

  discardWorkspace(workspaceId: string): void {
    const normalized = normalizeWorkspaceId(workspaceId);
    if (normalized === this.#currentWorkspaceId) {
      this.#invalidatePendingStarts();
      this.#abortActiveSetup(normalized);
    }
    const activeRun = this.#activeRun;
    if (activeRun?.workspaceId === normalized) {
      void this.#cancelRun(activeRun);
    }
    this.#snapshots.delete(normalized);
  }

  async cancelActive(): Promise<void> {
    this.#invalidatePendingStarts();
    this.#abortActiveSetup();
    const run = this.#activeRun;
    if (!run) return;
    await this.#cancelRun(run);
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.#invalidatePendingStarts();
    this.#abortActiveSetup();
    const pendingControl = this.#controlQueue;
    await settleWithin(pendingControl, ASSISTANT_CANCEL_WAIT_MS);
    const run = this.#activeRun;
    if (run) {
      await this.#cancelRun(run);
    }
  }

  async #startUnlocked(
    input: AssistantStartInput,
    startGeneration: number,
  ): Promise<AssistantSnapshot> {
    this.#requireViableStart(startGeneration);
    if (this.#activeRun) {
      throw new Error('Only one assistant response can run at a time.');
    }

    const setup: ActiveAssistantSetup = {
      generation: startGeneration,
      workspaceId: this.#currentWorkspaceId,
      workspaceEpoch: this.#workspaceEpoch,
      abort: new AbortController(),
    };
    this.#activeSetup = setup;
    try {
      return await this.#finishStart(input, setup);
    } finally {
      if (this.#activeSetup === setup) {
        this.#activeSetup = null;
      }
    }
  }

  async #finishStart(
    input: AssistantStartInput,
    setup: ActiveAssistantSetup,
  ): Promise<AssistantSnapshot> {
    let context: ResolvedAssistantContext;
    try {
      context = await this.#contextBuilder.resolve(input.context, setup.abort.signal);
    } catch (error) {
      this.#requireViableSetup(setup);
      return this.#recordSetupFailure(input, setup.workspaceId, contextError(error));
    }
    this.#requireViableSetup(setup);
    if (
      context.workspaceId !== setup.workspaceId ||
      setup.workspaceEpoch !== this.#workspaceEpoch ||
      setup.workspaceId !== this.#currentWorkspaceId
    ) {
      return this.#recordSetupFailure(input, setup.workspaceId, {
        code: 'invalid-context',
        message: 'The active workspace changed while the assistant request was starting.',
      });
    }

    let apiKey: string | null;
    try {
      apiKey = await this.#credentialStore.read();
    } catch (error) {
      this.#requireViableSetup(setup);
      return this.#recordSetupFailure(input, setup.workspaceId, credentialError(error), context);
    }
    this.#requireViableSetup(setup);
    if (!apiKey) {
      return this.#recordSetupFailure(
        input,
        setup.workspaceId,
        {
          code: 'not-configured',
          message: 'Configure an OpenAI API key before starting the assistant.',
        },
        context,
      );
    }
    if (
      setup.workspaceEpoch !== this.#workspaceEpoch ||
      setup.workspaceId !== this.#currentWorkspaceId
    ) {
      return this.#recordSetupFailure(
        input,
        setup.workspaceId,
        {
          code: 'invalid-context',
          message: 'The active workspace changed while the assistant request was starting.',
        },
        context,
      );
    }

    const run: ActiveAssistantRun = {
      id: this.#newRunId(),
      workspaceId: setup.workspaceId,
      abort: new AbortController(),
      promise: Promise.resolve(),
    };
    this.#activeRun = run;
    const startedAt = this.#timestamp();
    this.#update(run.workspaceId, {
      sequence: 0,
      workspaceId: run.workspaceId,
      phase: 'running',
      runId: run.id,
      prompt: input.prompt,
      context: context.reference,
      contextSummary: context.summary,
      response: '',
      startedAt,
      completedAt: null,
      error: null,
    });
    run.promise = this.#executeRun(run, apiKey, input.prompt, context.serialized);
    return this.#snapshotFor(run.workspaceId);
  }

  async #executeRun(
    run: ActiveAssistantRun,
    apiKey: string,
    prompt: string,
    serializedContext: string,
  ): Promise<void> {
    try {
      await this.#provider.stream({
        apiKey,
        prompt,
        serializedContext,
        signal: run.abort.signal,
        onDelta: (delta) => {
          if (this.#activeRun !== run || run.abort.signal.aborted) return;
          const current = this.#snapshotFor(run.workspaceId);
          if (current.phase !== 'running' || current.runId !== run.id) return;
          const response = current.response + delta;
          if (response.length > ASSISTANT_RESPONSE_MAX_LENGTH) {
            run.abort.abort();
            this.#markFailed(run, {
              code: 'response-too-large',
              message: 'The assistant response exceeded its safe length.',
            });
            return;
          }
          this.#update(run.workspaceId, { ...current, response });
        },
      });
      if (this.#activeRun !== run || run.abort.signal.aborted) return;
      const current = this.#snapshotFor(run.workspaceId);
      if (current.phase === 'running' && current.runId === run.id) {
        this.#update(run.workspaceId, {
          ...current,
          phase: 'completed',
          completedAt: this.#timestamp(),
        });
      }
    } catch (error) {
      if (this.#activeRun !== run || run.abort.signal.aborted) return;
      this.#markFailed(run, providerError(error));
    } finally {
      if (this.#activeRun === run) {
        this.#activeRun = null;
      }
    }
  }

  async #cancelRun(run: ActiveAssistantRun): Promise<void> {
    if (run.cancellationPromise) return run.cancellationPromise;
    run.cancellationPromise = (async () => {
      if (this.#activeRun !== run) return;
      this.#markCancelled(run);
      run.abort.abort();
      await settleWithin(run.promise, ASSISTANT_CANCEL_WAIT_MS);
    })();
    return run.cancellationPromise;
  }

  #markCancelled(run: ActiveAssistantRun): void {
    const current = this.#snapshotFor(run.workspaceId);
    if (current.phase !== 'running' || current.runId !== run.id) return;
    this.#update(run.workspaceId, {
      ...current,
      phase: 'cancelled',
      completedAt: this.#timestamp(),
      error: null,
    });
  }

  #markFailed(run: ActiveAssistantRun, error: AssistantError): void {
    const current = this.#snapshotFor(run.workspaceId);
    if (current.phase !== 'running' || current.runId !== run.id) return;
    this.#update(run.workspaceId, {
      ...current,
      phase: 'failed',
      completedAt: this.#timestamp(),
      error,
    });
  }

  #recordSetupFailure(
    input: AssistantStartInput,
    workspaceId: string,
    error: AssistantError,
    context?: ResolvedAssistantContext,
  ): AssistantSnapshot {
    const timestamp = this.#timestamp();
    const snapshot: AssistantSnapshot = {
      sequence: 0,
      workspaceId,
      phase: 'failed',
      runId: this.#newRunId(),
      prompt: input.prompt,
      context: context?.reference ?? input.context,
      contextSummary: context?.summary ?? fallbackContextSummary(input.context.kind),
      response: '',
      startedAt: timestamp,
      completedAt: timestamp,
      error,
    };
    this.#update(workspaceId, snapshot);
    return snapshot;
  }

  #serializeControl<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#controlQueue.then(operation, operation);
    this.#controlQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  #snapshotFor(workspaceId: string): AssistantSnapshot {
    return this.#snapshots.get(workspaceId) ?? idleSnapshot(workspaceId);
  }

  #update(workspaceId: string, snapshot: AssistantSnapshot): void {
    const sequenced = { ...snapshot, sequence: ++this.#sequence };
    this.#snapshots.set(workspaceId, sequenced);
    this.#emit(sequenced);
  }

  #emit(snapshot: AssistantSnapshot): void {
    try {
      this.#onChanged(snapshot);
    } catch {
      // Renderer delivery is best-effort and cannot corrupt Main-owned run state.
    }
  }

  #timestamp(): string {
    return this.#now().toISOString();
  }

  #newRunId(): string {
    return normalizeWorkspaceId(this.#idFactory());
  }

  #invalidatePendingStarts(): void {
    this.#startGeneration += 1;
  }

  #abortActiveSetup(workspaceId?: string): void {
    const setup = this.#activeSetup;
    if (!setup || (workspaceId && setup.workspaceId !== workspaceId)) return;
    setup.abort.abort();
  }

  #requireViableSetup(setup: ActiveAssistantSetup): void {
    this.#requireViableStart(setup.generation);
    setup.abort.signal.throwIfAborted();
  }

  #requireViableStart(startGeneration: number): void {
    this.#requireRunningController();
    if (startGeneration !== this.#startGeneration) {
      throw new Error('The assistant request is no longer current.');
    }
  }

  #requireRunningController(): void {
    if (this.#stopped) {
      throw new Error('The assistant controller is stopped.');
    }
  }
}

function idleSnapshot(workspaceId: string): AssistantSnapshot {
  return {
    sequence: 0,
    workspaceId,
    phase: 'idle',
    runId: null,
    prompt: '',
    context: { kind: 'none' },
    contextSummary: fallbackContextSummary('none'),
    response: '',
    startedAt: null,
    completedAt: null,
    error: null,
  };
}

async function settleWithin(promise: Promise<void>, milliseconds: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, milliseconds);
    timer.unref?.();
  });
  await Promise.race([promise.catch(() => undefined), timeout]);
  if (timer) clearTimeout(timer);
}

function fallbackContextSummary(
  kind: AssistantSnapshot['context']['kind'],
): AssistantContextSummary {
  const labels: Readonly<Record<AssistantSnapshot['context']['kind'], string>> = {
    none: '不附加工作区内容',
    today: '今日',
    tasks: '所选未完成任务',
    note: '所选笔记',
  };
  return {
    kind,
    label: labels[kind],
    includedCount: 0,
    totalCount: 0,
    truncated: false,
  };
}

function contextError(error: unknown): AssistantError {
  return {
    code: 'invalid-context',
    message:
      error instanceof AssistantContextError
        ? error.message
        : 'The assistant context could not be prepared safely.',
  };
}

function credentialError(error: unknown): AssistantError {
  if (error instanceof AssistantCredentialError) {
    return {
      code: 'credential-unavailable',
      message:
        error.reason === 'credential-corrupt'
          ? 'The saved OpenAI credential is corrupt. Remove it and configure it again.'
          : 'Secure credential storage is unavailable.',
    };
  }
  return {
    code: 'credential-unavailable',
    message: 'The saved OpenAI credential could not be read safely.',
  };
}

function providerError(error: unknown): AssistantError {
  if (error instanceof AssistantProviderError) {
    return { code: error.code, message: error.message };
  }
  return {
    code: 'internal-error',
    message: 'The assistant response failed unexpectedly.',
  };
}
