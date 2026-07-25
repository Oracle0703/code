import type { FocusSnapshot, Task, TaskSnapshot } from '../shared/contracts';
import type { FocusWorkspaceIdentity } from './focus-state';

export interface FocusTaskCompletionNotice {
  readonly key: string;
  readonly workspace: FocusWorkspaceIdentity;
  readonly workspaceId: string;
  readonly todayDate: string;
  readonly sessionId: string;
  readonly taskId: string;
  readonly taskTitle: string;
  readonly endedAt: string;
}

export interface FocusTaskCompletionIntent {
  readonly generation: number;
  readonly workspace: FocusWorkspaceIdentity;
  readonly notice: Readonly<FocusTaskCompletionNotice>;
}

export interface FocusTaskCompletionTarget {
  readonly workspaceId: string;
  readonly todayDate: string;
  readonly task: Task;
  readonly alreadyCompleted: boolean;
}

export interface FocusTaskSnapshotRefresh {
  readonly snapshot: TaskSnapshot;
  readonly commit: () => boolean;
}

export interface FocusTaskCompletionActionState {
  readonly completionKey: string;
  readonly pending: boolean;
  readonly error: string | null;
}

export class FocusTaskCompletionCoordinator {
  #generation = 0;

  begin(
    workspace: FocusWorkspaceIdentity,
    notice: FocusTaskCompletionNotice,
  ): FocusTaskCompletionIntent {
    if (
      workspace.workspaceId === null ||
      notice.workspace !== workspace ||
      notice.workspaceId !== workspace.workspaceId
    ) {
      throw new FocusTaskCompletionSupersededError();
    }
    return Object.freeze({
      generation: ++this.#generation,
      workspace,
      notice: Object.freeze({ ...notice }),
    });
  }

  invalidate(): void {
    this.#generation += 1;
  }

  isCurrent(
    intent: FocusTaskCompletionIntent,
    currentWorkspace: FocusWorkspaceIdentity,
    activeSurface: string,
    currentNotice: FocusTaskCompletionNotice | null,
  ): boolean {
    return (
      intent.generation === this.#generation &&
      intent.workspace === currentWorkspace &&
      activeSurface === 'today' &&
      sameFocusTaskCompletion(intent.notice, currentNotice)
    );
  }

  assertCurrent(
    intent: FocusTaskCompletionIntent,
    currentWorkspace: FocusWorkspaceIdentity,
    activeSurface: string,
    currentNotice: FocusTaskCompletionNotice | null,
  ): void {
    if (!this.isCurrent(intent, currentWorkspace, activeSurface, currentNotice)) {
      throw new FocusTaskCompletionSupersededError();
    }
  }
}

export class FocusTaskCompletionGate {
  readonly #pendingKeys = new Set<string>();

  begin(completionKey: string): boolean {
    if (this.#pendingKeys.has(completionKey)) return false;
    this.#pendingKeys.add(completionKey);
    return true;
  }

  end(completionKey: string): void {
    this.#pendingKeys.delete(completionKey);
  }
}

export class FocusTaskCompletionSupersededError extends Error {
  constructor() {
    super('专注收尾已被较新的状态替代。');
    this.name = 'FocusTaskCompletionSupersededError';
  }
}

export class FocusTaskCompletionUnavailableError extends Error {
  constructor() {
    super('这轮专注关联的任务已不可用；它可能已被移除或工作区数据已经变化。');
    this.name = 'FocusTaskCompletionUnavailableError';
  }
}

export function selectFocusTaskCompletionNotice(
  workspace: FocusWorkspaceIdentity,
  snapshot: FocusSnapshot | null,
  dismissedKeys: ReadonlySet<string>,
): FocusTaskCompletionNotice | null {
  if (
    workspace.workspaceId === null ||
    snapshot === null ||
    snapshot.workspaceId !== workspace.workspaceId ||
    snapshot.session !== null
  ) {
    return null;
  }

  const terminal = snapshot.latestTerminal;
  if (
    terminal === null ||
    terminal.status !== 'completed' ||
    terminal.workspaceId !== snapshot.workspaceId ||
    terminal.taskId === null ||
    terminal.taskTitle === null
  ) {
    return null;
  }

  const key = focusTaskCompletionKey({
    workspaceId: terminal.workspaceId,
    todayDate: snapshot.todayDate,
    sessionId: terminal.sessionId,
    taskId: terminal.taskId,
    endedAt: terminal.endedAt,
  });
  if (dismissedKeys.has(key)) return null;

  return Object.freeze({
    key,
    workspace,
    workspaceId: terminal.workspaceId,
    todayDate: snapshot.todayDate,
    sessionId: terminal.sessionId,
    taskId: terminal.taskId,
    taskTitle: terminal.taskTitle,
    endedAt: terminal.endedAt,
  });
}

export async function resolveFocusTaskCompletionTarget(
  intent: FocusTaskCompletionIntent,
  readTasks: () => Promise<FocusTaskSnapshotRefresh>,
  assertCurrent: () => void,
): Promise<FocusTaskCompletionTarget> {
  assertCurrent();
  const refresh = await readTasks();
  assertCurrent();
  const { snapshot } = refresh;
  if (
    snapshot.workspaceId !== intent.notice.workspaceId ||
    snapshot.todayDate !== intent.notice.todayDate
  ) {
    throw new FocusTaskCompletionUnavailableError();
  }
  const task = snapshot.tasks.find(({ id }) => id === intent.notice.taskId);
  if (!task) throw new FocusTaskCompletionUnavailableError();
  assertCurrent();
  if (!refresh.commit()) throw new FocusTaskCompletionSupersededError();
  assertCurrent();
  return {
    workspaceId: intent.notice.workspaceId,
    todayDate: intent.notice.todayDate,
    task,
    alreadyCompleted: task.status === 'completed',
  };
}

export function focusTaskCompletionStarted(completionKey: string): FocusTaskCompletionActionState {
  return { completionKey, pending: true, error: null };
}

export function focusTaskCompletionFailed(
  current: FocusTaskCompletionActionState | null,
  completionKey: string,
  message: string,
): FocusTaskCompletionActionState | null {
  return current?.completionKey === completionKey
    ? { completionKey, pending: false, error: message }
    : current;
}

export function focusTaskCompletionFinished(
  current: FocusTaskCompletionActionState | null,
  completionKey: string,
): FocusTaskCompletionActionState | null {
  return current?.completionKey === completionKey
    ? { completionKey, pending: false, error: null }
    : current;
}

export function focusTaskCompletionError(error: unknown): Error {
  if (
    error instanceof FocusTaskCompletionSupersededError ||
    error instanceof FocusTaskCompletionUnavailableError
  ) {
    return error;
  }
  if (error instanceof Error && error.message.trim().length > 0) {
    const message = error.message.replace(/^Error invoking remote method '[^']+':\s*/u, '').trim();
    if (message.includes('不可用') || message.includes('归档') || message.includes('移除')) {
      return new Error(message, { cause: error });
    }
  }
  return new Error('无法完成这轮专注关联的任务，请重试。', { cause: error });
}

function focusTaskCompletionKey(input: {
  readonly workspaceId: string;
  readonly todayDate: string;
  readonly sessionId: string;
  readonly taskId: string;
  readonly endedAt: string;
}): string {
  return JSON.stringify([
    input.workspaceId,
    input.todayDate,
    input.sessionId,
    input.taskId,
    input.endedAt,
  ]);
}

function sameFocusTaskCompletion(
  expected: Readonly<FocusTaskCompletionNotice>,
  current: FocusTaskCompletionNotice | null,
): boolean {
  return current !== null && current.key === expected.key;
}
