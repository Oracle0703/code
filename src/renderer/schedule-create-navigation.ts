import type { ScheduleItem, ScheduleKind, ScheduleSnapshot } from '../shared/contracts';
import { toLocalDateKey } from './task-state';

const SCHEDULE_CREATE_TITLE_SUMMARY_MAX_LENGTH = 96;

export interface ScheduleCreateWorkspaceIdentity {
  readonly workspaceId: string | null;
}

export interface ScheduleCreateRequestIntent {
  readonly generation: number;
  readonly workspace: ScheduleCreateWorkspaceIdentity;
}

export interface ScheduleCreateFeedback {
  readonly requestGeneration: number;
  readonly workspaceId: string;
  readonly createdScheduleId: string;
  readonly title: string;
  readonly scheduledFor: string;
  readonly startMinute: number;
  readonly endMinute: number;
  readonly kind: ScheduleKind;
}

export interface ScheduleCreateOpenIntent {
  readonly generation: number;
  readonly workspace: ScheduleCreateWorkspaceIdentity;
  readonly feedback: Readonly<ScheduleCreateFeedback>;
}

export interface ScheduleCreateSnapshotRefresh {
  readonly snapshot: ScheduleSnapshot;
  readonly commit: () => boolean;
}

export interface ScheduleCreateNavigationTarget {
  readonly workspaceId: string;
  readonly todayDate: string;
  readonly item: ScheduleItem;
}

export interface ScheduleCreateOpenState {
  readonly feedbackKey: string;
  readonly opening: boolean;
  readonly error: string | null;
  readonly errorFocusKey: string | null;
}

export function createScheduleCreateWorkspaceIdentity(
  workspaceId: string | null,
): ScheduleCreateWorkspaceIdentity {
  return Object.freeze({ workspaceId });
}

export function scheduleCreateTitleSummary(title: string): string {
  const normalized = title.trim().replace(/\s+/gu, ' ');
  const codePoints = Array.from(normalized);
  if (codePoints.length <= SCHEDULE_CREATE_TITLE_SUMMARY_MAX_LENGTH) return normalized;
  return `${codePoints.slice(0, SCHEDULE_CREATE_TITLE_SUMMARY_MAX_LENGTH - 1).join('')}…`;
}

export function isScheduleCreateTodayDateCurrent(todayDate: string, value: Date): boolean {
  return todayDate === toLocalDateKey(value);
}

export function scheduleCreateFeedbackKey(feedback: Readonly<ScheduleCreateFeedback>): string {
  return JSON.stringify([
    feedback.requestGeneration,
    feedback.workspaceId,
    feedback.createdScheduleId,
    feedback.title,
    feedback.scheduledFor,
    feedback.startMinute,
    feedback.endMinute,
    feedback.kind,
  ]);
}

export function sameScheduleCreateFeedback(
  expected: Readonly<ScheduleCreateFeedback>,
  current: Readonly<ScheduleCreateFeedback> | null,
): boolean {
  return (
    current !== null && scheduleCreateFeedbackKey(expected) === scheduleCreateFeedbackKey(current)
  );
}

/**
 * Owns the generation shared by manual schedule creation and explicit opening.
 *
 * Starting a newer create supersedes both older feedback and an in-flight
 * open. Workspace activations are compared by identity so an A → B → A cycle
 * cannot revive work started in the first A.
 */
export class ScheduleCreateCoordinator {
  #generation = 0;
  #openGeneration = 0;
  #workspace: ScheduleCreateWorkspaceIdentity | null = null;
  #pendingCreate: ScheduleCreateRequestIntent | null = null;

  beginCreate(workspace: ScheduleCreateWorkspaceIdentity): ScheduleCreateRequestIntent {
    if (workspace.workspaceId === null) throw new ScheduleCreateSupersededError();
    if (this.#pendingCreate !== null) throw new ScheduleCreateInProgressError();
    this.#workspace = workspace;
    this.#openGeneration += 1;
    const intent = Object.freeze({
      generation: ++this.#generation,
      workspace,
    });
    this.#pendingCreate = intent;
    return intent;
  }

  endCreate(intent: ScheduleCreateRequestIntent): void {
    if (this.#pendingCreate === intent) this.#pendingCreate = null;
  }

  isCreateCurrent(
    intent: ScheduleCreateRequestIntent,
    currentWorkspace: ScheduleCreateWorkspaceIdentity,
  ): boolean {
    return (
      intent.generation === this.#generation &&
      intent.workspace === this.#workspace &&
      intent.workspace === currentWorkspace &&
      intent.workspace.workspaceId !== null
    );
  }

  assertCreateCurrent(
    intent: ScheduleCreateRequestIntent,
    currentWorkspace: ScheduleCreateWorkspaceIdentity,
  ): void {
    if (!this.isCreateCurrent(intent, currentWorkspace)) {
      throw new ScheduleCreateSupersededError();
    }
  }

  createFeedback(
    intent: ScheduleCreateRequestIntent,
    currentWorkspace: ScheduleCreateWorkspaceIdentity,
    createdSchedule: Readonly<ScheduleItem>,
    committed: boolean,
  ): ScheduleCreateFeedback {
    this.assertCreateCurrent(intent, currentWorkspace);
    if (!committed) throw new ScheduleCreateSupersededError();
    return createScheduleCreateFeedback(
      intent.generation,
      intent.workspace.workspaceId!,
      createdSchedule,
    );
  }

  createRecoveredFeedback(
    requestGeneration: number,
    currentWorkspace: ScheduleCreateWorkspaceIdentity,
    createdSchedule: Readonly<ScheduleItem>,
    committed: boolean,
  ): ScheduleCreateFeedback {
    if (!committed || !this.isGenerationCurrent(requestGeneration, currentWorkspace)) {
      throw new ScheduleCreateSupersededError();
    }
    return createScheduleCreateFeedback(
      requestGeneration,
      currentWorkspace.workspaceId!,
      createdSchedule,
    );
  }

  isGenerationCurrent(
    requestGeneration: number,
    currentWorkspace: ScheduleCreateWorkspaceIdentity,
  ): boolean {
    return (
      currentWorkspace.workspaceId !== null &&
      this.#workspace === currentWorkspace &&
      requestGeneration === this.#generation
    );
  }

  beginOpen(
    workspace: ScheduleCreateWorkspaceIdentity,
    feedback: ScheduleCreateFeedback,
  ): ScheduleCreateOpenIntent {
    if (!this.isFeedbackCurrent(workspace, feedback, feedback)) {
      throw new ScheduleCreateSupersededError();
    }
    return Object.freeze({
      generation: ++this.#openGeneration,
      workspace,
      feedback: Object.freeze({ ...feedback }),
    });
  }

  isFeedbackCurrent(
    currentWorkspace: ScheduleCreateWorkspaceIdentity,
    expectedFeedback: Readonly<ScheduleCreateFeedback>,
    currentFeedback: Readonly<ScheduleCreateFeedback> | null,
  ): boolean {
    return (
      this.#workspace === currentWorkspace &&
      currentWorkspace.workspaceId !== null &&
      currentWorkspace.workspaceId === expectedFeedback.workspaceId &&
      expectedFeedback.requestGeneration === this.#generation &&
      sameScheduleCreateFeedback(expectedFeedback, currentFeedback)
    );
  }

  isOpenCurrent(
    intent: ScheduleCreateOpenIntent,
    currentWorkspace: ScheduleCreateWorkspaceIdentity,
    currentFeedback: ScheduleCreateFeedback | null,
  ): boolean {
    return (
      intent.generation === this.#openGeneration &&
      intent.workspace === currentWorkspace &&
      intent.workspace === this.#workspace &&
      this.isFeedbackCurrent(currentWorkspace, intent.feedback, currentFeedback)
    );
  }

  assertOpenCurrent(
    intent: ScheduleCreateOpenIntent,
    currentWorkspace: ScheduleCreateWorkspaceIdentity,
    currentFeedback: ScheduleCreateFeedback | null,
  ): void {
    if (!this.isOpenCurrent(intent, currentWorkspace, currentFeedback)) {
      throw new ScheduleCreateSupersededError();
    }
  }

  dismiss(
    feedback: Readonly<ScheduleCreateFeedback>,
    currentWorkspace: ScheduleCreateWorkspaceIdentity,
    currentFeedback: Readonly<ScheduleCreateFeedback> | null,
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

export class ScheduleCreateOpenGate {
  readonly #pending = new Map<string, Readonly<ScheduleCreateFeedback>>();

  begin(feedback: Readonly<ScheduleCreateFeedback>): boolean {
    const key = scheduleCreateFeedbackKey(feedback);
    if (this.#pending.has(key)) return false;
    this.#pending.set(key, feedback);
    return true;
  }

  end(feedback: Readonly<ScheduleCreateFeedback>): void {
    const key = scheduleCreateFeedbackKey(feedback);
    if (this.#pending.get(key) === feedback) this.#pending.delete(key);
  }
}

/**
 * Holds a create outcome until its modal has closed, so status/alert live
 * regions are mounted only after the modal is no longer the active
 * accessibility surface.
 */
export class ScheduleCreatePublicationGate<T> {
  #pending: {
    readonly workspace: ScheduleCreateWorkspaceIdentity;
    readonly value: T;
  } | null = null;

  stage(workspace: ScheduleCreateWorkspaceIdentity, value: T): void {
    this.#pending = Object.freeze({ workspace, value });
  }

  take(dialogOpen: boolean, currentWorkspace: ScheduleCreateWorkspaceIdentity): T | null {
    if (dialogOpen || this.#pending === null) return null;
    const pending = this.#pending;
    this.#pending = null;
    return pending.workspace === currentWorkspace ? pending.value : null;
  }

  clear(): void {
    this.#pending = null;
  }
}

export class ScheduleCreateSupersededError extends Error {
  constructor() {
    super('新建日程结果已被较新的状态替代。');
    this.name = 'ScheduleCreateSupersededError';
  }
}

export class ScheduleCreateInProgressError extends Error {
  constructor() {
    super('正在创建另一条日程，请稍候。');
    this.name = 'ScheduleCreateInProgressError';
  }
}

export class ScheduleCreateUnavailableError extends Error {
  constructor() {
    super('刚创建的日程已不可用；日程、日期窗口或工作区数据可能已经变化。');
    this.name = 'ScheduleCreateUnavailableError';
  }
}

export class ScheduleCreateNoteDraftPreservedError extends Error {
  constructor() {
    super('已取消打开日程；当前笔记仍保留未保存的更改。');
    this.name = 'ScheduleCreateNoteDraftPreservedError';
  }
}

export class ScheduleCreateSyncRefreshError extends Error {
  constructor(
    message = '日程列表仍无法安全确认。请稍后重新读取；日程可能已经创建，请不要重复创建。',
  ) {
    super(message);
    this.name = 'ScheduleCreateSyncRefreshError';
  }
}

export async function resolveScheduleCreateNavigationTarget(
  intent: ScheduleCreateOpenIntent,
  readSchedule: () => Promise<ScheduleCreateSnapshotRefresh>,
  assertCurrent: () => void,
): Promise<ScheduleCreateNavigationTarget> {
  assertCurrent();
  const refresh = await readSchedule();
  assertCurrent();
  const { feedback } = intent;
  if (refresh.snapshot.workspaceId !== feedback.workspaceId) {
    throw new ScheduleCreateUnavailableError();
  }
  const matches = refresh.snapshot.items.filter(({ id }) => id === feedback.createdScheduleId);
  if (matches.length !== 1 || matches[0]!.scheduledFor !== feedback.scheduledFor) {
    throw new ScheduleCreateUnavailableError();
  }
  assertCurrent();
  if (!refresh.commit()) throw new ScheduleCreateUnavailableError();
  assertCurrent();
  return {
    workspaceId: feedback.workspaceId,
    todayDate: refresh.snapshot.todayDate,
    item: matches[0]!,
  };
}

export function scheduleCreateOpenStarted(
  feedback: Readonly<ScheduleCreateFeedback>,
): ScheduleCreateOpenState {
  return {
    feedbackKey: scheduleCreateFeedbackKey(feedback),
    opening: true,
    error: null,
    errorFocusKey: null,
  };
}

export function scheduleCreateOpenFailed(
  current: ScheduleCreateOpenState | null,
  feedback: Readonly<ScheduleCreateFeedback>,
  message: string,
  errorFocusKey: string,
): ScheduleCreateOpenState | null {
  const feedbackKey = scheduleCreateFeedbackKey(feedback);
  return current?.feedbackKey === feedbackKey
    ? {
        feedbackKey,
        opening: false,
        error: message,
        errorFocusKey,
      }
    : current;
}

export function scheduleCreateOpenFinished(
  current: ScheduleCreateOpenState | null,
  feedback: Readonly<ScheduleCreateFeedback>,
): ScheduleCreateOpenState | null {
  const feedbackKey = scheduleCreateFeedbackKey(feedback);
  return current?.feedbackKey === feedbackKey
    ? {
        ...current,
        opening: false,
      }
    : current;
}

export function scheduleCreateNavigationError(error: unknown): Error {
  if (
    error instanceof ScheduleCreateSupersededError ||
    error instanceof ScheduleCreateUnavailableError ||
    error instanceof ScheduleCreateNoteDraftPreservedError
  ) {
    return error;
  }
  return new Error('无法打开刚创建的日程，请重试。', { cause: error });
}

export function scheduleCreateSyncRefreshError(error: unknown): Error {
  if (
    error instanceof ScheduleCreateSupersededError ||
    error instanceof ScheduleCreateSyncRefreshError
  ) {
    return error;
  }
  return new ScheduleCreateSyncRefreshError();
}

function createScheduleCreateFeedback(
  requestGeneration: number,
  workspaceId: string,
  createdSchedule: Readonly<ScheduleItem>,
): ScheduleCreateFeedback {
  return Object.freeze({
    requestGeneration,
    workspaceId,
    createdScheduleId: createdSchedule.id,
    title: createdSchedule.title,
    scheduledFor: createdSchedule.scheduledFor,
    startMinute: createdSchedule.startMinute,
    endMinute: createdSchedule.endMinute,
    kind: createdSchedule.kind,
  });
}
