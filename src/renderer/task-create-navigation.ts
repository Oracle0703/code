import type { Task, TaskSnapshot } from '../shared/contracts';

const TASK_CREATE_TITLE_SUMMARY_MAX_LENGTH = 96;

export interface TaskCreateWorkspaceIdentity {
  readonly workspaceId: string | null;
}

export interface TaskCreateRequestIntent {
  readonly generation: number;
  readonly workspace: TaskCreateWorkspaceIdentity;
}

export interface TaskCreateFeedback {
  readonly requestGeneration: number;
  readonly workspaceId: string;
  readonly createdTaskId: string;
  readonly title: string;
  readonly plannedFor: string | null;
}

export interface TaskCreateOpenIntent {
  readonly generation: number;
  readonly workspace: TaskCreateWorkspaceIdentity;
  readonly feedback: Readonly<TaskCreateFeedback>;
}

export interface TaskCreateSnapshotRefresh {
  readonly snapshot: TaskSnapshot;
  readonly commit: () => boolean;
}

export interface TaskCreateNavigationTarget {
  readonly workspaceId: string;
  readonly task: Task;
}

export interface TaskCreateOpenState {
  readonly feedbackKey: string;
  readonly opening: boolean;
  readonly error: string | null;
  readonly errorFocusKey: string | null;
}

export function createTaskCreateWorkspaceIdentity(
  workspaceId: string | null,
): TaskCreateWorkspaceIdentity {
  return Object.freeze({ workspaceId });
}

export function taskCreateTitleSummary(title: string): string {
  const normalized = title.trim().replace(/\s+/gu, ' ');
  const codePoints = Array.from(normalized);
  if (codePoints.length <= TASK_CREATE_TITLE_SUMMARY_MAX_LENGTH) return normalized;
  return `${codePoints.slice(0, TASK_CREATE_TITLE_SUMMARY_MAX_LENGTH - 1).join('')}…`;
}

export function taskCreateFeedbackKey(feedback: Readonly<TaskCreateFeedback>): string {
  return JSON.stringify([
    feedback.requestGeneration,
    feedback.workspaceId,
    feedback.createdTaskId,
    feedback.title,
    feedback.plannedFor,
  ]);
}

export function sameTaskCreateFeedback(
  expected: Readonly<TaskCreateFeedback>,
  current: Readonly<TaskCreateFeedback> | null,
): boolean {
  return current !== null && taskCreateFeedbackKey(expected) === taskCreateFeedbackKey(current);
}

/**
 * Owns the generation shared by manual task creation and explicit opening.
 *
 * Starting a newer create supersedes both older feedback and an in-flight
 * open. Workspace activations are compared by identity so an A → B → A cycle
 * cannot revive work started in the first A.
 */
export class TaskCreateCoordinator {
  #generation = 0;
  #openGeneration = 0;
  #workspace: TaskCreateWorkspaceIdentity | null = null;
  #pendingCreate: TaskCreateRequestIntent | null = null;

  beginCreate(workspace: TaskCreateWorkspaceIdentity): TaskCreateRequestIntent {
    if (workspace.workspaceId === null) throw new TaskCreateSupersededError();
    if (this.#pendingCreate !== null) throw new TaskCreateInProgressError();
    this.#workspace = workspace;
    this.#openGeneration += 1;
    const intent = Object.freeze({
      generation: ++this.#generation,
      workspace,
    });
    this.#pendingCreate = intent;
    return intent;
  }

  endCreate(intent: TaskCreateRequestIntent): void {
    if (this.#pendingCreate === intent) this.#pendingCreate = null;
  }

  isCreateCurrent(
    intent: TaskCreateRequestIntent,
    currentWorkspace: TaskCreateWorkspaceIdentity,
  ): boolean {
    return (
      intent.generation === this.#generation &&
      intent.workspace === this.#workspace &&
      intent.workspace === currentWorkspace &&
      intent.workspace.workspaceId !== null
    );
  }

  assertCreateCurrent(
    intent: TaskCreateRequestIntent,
    currentWorkspace: TaskCreateWorkspaceIdentity,
  ): void {
    if (!this.isCreateCurrent(intent, currentWorkspace)) {
      throw new TaskCreateSupersededError();
    }
  }

  createFeedback(
    intent: TaskCreateRequestIntent,
    currentWorkspace: TaskCreateWorkspaceIdentity,
    createdTask: Readonly<Task>,
    committed: boolean,
  ): TaskCreateFeedback {
    this.assertCreateCurrent(intent, currentWorkspace);
    if (!committed) throw new TaskCreateSupersededError();
    return Object.freeze({
      requestGeneration: intent.generation,
      workspaceId: intent.workspace.workspaceId!,
      createdTaskId: createdTask.id,
      title: createdTask.title,
      plannedFor: createdTask.plannedFor,
    });
  }

  beginOpen(
    workspace: TaskCreateWorkspaceIdentity,
    feedback: TaskCreateFeedback,
  ): TaskCreateOpenIntent {
    if (!this.isFeedbackCurrent(workspace, feedback, feedback)) {
      throw new TaskCreateSupersededError();
    }
    return Object.freeze({
      generation: ++this.#openGeneration,
      workspace,
      feedback: Object.freeze({ ...feedback }),
    });
  }

  isFeedbackCurrent(
    currentWorkspace: TaskCreateWorkspaceIdentity,
    expectedFeedback: Readonly<TaskCreateFeedback>,
    currentFeedback: Readonly<TaskCreateFeedback> | null,
  ): boolean {
    return (
      this.#workspace === currentWorkspace &&
      currentWorkspace.workspaceId !== null &&
      currentWorkspace.workspaceId === expectedFeedback.workspaceId &&
      expectedFeedback.requestGeneration === this.#generation &&
      sameTaskCreateFeedback(expectedFeedback, currentFeedback)
    );
  }

  isOpenCurrent(
    intent: TaskCreateOpenIntent,
    currentWorkspace: TaskCreateWorkspaceIdentity,
    currentFeedback: TaskCreateFeedback | null,
  ): boolean {
    return (
      intent.generation === this.#openGeneration &&
      intent.workspace === currentWorkspace &&
      intent.workspace === this.#workspace &&
      this.isFeedbackCurrent(currentWorkspace, intent.feedback, currentFeedback)
    );
  }

  assertOpenCurrent(
    intent: TaskCreateOpenIntent,
    currentWorkspace: TaskCreateWorkspaceIdentity,
    currentFeedback: TaskCreateFeedback | null,
  ): void {
    if (!this.isOpenCurrent(intent, currentWorkspace, currentFeedback)) {
      throw new TaskCreateSupersededError();
    }
  }

  dismiss(
    feedback: Readonly<TaskCreateFeedback>,
    currentWorkspace: TaskCreateWorkspaceIdentity,
    currentFeedback: Readonly<TaskCreateFeedback> | null,
  ): boolean {
    if (!this.isFeedbackCurrent(currentWorkspace, feedback, currentFeedback)) return false;
    this.invalidate();
    return true;
  }

  cancelOpen(): void {
    this.#openGeneration += 1;
  }

  invalidate(): void {
    this.#generation += 1;
    this.#openGeneration += 1;
    this.#workspace = null;
    this.#pendingCreate = null;
  }
}

export class TaskCreateOpenGate {
  readonly #pending = new Map<string, Readonly<TaskCreateFeedback>>();

  begin(feedback: Readonly<TaskCreateFeedback>): boolean {
    const key = taskCreateFeedbackKey(feedback);
    if (this.#pending.has(key)) return false;
    this.#pending.set(key, feedback);
    return true;
  }

  end(feedback: Readonly<TaskCreateFeedback>): void {
    const key = taskCreateFeedbackKey(feedback);
    if (this.#pending.get(key) === feedback) this.#pending.delete(key);
  }
}

export class TaskCreateSupersededError extends Error {
  constructor() {
    super('新建任务结果已被较新的状态替代。');
    this.name = 'TaskCreateSupersededError';
  }
}

export class TaskCreateInProgressError extends Error {
  constructor() {
    super('正在创建另一项任务，请稍候。');
    this.name = 'TaskCreateInProgressError';
  }
}

export class TaskCreateUnavailableError extends Error {
  constructor() {
    super('刚创建的任务已不可用；任务或工作区数据可能已经变化。');
    this.name = 'TaskCreateUnavailableError';
  }
}

export class TaskCreateNoteDraftPreservedError extends Error {
  constructor() {
    super('已取消打开任务；当前笔记仍保留未保存的更改。');
    this.name = 'TaskCreateNoteDraftPreservedError';
  }
}

export async function resolveTaskCreateNavigationTarget(
  intent: TaskCreateOpenIntent,
  readTask: () => Promise<TaskCreateSnapshotRefresh>,
  assertCurrent: () => void,
): Promise<TaskCreateNavigationTarget> {
  assertCurrent();
  const refresh = await readTask();
  assertCurrent();
  const { feedback } = intent;
  if (refresh.snapshot.workspaceId !== feedback.workspaceId) {
    throw new TaskCreateUnavailableError();
  }
  const matches = refresh.snapshot.tasks.filter(({ id }) => id === feedback.createdTaskId);
  if (matches.length !== 1) throw new TaskCreateUnavailableError();
  assertCurrent();
  if (!refresh.commit()) throw new TaskCreateUnavailableError();
  assertCurrent();
  return {
    workspaceId: feedback.workspaceId,
    task: matches[0]!,
  };
}

export function taskCreateOpenStarted(feedback: Readonly<TaskCreateFeedback>): TaskCreateOpenState {
  return {
    feedbackKey: taskCreateFeedbackKey(feedback),
    opening: true,
    error: null,
    errorFocusKey: null,
  };
}

export function taskCreateOpenFailed(
  current: TaskCreateOpenState | null,
  feedback: Readonly<TaskCreateFeedback>,
  message: string,
  errorFocusKey: string,
): TaskCreateOpenState | null {
  const feedbackKey = taskCreateFeedbackKey(feedback);
  return current?.feedbackKey === feedbackKey
    ? {
        feedbackKey,
        opening: false,
        error: message,
        errorFocusKey,
      }
    : current;
}

export function taskCreateOpenFinished(
  current: TaskCreateOpenState | null,
  feedback: Readonly<TaskCreateFeedback>,
): TaskCreateOpenState | null {
  const feedbackKey = taskCreateFeedbackKey(feedback);
  return current?.feedbackKey === feedbackKey
    ? {
        ...current,
        opening: false,
      }
    : current;
}

export function taskCreateNavigationError(error: unknown): Error {
  if (
    error instanceof TaskCreateSupersededError ||
    error instanceof TaskCreateUnavailableError ||
    error instanceof TaskCreateNoteDraftPreservedError
  ) {
    return error;
  }
  return new Error('无法打开刚创建的任务，请重试。', { cause: error });
}
