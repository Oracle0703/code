import type { ScheduleCreateResult, ScheduleItem, ScheduleSnapshot } from '../shared/contracts';
import { formatScheduleMinute } from '../shared/schedule-domain';
import { toLocalDateKey } from './task-state';

export interface ScheduleWorkspaceIdentity {
  readonly workspaceId: string | null;
}

export interface ScheduleRequestIdentity {
  readonly workspace: ScheduleWorkspaceIdentity;
  readonly workspaceId: string;
  readonly sequence: number;
}

export interface ScheduleSnapshotState {
  readonly activation: ScheduleWorkspaceIdentity;
  readonly snapshot: ScheduleSnapshot;
}

export interface ScheduleCreateSnapshotRefresh {
  readonly snapshot: ScheduleSnapshot;
  readonly commit: () => boolean;
}

export interface ScheduleCreateReconciliation {
  readonly createdSchedule: ScheduleItem | null;
  readonly committed: boolean;
  readonly error: unknown;
}

interface ScheduleCreateReconciliationInput {
  readonly expectedWorkspaceId: string;
  readonly expectedScheduledFor: string;
  readonly result: ScheduleCreateResult;
  readonly commitResultSnapshot: () => boolean;
  readonly getCommittedSchedule: () => ScheduleItem | null;
  readonly prepareSnapshotRefresh: () => Promise<ScheduleCreateSnapshotRefresh>;
  readonly isCurrent: () => boolean;
}

const SCHEDULE_CREATE_REFRESH_ATTEMPTS = 2;

export function createScheduleWorkspaceIdentity(
  workspaceId: string | null,
): ScheduleWorkspaceIdentity {
  return { workspaceId };
}

export function createScheduleRequestIdentity(
  workspace: ScheduleWorkspaceIdentity,
  sequence: number,
): ScheduleRequestIdentity | null {
  if (workspace.workspaceId === null || !Number.isSafeInteger(sequence) || sequence < 0) {
    return null;
  }
  return {
    workspace,
    workspaceId: workspace.workspaceId,
    sequence,
  };
}

export function isScheduleRequestCurrent(
  currentWorkspace: ScheduleWorkspaceIdentity,
  request: ScheduleRequestIdentity,
): boolean {
  return (
    currentWorkspace === request.workspace && currentWorkspace.workspaceId === request.workspaceId
  );
}

export function isScheduleSequenceCurrent(sequence: number, lastAppliedSequence: number): boolean {
  return Number.isSafeInteger(sequence) && sequence >= 0 && sequence >= lastAppliedSequence;
}

export function isScheduleRequestLatest(
  sequence: number,
  latestRequestedSequence: number,
): boolean {
  return Number.isSafeInteger(sequence) && sequence >= 0 && sequence === latestRequestedSequence;
}

export function isScheduleWorkspaceCurrent(
  activeWorkspaceId: string | null,
  snapshot: ScheduleSnapshot,
): boolean {
  return activeWorkspaceId !== null && snapshot.workspaceId === activeWorkspaceId;
}

export function isScheduleSnapshotDateCurrent(snapshot: ScheduleSnapshot, value: Date): boolean {
  return snapshot.todayDate === toLocalDateKey(value);
}

export function shouldApplyScheduleSnapshot(
  currentWorkspace: ScheduleWorkspaceIdentity,
  lastAppliedSequence: number,
  request: ScheduleRequestIdentity,
  snapshot: ScheduleSnapshot,
  value: Date,
): boolean {
  return (
    isScheduleRequestCurrent(currentWorkspace, request) &&
    snapshot.workspaceId === request.workspaceId &&
    request.sequence > lastAppliedSequence &&
    isScheduleSnapshotDateCurrent(snapshot, value)
  );
}

export function scheduleSnapshotForActivation(
  currentWorkspace: ScheduleWorkspaceIdentity,
  state: ScheduleSnapshotState | null,
  value: Date,
): ScheduleSnapshot | null {
  return state !== null &&
    state.activation === currentWorkspace &&
    state.snapshot.workspaceId === currentWorkspace.workspaceId &&
    isScheduleSnapshotDateCurrent(state.snapshot, value)
    ? state.snapshot
    : null;
}

export function createdScheduleFromResult(
  expectedWorkspaceId: string,
  expectedScheduledFor: string,
  result: ScheduleCreateResult,
): ScheduleItem | null {
  if (result.scheduleSnapshot.workspaceId !== expectedWorkspaceId) return null;
  const matches = result.scheduleSnapshot.items.filter(({ id }) => id === result.createdScheduleId);
  const created = matches.length === 1 ? matches[0]! : null;
  return created?.scheduledFor === expectedScheduledFor ? created : null;
}

export async function reconcileScheduleCreateResult(
  input: ScheduleCreateReconciliationInput,
): Promise<ScheduleCreateReconciliation> {
  let createdSchedule: ScheduleItem | null = null;
  let committed = false;
  let error: unknown;

  try {
    createdSchedule = createdScheduleFromResult(
      input.expectedWorkspaceId,
      input.expectedScheduledFor,
      input.result,
    );
    committed = createdSchedule !== null ? input.commitResultSnapshot() : false;
  } catch (caughtError) {
    error = caughtError;
  }

  for (
    let attempt = 0;
    !committed && input.isCurrent() && attempt < SCHEDULE_CREATE_REFRESH_ATTEMPTS;
    attempt += 1
  ) {
    try {
      const currentSchedule = input.getCommittedSchedule();
      if (currentSchedule) {
        createdSchedule = currentSchedule;
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
      const freshSchedule = createdScheduleFromResult(
        input.expectedWorkspaceId,
        input.expectedScheduledFor,
        {
          scheduleSnapshot: refresh.snapshot,
          createdScheduleId: input.result.createdScheduleId,
        },
      );
      if (!freshSchedule) {
        throw new Error(
          'The committed schedule item was not returned by the authoritative refresh.',
        );
      }
      createdSchedule = freshSchedule;
      if (refresh.commit()) {
        committed = true;
        break;
      }
      error = new Error('The authoritative schedule snapshot could not be committed.');
    } catch (caughtError) {
      error = caughtError;
    }
  }

  if (!committed && input.isCurrent()) {
    try {
      const currentSchedule = input.getCommittedSchedule();
      if (currentSchedule) {
        createdSchedule = currentSchedule;
        committed = true;
      }
    } catch (caughtError) {
      error = caughtError;
    }
  }

  return { createdSchedule, committed, error };
}

export function sortScheduleItems(items: readonly ScheduleItem[]): readonly ScheduleItem[] {
  return [...items].sort(
    (left, right) =>
      left.startMinute - right.startMinute ||
      left.endMinute - right.endMinute ||
      left.createdAt.localeCompare(right.createdAt) ||
      left.id.localeCompare(right.id),
  );
}

export function formatScheduleInputMinute(value: number): string {
  return formatScheduleMinute(value);
}

export function parseScheduleInputMinute(value: string, allowEndOfDay = false): number | null {
  if (allowEndOfDay && value === '24:00') return 1_440;
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/u.exec(value);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

export function defaultScheduleRange(value: Date): {
  readonly expectedDate: string;
  readonly startMinute: number;
  readonly endMinute: number;
} {
  if (!Number.isFinite(value.getTime())) throw new TypeError('Schedule date must be valid.');
  const currentMinute = value.getHours() * 60 + value.getMinutes();
  const rounded = Math.ceil(currentMinute / 30) * 30;
  const startMinute = Math.min(rounded, 23 * 60 + 30);
  return {
    expectedDate: toLocalDateKey(value),
    startMinute,
    endMinute: Math.min(startMinute + 30, 1_440),
  };
}

export function defaultScheduleRangeForPlanningDate(
  expectedDate: string,
  todayDate: string,
  value: Date,
): {
  readonly expectedDate: string;
  readonly startMinute: number;
  readonly endMinute: number;
} {
  const todayRange = defaultScheduleRange(value);
  if (expectedDate === todayDate) return todayRange;
  return {
    expectedDate,
    startMinute: 9 * 60,
    endMinute: 9 * 60 + 30,
  };
}
