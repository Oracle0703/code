import type { Note, NoteSnapshot, Task, TaskSnapshot } from '../shared/contracts';
import type { AutomationRunFeedback, AutomationWorkspaceIdentity } from './automation-state';

export interface AutomationOutputNavigationIntent {
  readonly generation: number;
  readonly workspace: AutomationWorkspaceIdentity;
  readonly feedback: Readonly<AutomationRunFeedback>;
}

export type AutomationOutputNavigationTarget =
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

export interface AutomationOutputSnapshotReaders {
  readonly task: () => Promise<AutomationOutputSnapshotRefresh<TaskSnapshot>>;
  readonly note: () => Promise<AutomationOutputSnapshotRefresh<NoteSnapshot>>;
}

export interface AutomationOutputSnapshotRefresh<Snapshot> {
  readonly snapshot: Snapshot;
  readonly commit: () => boolean;
}

export interface AutomationOutputOpenState {
  readonly outputKey: string;
  readonly opening: boolean;
  readonly error: string | null;
}

export class AutomationOutputNavigationCoordinator {
  #generation = 0;

  begin(
    workspace: AutomationWorkspaceIdentity,
    feedback: AutomationRunFeedback,
  ): AutomationOutputNavigationIntent {
    if (workspace.workspaceId === null || workspace.workspaceId !== feedback.workspaceId) {
      throw new AutomationOutputNavigationSupersededError();
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
    intent: AutomationOutputNavigationIntent,
    currentWorkspace: AutomationWorkspaceIdentity,
    activeSurface: string,
    currentFeedback: AutomationRunFeedback | null,
  ): boolean {
    return (
      intent.generation === this.#generation &&
      intent.workspace === currentWorkspace &&
      intent.workspace.workspaceId === intent.feedback.workspaceId &&
      activeSurface === 'automations' &&
      sameFeedback(intent.feedback, currentFeedback)
    );
  }

  assertCurrent(
    intent: AutomationOutputNavigationIntent,
    currentWorkspace: AutomationWorkspaceIdentity,
    activeSurface: string,
    currentFeedback: AutomationRunFeedback | null,
  ): void {
    if (!this.isCurrent(intent, currentWorkspace, activeSurface, currentFeedback)) {
      throw new AutomationOutputNavigationSupersededError();
    }
  }
}

export class AutomationOutputOpenGate {
  #pendingOutputKey: string | null = null;

  begin(outputKey: string): boolean {
    if (this.#pendingOutputKey === outputKey) return false;
    this.#pendingOutputKey = outputKey;
    return true;
  }

  end(outputKey: string): void {
    if (this.#pendingOutputKey === outputKey) this.#pendingOutputKey = null;
  }
}

export class AutomationOutputNavigationSupersededError extends Error {
  constructor() {
    super('输出导航已被较新的操作替代。');
    this.name = 'AutomationOutputNavigationSupersededError';
  }
}

export function automationOutputOpenStarted(outputKey: string): AutomationOutputOpenState {
  return { outputKey, opening: true, error: null };
}

export function automationOutputOpenFailed(
  current: AutomationOutputOpenState | null,
  outputKey: string,
  message: string,
): AutomationOutputOpenState | null {
  return current?.outputKey === outputKey ? { outputKey, opening: false, error: message } : current;
}

export function automationOutputOpenFinished(
  current: AutomationOutputOpenState | null,
  outputKey: string,
): AutomationOutputOpenState | null {
  return current?.outputKey === outputKey ? { ...current, opening: false } : current;
}

export class AutomationOutputUnavailableError extends Error {
  constructor(outputKind: 'task' | 'note') {
    super(
      outputKind === 'task'
        ? '刚创建的任务已不可用；它可能已被删除或工作区数据已经变化。'
        : '刚创建的笔记已不可用；它可能已被归档或工作区数据已经变化。',
    );
    this.name = 'AutomationOutputUnavailableError';
  }
}

export async function resolveAutomationOutputNavigationTarget(
  intent: AutomationOutputNavigationIntent,
  readers: AutomationOutputSnapshotReaders,
  assertCurrent: () => void,
): Promise<AutomationOutputNavigationTarget> {
  assertCurrent();
  const { feedback } = intent;
  if (feedback.outputKind === 'task') {
    const refresh = await readers.task();
    assertCurrent();
    const { snapshot } = refresh;
    if (snapshot.workspaceId !== feedback.workspaceId) {
      throw new AutomationOutputUnavailableError('task');
    }
    const task = snapshot.tasks.find(({ id }) => id === feedback.outputId);
    if (!task) throw new AutomationOutputUnavailableError('task');
    assertCurrent();
    if (!refresh.commit()) throw new AutomationOutputNavigationSupersededError();
    return { kind: 'task', workspaceId: feedback.workspaceId, task };
  }

  const refresh = await readers.note();
  assertCurrent();
  const { snapshot } = refresh;
  if (snapshot.workspaceId !== feedback.workspaceId) {
    throw new AutomationOutputUnavailableError('note');
  }
  const note = snapshot.notes.find(({ id }) => id === feedback.outputId);
  if (!note) throw new AutomationOutputUnavailableError('note');
  assertCurrent();
  if (!refresh.commit()) throw new AutomationOutputNavigationSupersededError();
  return { kind: 'note', workspaceId: feedback.workspaceId, note };
}

export function automationOutputNavigationError(
  error: unknown,
  outputKind: 'task' | 'note',
): Error {
  if (
    error instanceof AutomationOutputNavigationSupersededError ||
    error instanceof AutomationOutputUnavailableError
  ) {
    return error;
  }
  if (error instanceof Error && error.message.trim().length > 0) {
    const message = error.message.replace(/^Error invoking remote method '[^']+':\s*/u, '').trim();
    if (message.includes('不可用') || message.includes('归档') || message.includes('删除')) {
      return new Error(message, { cause: error });
    }
  }
  return new Error(
    outputKind === 'task' ? '无法打开刚创建的任务，请重试。' : '无法打开刚创建的笔记，请重试。',
    { cause: error },
  );
}

function sameFeedback(
  expected: Readonly<AutomationRunFeedback>,
  current: AutomationRunFeedback | null,
): boolean {
  return (
    current !== null &&
    current.workspaceId === expected.workspaceId &&
    current.automationId === expected.automationId &&
    current.outputKind === expected.outputKind &&
    current.outputId === expected.outputId
  );
}
