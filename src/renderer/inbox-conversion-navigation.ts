import type { Note, NoteSnapshot, Task, TaskSnapshot } from '../shared/contracts';

export type InboxConversionOutputKind = 'task' | 'note';

export interface InboxConversionWorkspaceIdentity {
  readonly workspaceId: string | null;
}

export interface InboxConversionRequestIntent {
  readonly generation: number;
  readonly workspace: InboxConversionWorkspaceIdentity;
  readonly sourceEntryId: string;
  readonly outputKind: InboxConversionOutputKind;
}

export interface InboxConversionFeedback {
  readonly requestGeneration: number;
  readonly workspaceId: string;
  readonly sourceEntryId: string;
  readonly outputKind: InboxConversionOutputKind;
  readonly outputId: string;
  readonly outputTitle: string;
}

export interface InboxConversionFeedbackInput {
  readonly outputId: string;
  readonly outputTitle: string;
}

export interface InboxConversionNavigationIntent {
  readonly generation: number;
  readonly workspace: InboxConversionWorkspaceIdentity;
  readonly feedback: Readonly<InboxConversionFeedback>;
}

export interface InboxConversionSnapshotRefresh<Snapshot> {
  readonly snapshot: Snapshot;
  readonly commit: () => boolean;
}

export interface InboxConversionSnapshotReaders {
  readonly task: () => Promise<InboxConversionSnapshotRefresh<TaskSnapshot>>;
  readonly note: () => Promise<InboxConversionSnapshotRefresh<NoteSnapshot>>;
}

export interface InboxConversionReconciliationInput<Output, OutputSnapshot, InboxSnapshot> {
  readonly initialOutputCommitted: boolean;
  readonly initialInboxCommitted: boolean;
  readonly getCommittedOutput: () => Output | null;
  readonly getCommittedInbox: () => boolean;
  readonly prepareOutputSnapshotRefresh: () => Promise<
    InboxConversionSnapshotRefresh<OutputSnapshot>
  >;
  readonly prepareInboxSnapshotRefresh: () => Promise<
    InboxConversionSnapshotRefresh<InboxSnapshot>
  >;
  readonly outputFromSnapshot: (snapshot: OutputSnapshot) => Output | null;
  readonly inboxSnapshotIsCommitted: (snapshot: InboxSnapshot) => boolean;
  readonly isCurrent: () => boolean;
}

export interface InboxConversionReconciliation<Output> {
  readonly output: Output | null;
  readonly outputCommitted: boolean;
  readonly inboxCommitted: boolean;
  readonly committed: boolean;
  readonly error: unknown;
}

export type InboxConversionNavigationTarget =
  | {
      readonly kind: 'task';
      readonly workspaceId: string;
      readonly task: Task;
    }
  | {
      readonly kind: 'note';
      readonly workspaceId: string;
      readonly note: Note;
    };

export interface InboxConversionOpenState {
  readonly feedbackKey: string;
  readonly opening: boolean;
  readonly error: string | null;
  readonly errorFocusKey: string | null;
}

export function createInboxConversionWorkspaceIdentity(
  workspaceId: string | null,
): InboxConversionWorkspaceIdentity {
  return Object.freeze({ workspaceId });
}

export function inboxConversionRequestKey(workspaceId: string): string {
  return workspaceId;
}

export function inboxConversionFeedbackKey(feedback: Readonly<InboxConversionFeedback>): string {
  return JSON.stringify([
    feedback.requestGeneration,
    feedback.workspaceId,
    feedback.sourceEntryId,
    feedback.outputKind,
    feedback.outputId,
    feedback.outputTitle,
  ]);
}

export function sameInboxConversionFeedback(
  expected: Readonly<InboxConversionFeedback>,
  current: Readonly<InboxConversionFeedback> | null,
): boolean {
  return (
    current !== null && inboxConversionFeedbackKey(expected) === inboxConversionFeedbackKey(current)
  );
}

/**
 * Keeps conversion mutations single-flight for the active workspace. Reconciliation and
 * publication share one workspace generation, so allowing a second source to start before the
 * first one finishes could otherwise silently supersede an already-committed conversion.
 */
export class InboxConversionRequestCoordinator {
  #generation = 0;
  readonly #pending = new Map<string, InboxConversionRequestIntent>();

  begin(
    workspace: InboxConversionWorkspaceIdentity,
    sourceEntryId: string,
    outputKind: InboxConversionOutputKind,
  ): InboxConversionRequestIntent | null {
    if (workspace.workspaceId === null) throw new InboxConversionSupersededError();
    const key = inboxConversionRequestKey(workspace.workspaceId);
    if (this.#pending.has(key)) return null;
    const intent = Object.freeze({
      generation: ++this.#generation,
      workspace,
      sourceEntryId,
      outputKind,
    });
    this.#pending.set(key, intent);
    return intent;
  }

  invalidate(): void {
    this.#generation += 1;
  }

  isGenerationCurrent(generation: number, workspace: InboxConversionWorkspaceIdentity): boolean {
    return generation === this.#generation && workspace.workspaceId !== null;
  }

  isCurrent(
    intent: InboxConversionRequestIntent,
    currentWorkspace: InboxConversionWorkspaceIdentity,
  ): boolean {
    const workspaceId = intent.workspace.workspaceId;
    if (workspaceId === null) return false;
    const key = inboxConversionRequestKey(workspaceId);
    return (
      intent.generation === this.#generation &&
      intent.workspace === currentWorkspace &&
      currentWorkspace.workspaceId === workspaceId &&
      this.#pending.get(key) === intent
    );
  }

  assertCurrent(
    intent: InboxConversionRequestIntent,
    currentWorkspace: InboxConversionWorkspaceIdentity,
  ): void {
    if (!this.isCurrent(intent, currentWorkspace)) {
      throw new InboxConversionSupersededError();
    }
  }

  createFeedback(
    intent: InboxConversionRequestIntent,
    currentWorkspace: InboxConversionWorkspaceIdentity,
    input: InboxConversionFeedbackInput,
  ): InboxConversionFeedback {
    this.assertCurrent(intent, currentWorkspace);
    return Object.freeze({
      requestGeneration: intent.generation,
      workspaceId: intent.workspace.workspaceId!,
      sourceEntryId: intent.sourceEntryId,
      outputKind: intent.outputKind,
      outputId: input.outputId,
      outputTitle: input.outputTitle,
    });
  }

  end(intent: InboxConversionRequestIntent): void {
    const workspaceId = intent.workspace.workspaceId;
    if (workspaceId === null) return;
    const key = inboxConversionRequestKey(workspaceId);
    if (this.#pending.get(key) === intent) this.#pending.delete(key);
  }
}

export class InboxConversionNavigationCoordinator {
  #generation = 0;

  begin(
    workspace: InboxConversionWorkspaceIdentity,
    feedback: InboxConversionFeedback,
  ): InboxConversionNavigationIntent {
    if (workspace.workspaceId === null || workspace.workspaceId !== feedback.workspaceId) {
      throw new InboxConversionSupersededError();
    }
    return Object.freeze({
      generation: ++this.#generation,
      workspace,
      feedback: Object.freeze({ ...feedback }),
    });
  }

  invalidate(): void {
    this.#generation += 1;
  }

  isCurrent(
    intent: InboxConversionNavigationIntent,
    currentWorkspace: InboxConversionWorkspaceIdentity,
    activeSurface: string,
    currentFeedback: InboxConversionFeedback | null,
  ): boolean {
    return (
      intent.generation === this.#generation &&
      intent.workspace === currentWorkspace &&
      intent.workspace.workspaceId === intent.feedback.workspaceId &&
      activeSurface === 'inbox' &&
      sameInboxConversionFeedback(intent.feedback, currentFeedback)
    );
  }

  assertCurrent(
    intent: InboxConversionNavigationIntent,
    currentWorkspace: InboxConversionWorkspaceIdentity,
    activeSurface: string,
    currentFeedback: InboxConversionFeedback | null,
  ): void {
    if (!this.isCurrent(intent, currentWorkspace, activeSurface, currentFeedback)) {
      throw new InboxConversionSupersededError();
    }
  }
}

export class InboxConversionOpenGate {
  readonly #pending = new Map<string, Readonly<InboxConversionFeedback>>();

  begin(feedback: Readonly<InboxConversionFeedback>): boolean {
    const key = inboxConversionFeedbackKey(feedback);
    if (this.#pending.has(key)) return false;
    this.#pending.set(key, feedback);
    return true;
  }

  end(feedback: Readonly<InboxConversionFeedback>): void {
    const key = inboxConversionFeedbackKey(feedback);
    if (this.#pending.get(key) === feedback) this.#pending.delete(key);
  }
}

/**
 * Holds a task-dialog conversion outcome until its modal has closed, so live
 * regions are mounted only after the dialog is no longer the active
 * accessibility surface.
 */
export class InboxConversionPublicationGate<T> {
  #pending: {
    readonly workspace: InboxConversionWorkspaceIdentity;
    readonly value: T;
  } | null = null;

  stage(workspace: InboxConversionWorkspaceIdentity, value: T): void {
    this.#pending = Object.freeze({ workspace, value });
  }

  take(dialogOpen: boolean, currentWorkspace: InboxConversionWorkspaceIdentity): T | null {
    if (dialogOpen || this.#pending === null) return null;
    const pending = this.#pending;
    this.#pending = null;
    return pending.workspace === currentWorkspace ? pending.value : null;
  }

  clear(): void {
    this.#pending = null;
  }
}

export class InboxConversionSupersededError extends Error {
  constructor() {
    super('收件箱转换结果已被较新的状态替代。');
    this.name = 'InboxConversionSupersededError';
  }
}

export class InboxConversionOutputUnavailableError extends Error {
  constructor(outputKind: InboxConversionOutputKind) {
    super(
      outputKind === 'task'
        ? '刚转换的任务已不可用；它可能已变化或不再对应原收件箱记录。'
        : '刚转换的笔记已不可用；它可能已归档、变化或不再对应原收件箱记录。',
    );
    this.name = 'InboxConversionOutputUnavailableError';
  }
}

const INBOX_CONVERSION_RECONCILIATION_ATTEMPTS = 2;

/**
 * Reconciles the two independently stored Renderer snapshots produced by one
 * atomic inbox conversion. Only a missing side is re-read, and success is
 * publishable only while the originating request remains current after every
 * asynchronous and commit boundary.
 */
export async function reconcileInboxConversionSnapshots<Output, OutputSnapshot, InboxSnapshot>(
  input: InboxConversionReconciliationInput<Output, OutputSnapshot, InboxSnapshot>,
): Promise<InboxConversionReconciliation<Output>> {
  let output: Output | null = null;
  let outputCommitted = input.initialOutputCommitted;
  let inboxCommitted = input.initialInboxCommitted;
  let error: unknown;

  const markSuperseded = (): void => {
    error = new InboxConversionSupersededError();
  };

  const recoverCommittedSides = (): void => {
    if (!input.isCurrent()) {
      markSuperseded();
      return;
    }

    if (!outputCommitted || output === null) {
      try {
        const committedOutput = input.getCommittedOutput();
        if (committedOutput === null) {
          if (outputCommitted) {
            outputCommitted = false;
            error = new Error('The committed conversion output is unavailable.');
          }
        } else {
          output = committedOutput;
          outputCommitted = true;
        }
      } catch (caughtError) {
        outputCommitted = false;
        error = caughtError;
      }
    }

    if (!inboxCommitted) {
      try {
        if (input.getCommittedInbox()) inboxCommitted = true;
      } catch (caughtError) {
        error = caughtError;
      }
    }
  };

  recoverCommittedSides();

  reconciliation: for (
    let attempt = 0;
    input.isCurrent() &&
    (!outputCommitted || output === null || !inboxCommitted) &&
    attempt < INBOX_CONVERSION_RECONCILIATION_ATTEMPTS;
    attempt += 1
  ) {
    if (!outputCommitted || output === null) {
      try {
        const refresh = await input.prepareOutputSnapshotRefresh();
        if (!input.isCurrent()) {
          markSuperseded();
          break reconciliation;
        }
        const refreshedOutput = input.outputFromSnapshot(refresh.snapshot);
        if (refreshedOutput === null) {
          throw new Error(
            'The exact conversion output was not returned by the authoritative read.',
          );
        }
        if (!input.isCurrent()) {
          markSuperseded();
          break reconciliation;
        }
        const committed = refresh.commit();
        if (!input.isCurrent()) {
          markSuperseded();
          break reconciliation;
        }
        if (committed) {
          output = refreshedOutput;
          outputCommitted = true;
        } else {
          error = new Error('The authoritative conversion output snapshot could not be committed.');
        }
      } catch (caughtError) {
        error = caughtError;
      }
    }

    if (!input.isCurrent()) {
      markSuperseded();
      break;
    }

    if (!inboxCommitted) {
      try {
        const refresh = await input.prepareInboxSnapshotRefresh();
        if (!input.isCurrent()) {
          markSuperseded();
          break reconciliation;
        }
        if (!input.inboxSnapshotIsCommitted(refresh.snapshot)) {
          throw new Error('The converted inbox source is still present in the authoritative read.');
        }
        if (!input.isCurrent()) {
          markSuperseded();
          break reconciliation;
        }
        const committed = refresh.commit();
        if (!input.isCurrent()) {
          markSuperseded();
          break reconciliation;
        }
        if (committed) {
          inboxCommitted = true;
        } else {
          error = new Error('The authoritative inbox conversion snapshot could not be committed.');
        }
      } catch (caughtError) {
        error = caughtError;
      }
    }

    if (input.isCurrent() && (!outputCommitted || output === null || !inboxCommitted)) {
      recoverCommittedSides();
    }
  }

  if (input.isCurrent() && (!outputCommitted || output === null || !inboxCommitted)) {
    recoverCommittedSides();
  }
  const current = input.isCurrent();
  if (!current) markSuperseded();

  return {
    output,
    outputCommitted,
    inboxCommitted,
    committed: current && output !== null && outputCommitted && inboxCommitted,
    error,
  };
}

export async function resolveInboxConversionNavigationTarget(
  intent: InboxConversionNavigationIntent,
  readers: InboxConversionSnapshotReaders,
  assertCurrent: () => void,
): Promise<InboxConversionNavigationTarget> {
  assertCurrent();
  const { feedback } = intent;
  if (feedback.outputKind === 'task') {
    const refresh = await readers.task();
    assertCurrent();
    const { snapshot } = refresh;
    if (snapshot.workspaceId !== feedback.workspaceId) {
      throw new InboxConversionOutputUnavailableError('task');
    }
    const matches = snapshot.tasks.filter(
      ({ id, sourceInboxEntryId }) =>
        id === feedback.outputId && sourceInboxEntryId === feedback.sourceEntryId,
    );
    if (matches.length !== 1) throw new InboxConversionOutputUnavailableError('task');
    assertCurrent();
    if (!refresh.commit()) throw new InboxConversionSupersededError();
    assertCurrent();
    return {
      kind: 'task',
      workspaceId: feedback.workspaceId,
      task: matches[0]!,
    };
  }

  const refresh = await readers.note();
  assertCurrent();
  const { snapshot } = refresh;
  if (snapshot.workspaceId !== feedback.workspaceId) {
    throw new InboxConversionOutputUnavailableError('note');
  }
  const matches = snapshot.notes.filter(
    ({ id, sourceInboxEntryId }) =>
      id === feedback.outputId && sourceInboxEntryId === feedback.sourceEntryId,
  );
  if (matches.length !== 1) throw new InboxConversionOutputUnavailableError('note');
  assertCurrent();
  if (!refresh.commit()) throw new InboxConversionSupersededError();
  assertCurrent();
  return {
    kind: 'note',
    workspaceId: feedback.workspaceId,
    note: matches[0]!,
  };
}

export function inboxConversionOpenStarted(
  feedback: Readonly<InboxConversionFeedback>,
): InboxConversionOpenState {
  return {
    feedbackKey: inboxConversionFeedbackKey(feedback),
    opening: true,
    error: null,
    errorFocusKey: null,
  };
}

export function inboxConversionOpenFailed(
  current: InboxConversionOpenState | null,
  feedback: Readonly<InboxConversionFeedback>,
  message: string,
  errorFocusKey: string,
): InboxConversionOpenState | null {
  const feedbackKey = inboxConversionFeedbackKey(feedback);
  return current?.feedbackKey === feedbackKey
    ? {
        feedbackKey,
        opening: false,
        error: message,
        errorFocusKey,
      }
    : current;
}

export function inboxConversionOpenFinished(
  current: InboxConversionOpenState | null,
  feedback: Readonly<InboxConversionFeedback>,
): InboxConversionOpenState | null {
  const feedbackKey = inboxConversionFeedbackKey(feedback);
  return current?.feedbackKey === feedbackKey
    ? {
        ...current,
        opening: false,
      }
    : current;
}

export function inboxConversionNavigationError(
  error: unknown,
  outputKind: InboxConversionOutputKind,
): Error {
  if (
    error instanceof InboxConversionSupersededError ||
    error instanceof InboxConversionOutputUnavailableError
  ) {
    return error;
  }
  if (error instanceof Error && error.message.trim().length > 0) {
    const message = error.message.replace(/^Error invoking remote method '[^']+':\s*/u, '').trim();
    if (
      message.includes('不可用') ||
      message.includes('归档') ||
      message.includes('变化') ||
      message.includes('对应')
    ) {
      return new Error(message, { cause: error });
    }
  }
  return new Error(
    outputKind === 'task' ? '无法打开刚转换的任务，请重试。' : '无法打开刚转换的笔记，请重试。',
    { cause: error },
  );
}
