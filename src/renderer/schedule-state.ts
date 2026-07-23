import type { ScheduleItem, ScheduleSnapshot } from '../shared/contracts';
import { formatScheduleMinute } from '../shared/schedule-domain';
import { isTaskSnapshotDateCurrent, toLocalDateKey } from './task-state';

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
  return isTaskSnapshotDateCurrent(
    { workspaceId: snapshot.workspaceId, todayDate: snapshot.todayDate, tasks: [] },
    value,
  );
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
