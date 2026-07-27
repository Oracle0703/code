import type {
  Task,
  TaskConversionResult,
  TaskCreateResult,
  TaskSnapshot,
} from '../shared/contracts';

export type TaskFilter = 'open' | 'today' | 'completed' | 'all';

export interface TaskWorkspaceIdentity {
  readonly workspaceId: string | null;
}

export interface TaskRequestIdentity {
  readonly workspace: TaskWorkspaceIdentity;
  readonly workspaceId: string;
  readonly sequence: number;
}

export interface TaskSnapshotState {
  readonly activation: TaskWorkspaceIdentity;
  readonly snapshot: TaskSnapshot;
}

export interface TaskCreateSnapshotRefresh {
  readonly snapshot: TaskSnapshot;
  readonly commit: () => boolean;
}

export interface TaskCreateReconciliation {
  readonly createdTask: Task | null;
  readonly committed: boolean;
  readonly error: unknown;
}

interface TaskCreateReconciliationInput {
  readonly expectedWorkspaceId: string;
  readonly result: TaskCreateResult;
  readonly commitResultSnapshot: () => boolean;
  readonly getCommittedTask: () => Task | null;
  readonly prepareSnapshotRefresh: () => Promise<TaskCreateSnapshotRefresh>;
  readonly isCurrent: () => boolean;
}

const TASK_CREATE_REFRESH_ATTEMPTS = 2;

export function createTaskWorkspaceIdentity(workspaceId: string | null): TaskWorkspaceIdentity {
  return { workspaceId };
}

export function createTaskRequestIdentity(
  workspace: TaskWorkspaceIdentity,
  sequence: number,
): TaskRequestIdentity | null {
  if (workspace.workspaceId === null || !Number.isSafeInteger(sequence) || sequence < 0) {
    return null;
  }
  return {
    workspace,
    workspaceId: workspace.workspaceId,
    sequence,
  };
}

export function isTaskRequestCurrent(
  currentWorkspace: TaskWorkspaceIdentity,
  request: TaskRequestIdentity,
): boolean {
  return (
    currentWorkspace === request.workspace && currentWorkspace.workspaceId === request.workspaceId
  );
}

export function isTaskSequenceCurrent(sequence: number, lastAppliedSequence: number): boolean {
  return Number.isSafeInteger(sequence) && sequence >= 0 && sequence >= lastAppliedSequence;
}

export function isTaskRequestLatest(sequence: number, latestRequestedSequence: number): boolean {
  return Number.isSafeInteger(sequence) && sequence >= 0 && sequence === latestRequestedSequence;
}

export function isTaskWorkspaceCurrent(
  activeWorkspaceId: string | null,
  snapshot: TaskSnapshot,
): boolean {
  return activeWorkspaceId !== null && snapshot.workspaceId === activeWorkspaceId;
}

export function toLocalDateKey(value: Date): string {
  if (!Number.isFinite(value.getTime())) throw new TypeError('Task date must be valid.');
  const year = value.getFullYear().toString().padStart(4, '0');
  const month = (value.getMonth() + 1).toString().padStart(2, '0');
  const day = value.getDate().toString().padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function millisecondsUntilNextLocalDay(value: Date): number {
  if (!Number.isFinite(value.getTime())) throw new TypeError('Task date must be valid.');
  const nextDay = new Date(value.getFullYear(), value.getMonth(), value.getDate() + 1, 0, 0, 0, 50);
  return Math.max(1, nextDay.getTime() - value.getTime());
}

export function isTaskSnapshotDateCurrent(snapshot: TaskSnapshot, value: Date): boolean {
  return snapshot.todayDate === toLocalDateKey(value);
}

export function shouldApplyTaskSnapshot(
  currentWorkspace: TaskWorkspaceIdentity,
  lastAppliedSequence: number,
  request: TaskRequestIdentity,
  snapshot: TaskSnapshot,
  value: Date,
): boolean {
  return (
    isTaskRequestCurrent(currentWorkspace, request) &&
    snapshot.workspaceId === request.workspaceId &&
    request.sequence > lastAppliedSequence &&
    isTaskSnapshotDateCurrent(snapshot, value)
  );
}

export function taskSnapshotForActivation(
  currentWorkspace: TaskWorkspaceIdentity,
  state: TaskSnapshotState | null,
  value: Date,
): TaskSnapshot | null {
  return state !== null &&
    state.activation === currentWorkspace &&
    state.snapshot.workspaceId === currentWorkspace.workspaceId &&
    isTaskSnapshotDateCurrent(state.snapshot, value)
    ? state.snapshot
    : null;
}

export function convertedTaskFromResult(
  expectedWorkspaceId: string,
  expectedSourceEntryId: string,
  result: TaskConversionResult,
): Task | null {
  return convertedTaskFromSnapshot(
    expectedWorkspaceId,
    expectedSourceEntryId,
    result.createdTaskId,
    result.taskSnapshot,
  );
}

export function convertedTaskFromSnapshot(
  expectedWorkspaceId: string,
  expectedSourceEntryId: string,
  expectedCreatedTaskId: string,
  snapshot: TaskSnapshot,
): Task | null {
  if (snapshot.workspaceId !== expectedWorkspaceId) return null;
  const matches = snapshot.tasks.filter(({ id }) => id === expectedCreatedTaskId);
  const task = matches.length === 1 ? matches[0]! : null;
  return task?.sourceInboxEntryId === expectedSourceEntryId ? task : null;
}

export function createdTaskFromResult(
  expectedWorkspaceId: string,
  result: TaskCreateResult,
): Task | null {
  if (result.taskSnapshot.workspaceId !== expectedWorkspaceId) return null;
  const matches = result.taskSnapshot.tasks.filter(({ id }) => id === result.createdTaskId);
  return matches.length === 1 ? matches[0]! : null;
}

export async function reconcileTaskCreateResult(
  input: TaskCreateReconciliationInput,
): Promise<TaskCreateReconciliation> {
  let createdTask: Task | null = null;
  let committed = false;
  let error: unknown;

  try {
    createdTask = createdTaskFromResult(input.expectedWorkspaceId, input.result);
    committed = createdTask !== null ? input.commitResultSnapshot() : false;
  } catch (caughtError) {
    error = caughtError;
  }

  for (
    let attempt = 0;
    !committed && input.isCurrent() && attempt < TASK_CREATE_REFRESH_ATTEMPTS;
    attempt += 1
  ) {
    try {
      const currentTask = input.getCommittedTask();
      if (currentTask) {
        createdTask = currentTask;
        committed = true;
        break;
      }
    } catch (caughtError) {
      error = caughtError;
    }
    if (!input.isCurrent()) break;

    try {
      const refresh = await input.prepareSnapshotRefresh();
      if (!input.isCurrent()) break;
      const freshTask = createdTaskFromResult(input.expectedWorkspaceId, {
        taskSnapshot: refresh.snapshot,
        createdTaskId: input.result.createdTaskId,
      });
      if (!freshTask) {
        throw new Error('The committed task was not returned by the authoritative refresh.');
      }
      createdTask = freshTask;
      if (refresh.commit()) {
        committed = true;
        break;
      }
      error = new Error('The authoritative task snapshot could not be committed.');
    } catch (caughtError) {
      error = caughtError;
    }
  }

  if (!committed && input.isCurrent()) {
    try {
      const currentTask = input.getCommittedTask();
      if (currentTask) {
        createdTask = currentTask;
        committed = true;
      }
    } catch (caughtError) {
      error = caughtError;
    }
  }

  return { createdTask, committed, error };
}

export function countTasks(tasks: readonly Task[], todayDate: string) {
  let active = 0;
  let today = 0;
  let todayTotal = 0;
  let todayCompleted = 0;
  let completed = 0;

  for (const task of tasks) {
    const isCompleted = task.status === 'completed';
    const isToday = task.plannedFor === todayDate;
    if (isCompleted) completed += 1;
    else active += 1;
    if (isToday) {
      todayTotal += 1;
      if (isCompleted) todayCompleted += 1;
      else today += 1;
    }
  }

  return { active, today, todayTotal, todayCompleted, completed } as const;
}

export function filterTasks(
  tasks: readonly Task[],
  filter: TaskFilter,
  query: string,
  todayDate: string,
): readonly Task[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  return tasks.filter((task) => {
    const matchesFilter =
      filter === 'all' ||
      (filter === 'open' && task.status !== 'completed') ||
      (filter === 'completed' && task.status === 'completed') ||
      (filter === 'today' && task.plannedFor === todayDate);
    return (
      matchesFilter &&
      (!normalizedQuery || task.title.toLocaleLowerCase().includes(normalizedQuery))
    );
  });
}
