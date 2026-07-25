import type { FocusSnapshot, Task, TaskSnapshot } from '../shared/contracts';
import { FOCUS_DURATION_SECONDS } from '../shared/focus-domain';
import { toLocalDateKey } from './task-state';

export { FOCUS_DURATION_SECONDS };

export interface FocusWorkspaceIdentity {
  readonly workspaceId: string | null;
}

export interface FocusRequestIdentity {
  readonly workspace: FocusWorkspaceIdentity;
  readonly workspaceId: string;
  readonly sequence: number;
}

export type FocusAvailabilityStatus = 'loading' | 'ready' | 'error';
export type FocusAvailabilityOperation = 'start' | 'pause' | 'resume' | 'cancel' | null;

export interface FocusTaskSelection {
  readonly task: Task | null;
  readonly taskId: string | undefined;
  readonly invalid: boolean;
}

export function createFocusWorkspaceIdentity(workspaceId: string | null): FocusWorkspaceIdentity {
  return { workspaceId };
}

export function isFocusDialogActivationCurrent(
  dialogActivation: FocusWorkspaceIdentity,
  currentActivation: FocusWorkspaceIdentity,
  currentWorkspaceId: string | null,
): boolean {
  return (
    dialogActivation === currentActivation &&
    dialogActivation.workspaceId !== null &&
    dialogActivation.workspaceId === currentWorkspaceId
  );
}

export function createFocusRequestIdentity(
  workspace: FocusWorkspaceIdentity,
  sequence: number,
): FocusRequestIdentity | null {
  if (workspace.workspaceId === null || !Number.isSafeInteger(sequence) || sequence < 0) {
    return null;
  }
  return {
    workspace,
    workspaceId: workspace.workspaceId,
    sequence,
  };
}

export function isFocusRequestCurrent(
  current: FocusWorkspaceIdentity,
  request: FocusRequestIdentity,
): boolean {
  return current === request.workspace;
}

export function shouldApplyFocusSnapshot(
  current: FocusWorkspaceIdentity,
  lastAppliedSequence: number,
  request: FocusRequestIdentity,
  snapshot: FocusSnapshot,
  now: Date,
): boolean {
  return (
    isFocusRequestCurrent(current, request) &&
    snapshot.workspaceId === request.workspaceId &&
    request.sequence > lastAppliedSequence &&
    isFocusSnapshotDateCurrent(snapshot, now)
  );
}

export function isFocusSnapshotDateCurrent(snapshot: FocusSnapshot, now: Date): boolean {
  return snapshot.todayDate === toLocalDateKey(now);
}

export function focusStartUnavailableReason(
  workspaceId: string | null,
  snapshot: FocusSnapshot | null,
  status: FocusAvailabilityStatus,
  operation: FocusAvailabilityOperation,
): string | null {
  if (workspaceId === null) return '当前工作区不可用，无法开始专注。';
  if (operation !== null) return '另一项专注操作正在进行，请稍候。';
  if (status !== 'ready' || snapshot === null || snapshot.workspaceId !== workspaceId) {
    return status === 'error'
      ? '专注状态暂时不可用，请重新同步后再试。'
      : '正在同步专注状态，请稍候。';
  }
  const session = snapshot.session;
  if (session === null) return null;
  if (session.workspaceId === workspaceId) {
    return session.status === 'paused'
      ? '当前工作区已有暂停的专注会话，请先继续或取消该会话。'
      : '当前工作区已有正在运行的专注会话。';
  }
  return `${session.workspaceName}已有${session.status === 'paused' ? '暂停的' : '正在运行的'}专注会话，请先处理该会话。`;
}

export function taskFocusStartUnavailableReason(
  workspaceId: string | null,
  taskSnapshot: TaskSnapshot | null,
  focusSnapshot: FocusSnapshot | null,
  taskStatus: FocusAvailabilityStatus,
  status: FocusAvailabilityStatus,
  operation: FocusAvailabilityOperation,
): string | null {
  const focusReason = focusStartUnavailableReason(workspaceId, focusSnapshot, status, operation);
  if (focusReason !== null) return focusReason;
  return focusTaskOptionsUnavailableReason(workspaceId, taskSnapshot, focusSnapshot, taskStatus);
}

export function focusTaskOptionsUnavailableReason(
  workspaceId: string | null,
  taskSnapshot: TaskSnapshot | null,
  focusSnapshot: FocusSnapshot | null,
  taskStatus: FocusAvailabilityStatus,
): string | null {
  if (taskStatus !== 'ready' || taskSnapshot === null) {
    return taskStatus === 'error'
      ? '任务状态暂时不可用，请重新同步后再试。'
      : '正在同步任务状态，请稍候。';
  }
  if (
    workspaceId === null ||
    focusSnapshot === null ||
    taskSnapshot.workspaceId !== workspaceId ||
    focusSnapshot.workspaceId !== workspaceId ||
    taskSnapshot.todayDate !== focusSnapshot.todayDate
  ) {
    return '任务与专注的日期窗口正在同步，请稍候。';
  }
  return null;
}

export function isTaskEligibleForFocus(task: Task, snapshot: TaskSnapshot | null): boolean {
  if (snapshot === null || task.status === 'completed' || task.plannedFor !== snapshot.todayDate) {
    return false;
  }
  const current = snapshot.tasks.find(({ id }) => id === task.id);
  return (
    current !== undefined &&
    current.status !== 'completed' &&
    current.plannedFor === snapshot.todayDate
  );
}

export function resolveFocusTaskSelection(
  tasks: readonly Task[],
  selectedTaskId: string,
): FocusTaskSelection {
  if (selectedTaskId === '') {
    return { task: null, taskId: undefined, invalid: false };
  }
  const task = tasks.find(({ id }) => id === selectedTaskId) ?? null;
  return {
    task,
    taskId: task?.id,
    invalid: task === null,
  };
}

export function focusRemainingSeconds(
  snapshot: FocusSnapshot | null,
  now: Date | number = Date.now(),
): number {
  const session = snapshot?.session;
  if (!session) return FOCUS_DURATION_SECONDS;

  const storedRemaining = clampSeconds(session.remainingSeconds);
  if (session.status !== 'running' || session.deadlineAt === null) {
    return storedRemaining;
  }

  const observedAt = Date.parse(snapshot.observedAt);
  const deadlineAt = Date.parse(session.deadlineAt);
  const nowAt = now instanceof Date ? now.getTime() : now;
  if (!Number.isFinite(observedAt) || !Number.isFinite(deadlineAt) || !Number.isFinite(nowAt)) {
    return storedRemaining;
  }

  // Never increase the visible timer if the local clock temporarily precedes
  // Main's observation. The stored value remains the upper bound.
  const effectiveNow = Math.max(observedAt, nowAt);
  const deadlineRemaining = Math.max(0, Math.ceil((deadlineAt - effectiveNow) / 1_000));
  return Math.min(storedRemaining, deadlineRemaining);
}

export function focusStableClockNow(
  timeOrigin: number,
  monotonicNow: number,
  fallbackNow: number,
): number {
  const stableNow = timeOrigin + monotonicNow;
  return Number.isFinite(stableNow) ? stableNow : fallbackNow;
}

export function formatFocusTimer(seconds: number): string {
  const bounded = clampSeconds(seconds);
  const minutes = Math.floor(bounded / 60)
    .toString()
    .padStart(2, '0');
  const remainingSeconds = (bounded % 60).toString().padStart(2, '0');
  return `${minutes}:${remainingSeconds}`;
}

export function describeFocusTimer(seconds: number): string {
  const bounded = clampSeconds(seconds);
  const minutes = Math.floor(bounded / 60);
  const remainingSeconds = bounded % 60;
  if (minutes === 0) return `剩余 ${remainingSeconds} 秒`;
  if (remainingSeconds === 0) return `剩余 ${minutes} 分钟`;
  return `剩余 ${minutes} 分 ${remainingSeconds} 秒`;
}

function clampSeconds(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(FOCUS_DURATION_SECONDS, Math.max(0, Math.ceil(value)));
}
