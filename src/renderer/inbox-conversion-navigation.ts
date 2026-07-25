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

export function inboxConversionRequestKey(
  workspaceId: string,
  sourceEntryId: string,
  outputKind: InboxConversionOutputKind,
): string {
  return JSON.stringify([workspaceId, sourceEntryId, outputKind]);
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
 * Keeps conversion mutations single-flight per source/kind while allowing a
 * newer, different conversion to become the only request allowed to publish
 * success feedback.
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
    const key = inboxConversionRequestKey(workspace.workspaceId, sourceEntryId, outputKind);
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

  isCurrent(
    intent: InboxConversionRequestIntent,
    currentWorkspace: InboxConversionWorkspaceIdentity,
  ): boolean {
    const workspaceId = intent.workspace.workspaceId;
    if (workspaceId === null) return false;
    const key = inboxConversionRequestKey(workspaceId, intent.sourceEntryId, intent.outputKind);
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
    const key = inboxConversionRequestKey(workspaceId, intent.sourceEntryId, intent.outputKind);
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
