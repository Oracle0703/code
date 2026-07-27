import type {
  ScheduleCreateResult,
  ScheduleItem,
  ScheduleKind,
  ScheduleSnapshot,
} from '../shared/contracts';
import { isDateInRollingPlanningWindow } from '../shared/planning-domain';
import {
  formatScheduleMinute,
  normalizeScheduleCivilDate,
  normalizeScheduleId,
  normalizeScheduleKind,
  normalizeScheduleRange,
  normalizeScheduleRevision,
  normalizeScheduleTitle,
} from '../shared/schedule-domain';
import { normalizeWorkspaceId } from '../shared/workspace-domain';
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

export interface ScheduleMutationIdentity {
  readonly expectedWorkspaceId: string;
  readonly expectedDate: string;
  readonly originalSchedule: ScheduleItem;
}

export interface ScheduleUpdateMutationIntent extends ScheduleMutationIdentity {
  readonly kind: 'update';
  readonly title: string;
  readonly scheduleKind: ScheduleKind;
  readonly startMinute: number;
  readonly endMinute: number;
  readonly contentChanged: boolean;
  readonly expectedCommittedRevision: number;
}

export interface ScheduleArchiveMutationIntent extends ScheduleMutationIdentity {
  readonly kind: 'archive';
}

export type ScheduleMutationIntent = ScheduleUpdateMutationIntent | ScheduleArchiveMutationIntent;

export interface ScheduleMutationSnapshotRefresh {
  readonly snapshot: ScheduleSnapshot;
  readonly commit: () => boolean;
}

export interface ScheduleUpdateReconciliation {
  readonly authoritativeSchedule: ScheduleItem | null;
  readonly committed: boolean;
  readonly error: unknown;
}

export interface ScheduleArchiveReconciliation {
  readonly confirmed: boolean;
  readonly committed: boolean;
  readonly error: unknown;
}

export interface ScheduleUpdateReconciliationInput {
  readonly intent: ScheduleUpdateMutationIntent;
  readonly resultSnapshot: ScheduleSnapshot;
  readonly commitResultSnapshot: () => boolean;
  readonly getCommittedSnapshot: () => ScheduleSnapshot | null;
  readonly prepareSnapshotRefresh: () => Promise<ScheduleMutationSnapshotRefresh>;
  readonly isCurrent: () => boolean;
}

export interface ScheduleArchiveReconciliationInput {
  readonly intent: ScheduleArchiveMutationIntent;
  readonly resultSnapshot: ScheduleSnapshot;
  readonly commitResultSnapshot: () => boolean;
  readonly getCommittedSnapshot: () => ScheduleSnapshot | null;
  readonly prepareSnapshotRefresh: () => Promise<ScheduleMutationSnapshotRefresh>;
  readonly isCurrent: () => boolean;
}

export class ScheduleMutationSupersededError extends Error {
  constructor() {
    super('The schedule mutation reconciliation is no longer current.');
    this.name = 'ScheduleMutationSupersededError';
  }
}

export class ScheduleMutationResultUnavailableError extends Error {
  constructor(kind: ScheduleMutationIntent['kind']) {
    super(
      kind === 'update'
        ? 'The exact updated schedule item was not returned by the authoritative snapshot.'
        : 'The exact archived schedule item is still present in the authoritative snapshot.',
    );
    this.name = 'ScheduleMutationResultUnavailableError';
  }
}

export class ScheduleMutationSnapshotCommitError extends Error {
  constructor() {
    super('The authoritative schedule snapshot could not be committed.');
    this.name = 'ScheduleMutationSnapshotCommitError';
  }
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
const SCHEDULE_MUTATION_REFRESH_ATTEMPTS = 2;

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

export function createScheduleUpdateMutationIntent(
  expectedWorkspaceId: string,
  originalSchedule: ScheduleItem,
  expectedDate: string,
  title: string,
  scheduleKind: ScheduleKind,
  startMinute: number,
  endMinute: number,
): ScheduleUpdateMutationIntent {
  const normalizedExpectedDate = normalizeScheduleCivilDate(expectedDate);
  const normalizedOriginal = normalizeOriginalSchedule(originalSchedule);
  if (normalizedOriginal.scheduledFor !== normalizedExpectedDate) {
    throw new TypeError('Original schedule date does not match the expected date.');
  }
  const normalizedTitle = normalizeScheduleTitle(title);
  const normalizedKind = normalizeScheduleKind(scheduleKind);
  const normalizedRange = normalizeScheduleRange(startMinute, endMinute);
  const contentChanged =
    normalizedTitle !== normalizedOriginal.title ||
    normalizedKind !== normalizedOriginal.kind ||
    normalizedRange.startMinute !== normalizedOriginal.startMinute ||
    normalizedRange.endMinute !== normalizedOriginal.endMinute;
  if (contentChanged && normalizedOriginal.revision === Number.MAX_SAFE_INTEGER) {
    throw new TypeError('Schedule revision cannot be incremented safely.');
  }
  return Object.freeze({
    kind: 'update',
    expectedWorkspaceId: normalizeWorkspaceId(expectedWorkspaceId),
    expectedDate: normalizedExpectedDate,
    originalSchedule: normalizedOriginal,
    title: normalizedTitle,
    scheduleKind: normalizedKind,
    ...normalizedRange,
    contentChanged,
    expectedCommittedRevision: normalizedOriginal.revision + (contentChanged ? 1 : 0),
  });
}

export function createScheduleArchiveMutationIntent(
  expectedWorkspaceId: string,
  originalSchedule: ScheduleItem,
  expectedDate: string,
): ScheduleArchiveMutationIntent {
  const normalizedExpectedDate = normalizeScheduleCivilDate(expectedDate);
  const normalizedOriginal = normalizeOriginalSchedule(originalSchedule);
  if (normalizedOriginal.scheduledFor !== normalizedExpectedDate) {
    throw new TypeError('Original schedule date does not match the expected date.');
  }
  if (normalizedOriginal.revision === Number.MAX_SAFE_INTEGER) {
    throw new TypeError('Schedule revision cannot be incremented safely.');
  }
  return Object.freeze({
    kind: 'archive',
    expectedWorkspaceId: normalizeWorkspaceId(expectedWorkspaceId),
    expectedDate: normalizedExpectedDate,
    originalSchedule: normalizedOriginal,
  });
}

export function updatedScheduleFromSnapshot(
  intent: ScheduleUpdateMutationIntent,
  snapshot: ScheduleSnapshot,
): ScheduleItem | null {
  if (!scheduleSnapshotCoversTarget(intent, snapshot)) return null;
  const matches = snapshot.items.filter(({ id }) => id === intent.originalSchedule.id);
  if (matches.length !== 1) return null;
  const candidate = matches[0]!;
  if (
    candidate.scheduledFor !== intent.expectedDate ||
    candidate.createdAt !== intent.originalSchedule.createdAt ||
    candidate.title !== intent.title ||
    candidate.kind !== intent.scheduleKind ||
    candidate.startMinute !== intent.startMinute ||
    candidate.endMinute !== intent.endMinute ||
    candidate.revision !== intent.expectedCommittedRevision
  ) {
    return null;
  }
  if (
    intent.contentChanged
      ? !isExactIsoTimestampAtLeast(candidate.updatedAt, intent.originalSchedule.updatedAt)
      : candidate.updatedAt !== intent.originalSchedule.updatedAt
  ) {
    return null;
  }
  return candidate;
}

export function archivedScheduleIsAbsent(
  intent: ScheduleArchiveMutationIntent,
  snapshot: ScheduleSnapshot,
): boolean {
  return (
    scheduleSnapshotCoversTarget(intent, snapshot) &&
    !snapshot.items.some(({ id }) => id === intent.originalSchedule.id)
  );
}

export async function reconcileScheduleUpdateResult(
  input: ScheduleUpdateReconciliationInput,
): Promise<ScheduleUpdateReconciliation> {
  const result = await reconcileScheduleMutation({
    intent: input.intent,
    resultSnapshot: input.resultSnapshot,
    commitResultSnapshot: input.commitResultSnapshot,
    getCommittedSnapshot: input.getCommittedSnapshot,
    prepareSnapshotRefresh: input.prepareSnapshotRefresh,
    isCurrent: input.isCurrent,
    valueFromSnapshot: (snapshot) => updatedScheduleFromSnapshot(input.intent, snapshot),
  });
  return {
    authoritativeSchedule: result.value,
    committed: result.committed,
    error: result.error,
  };
}

export async function reconcileScheduleArchiveResult(
  input: ScheduleArchiveReconciliationInput,
): Promise<ScheduleArchiveReconciliation> {
  const result = await reconcileScheduleMutation({
    intent: input.intent,
    resultSnapshot: input.resultSnapshot,
    commitResultSnapshot: input.commitResultSnapshot,
    getCommittedSnapshot: input.getCommittedSnapshot,
    prepareSnapshotRefresh: input.prepareSnapshotRefresh,
    isCurrent: input.isCurrent,
    valueFromSnapshot: (snapshot) =>
      archivedScheduleIsAbsent(input.intent, snapshot) ? true : null,
  });
  return {
    confirmed: result.value === true && result.committed,
    committed: result.committed,
    error: result.error,
  };
}

interface ScheduleMutationReconciliationInput<Value> {
  readonly intent: ScheduleMutationIntent;
  readonly resultSnapshot: ScheduleSnapshot;
  readonly commitResultSnapshot: () => boolean;
  readonly getCommittedSnapshot: () => ScheduleSnapshot | null;
  readonly prepareSnapshotRefresh: () => Promise<ScheduleMutationSnapshotRefresh>;
  readonly isCurrent: () => boolean;
  readonly valueFromSnapshot: (snapshot: ScheduleSnapshot) => Value | null;
}

interface ScheduleMutationReconciliation<Value> {
  readonly value: Value | null;
  readonly committed: boolean;
  readonly error: unknown;
}

async function reconcileScheduleMutation<Value>(
  input: ScheduleMutationReconciliationInput<Value>,
): Promise<ScheduleMutationReconciliation<Value>> {
  let error: unknown;
  let responseValue: Value | null = null;

  const superseded = (): ScheduleMutationReconciliation<Value> => ({
    value: null,
    committed: false,
    error: new ScheduleMutationSupersededError(),
  });
  const unavailable = (): ScheduleMutationResultUnavailableError =>
    new ScheduleMutationResultUnavailableError(input.intent.kind);
  const valueFromLaterSnapshot = (snapshot: ScheduleSnapshot): Value | null => {
    const exactValue = input.valueFromSnapshot(snapshot);
    if (exactValue !== null) return exactValue;
    return responseValue !== null && scheduleTargetHasRolledPast(input.intent, snapshot)
      ? responseValue
      : null;
  };
  const committedValue = (): ScheduleMutationReconciliation<Value> | null => {
    if (!input.isCurrent()) return superseded();
    try {
      const snapshot = input.getCommittedSnapshot();
      if (!input.isCurrent()) return superseded();
      if (snapshot === null) return null;
      const value = valueFromLaterSnapshot(snapshot);
      if (!input.isCurrent()) return superseded();
      if (value === null) {
        error = unavailable();
        return null;
      }
      return { value, committed: true, error };
    } catch (caughtError) {
      error = caughtError;
      return input.isCurrent() ? null : superseded();
    }
  };

  if (!input.isCurrent()) return superseded();

  try {
    responseValue = input.valueFromSnapshot(input.resultSnapshot);
  } catch (caughtError) {
    error = caughtError;
  }
  if (!input.isCurrent()) return superseded();
  if (responseValue === null) {
    error ??= unavailable();
  } else {
    try {
      const committed = input.commitResultSnapshot();
      if (!input.isCurrent()) return superseded();
      if (committed) return { value: responseValue, committed: true, error };
      error = new ScheduleMutationSnapshotCommitError();
    } catch (caughtError) {
      error = caughtError;
      if (!input.isCurrent()) return superseded();
    }
  }

  const currentValue = committedValue();
  if (currentValue !== null) return currentValue;

  for (let attempt = 0; attempt < SCHEDULE_MUTATION_REFRESH_ATTEMPTS; attempt += 1) {
    if (!input.isCurrent()) return superseded();
    try {
      const refresh = await input.prepareSnapshotRefresh();
      if (!input.isCurrent()) return superseded();
      const value = valueFromLaterSnapshot(refresh.snapshot);
      if (!input.isCurrent()) return superseded();
      if (value === null) {
        error = unavailable();
        continue;
      }
      const committed = refresh.commit();
      if (!input.isCurrent()) return superseded();
      if (committed) return { value, committed: true, error };
      error = new ScheduleMutationSnapshotCommitError();
    } catch (caughtError) {
      error = caughtError;
      if (!input.isCurrent()) return superseded();
    }
  }

  if (!input.isCurrent()) return superseded();
  const finalValue = committedValue();
  if (finalValue !== null) return finalValue;

  return {
    value: null,
    committed: false,
    error: error ?? unavailable(),
  };
}

function normalizeOriginalSchedule(schedule: ScheduleItem): ScheduleItem {
  const id = normalizeScheduleId(schedule.id);
  const title = normalizeScheduleTitle(schedule.title);
  const kind = normalizeScheduleKind(schedule.kind);
  const scheduledFor = normalizeScheduleCivilDate(schedule.scheduledFor);
  const range = normalizeScheduleRange(schedule.startMinute, schedule.endMinute);
  const revision = normalizeScheduleRevision(schedule.revision);
  if (
    title !== schedule.title ||
    kind !== schedule.kind ||
    scheduledFor !== schedule.scheduledFor ||
    range.startMinute !== schedule.startMinute ||
    range.endMinute !== schedule.endMinute
  ) {
    throw new TypeError('Original schedule item must already be normalized.');
  }
  if (
    !isExactIsoTimestamp(schedule.createdAt) ||
    !isExactIsoTimestampAtLeast(schedule.updatedAt, schedule.createdAt)
  ) {
    throw new TypeError('Original schedule timestamps are invalid.');
  }
  return Object.freeze({
    id,
    title,
    kind,
    scheduledFor,
    ...range,
    revision,
    createdAt: schedule.createdAt,
    updatedAt: schedule.updatedAt,
  });
}

function scheduleSnapshotCoversTarget(
  intent: ScheduleMutationIdentity,
  snapshot: ScheduleSnapshot,
): boolean {
  if (snapshot.workspaceId !== intent.expectedWorkspaceId) return false;
  try {
    const todayDate = normalizeScheduleCivilDate(snapshot.todayDate);
    return (
      todayDate === snapshot.todayDate &&
      isDateInRollingPlanningWindow(intent.expectedDate, todayDate)
    );
  } catch {
    return false;
  }
}

function scheduleTargetHasRolledPast(
  intent: ScheduleMutationIdentity,
  snapshot: ScheduleSnapshot,
): boolean {
  if (snapshot.workspaceId !== intent.expectedWorkspaceId) return false;
  try {
    const todayDate = normalizeScheduleCivilDate(snapshot.todayDate);
    return todayDate === snapshot.todayDate && todayDate > intent.expectedDate;
  } catch {
    return false;
  }
}

function isExactIsoTimestamp(value: string): boolean {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function isExactIsoTimestampAtLeast(value: string, lowerBound: string): boolean {
  return isExactIsoTimestamp(value) && isExactIsoTimestamp(lowerBound) && value >= lowerBound;
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
