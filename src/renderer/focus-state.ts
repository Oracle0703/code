import type { FocusSnapshot } from '../shared/contracts';
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

export function createFocusWorkspaceIdentity(workspaceId: string | null): FocusWorkspaceIdentity {
  return { workspaceId };
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
