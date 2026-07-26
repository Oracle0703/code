import type { AutomationItem, AutomationSnapshot } from '../shared/contracts';

const AUTOMATION_CREATE_NAME_SUMMARY_MAX_LENGTH = 96;

export interface AutomationCreateWorkspaceIdentity {
  readonly workspaceId: string | null;
}

export interface AutomationCreateRequestIntent {
  readonly generation: number;
  readonly workspace: AutomationCreateWorkspaceIdentity;
}

export interface AutomationCreateFeedback {
  readonly requestGeneration: number;
  readonly workspaceId: string;
  readonly createdAutomationId: string;
  readonly name: string;
  readonly enabled: boolean;
}

export interface AutomationCreateOpenIntent {
  readonly generation: number;
  readonly workspace: AutomationCreateWorkspaceIdentity;
  readonly feedback: Readonly<AutomationCreateFeedback>;
}

export interface AutomationCreateSnapshotRefresh {
  readonly snapshot: AutomationSnapshot;
  readonly commit: () => boolean;
}

export interface AutomationCreateNavigationTarget {
  readonly workspaceId: string;
  readonly item: AutomationItem;
}

export interface AutomationCreateOpenState {
  readonly feedbackKey: string;
  readonly opening: boolean;
  readonly error: string | null;
  readonly errorFocusKey: string | null;
}

export function createAutomationCreateWorkspaceIdentity(
  workspaceId: string | null,
): AutomationCreateWorkspaceIdentity {
  return Object.freeze({ workspaceId });
}

export function automationCreateNameSummary(name: string): string {
  const normalized = name.trim().replace(/\s+/gu, ' ');
  const codePoints = Array.from(normalized);
  if (codePoints.length <= AUTOMATION_CREATE_NAME_SUMMARY_MAX_LENGTH) return normalized;
  return `${codePoints.slice(0, AUTOMATION_CREATE_NAME_SUMMARY_MAX_LENGTH - 1).join('')}…`;
}

export function automationCreateFeedbackKey(feedback: Readonly<AutomationCreateFeedback>): string {
  return JSON.stringify([
    feedback.requestGeneration,
    feedback.workspaceId,
    feedback.createdAutomationId,
    feedback.name,
    feedback.enabled,
  ]);
}

export function sameAutomationCreateFeedback(
  expected: Readonly<AutomationCreateFeedback>,
  current: Readonly<AutomationCreateFeedback> | null,
): boolean {
  return (
    current !== null &&
    automationCreateFeedbackKey(expected) === automationCreateFeedbackKey(current)
  );
}

/**
 * Owns the generation shared by manual automation creation and explicit opening.
 *
 * Starting a newer create supersedes both older feedback and an in-flight
 * open. Workspace activations are compared by identity so an A → B → A cycle
 * cannot revive work started in the first A.
 */
export class AutomationCreateCoordinator {
  #generation = 0;
  #openGeneration = 0;
  #workspace: AutomationCreateWorkspaceIdentity | null = null;
  #pendingCreate: AutomationCreateRequestIntent | null = null;

  beginCreate(workspace: AutomationCreateWorkspaceIdentity): AutomationCreateRequestIntent {
    if (workspace.workspaceId === null) throw new AutomationCreateSupersededError();
    if (this.#pendingCreate !== null) throw new AutomationCreateInProgressError();
    this.#workspace = workspace;
    this.#openGeneration += 1;
    const intent = Object.freeze({
      generation: ++this.#generation,
      workspace,
    });
    this.#pendingCreate = intent;
    return intent;
  }

  endCreate(intent: AutomationCreateRequestIntent): void {
    if (this.#pendingCreate === intent) this.#pendingCreate = null;
  }

  isCreateCurrent(
    intent: AutomationCreateRequestIntent,
    currentWorkspace: AutomationCreateWorkspaceIdentity,
  ): boolean {
    return (
      intent.generation === this.#generation &&
      intent.workspace === this.#workspace &&
      intent.workspace === currentWorkspace &&
      intent.workspace.workspaceId !== null
    );
  }

  assertCreateCurrent(
    intent: AutomationCreateRequestIntent,
    currentWorkspace: AutomationCreateWorkspaceIdentity,
  ): void {
    if (!this.isCreateCurrent(intent, currentWorkspace)) {
      throw new AutomationCreateSupersededError();
    }
  }

  createFeedback(
    intent: AutomationCreateRequestIntent,
    currentWorkspace: AutomationCreateWorkspaceIdentity,
    createdAutomation: Readonly<AutomationItem>,
    committed: boolean,
  ): AutomationCreateFeedback {
    this.assertCreateCurrent(intent, currentWorkspace);
    if (!committed) throw new AutomationCreateSupersededError();
    return Object.freeze({
      requestGeneration: intent.generation,
      workspaceId: intent.workspace.workspaceId!,
      createdAutomationId: createdAutomation.id,
      name: createdAutomation.name,
      enabled: createdAutomation.enabled,
    });
  }

  createRecoveredFeedback(
    requestGeneration: number,
    currentWorkspace: AutomationCreateWorkspaceIdentity,
    createdAutomation: Readonly<AutomationItem>,
    committed: boolean,
  ): AutomationCreateFeedback {
    if (!committed || !this.isGenerationCurrent(requestGeneration, currentWorkspace)) {
      throw new AutomationCreateSupersededError();
    }
    return Object.freeze({
      requestGeneration,
      workspaceId: currentWorkspace.workspaceId!,
      createdAutomationId: createdAutomation.id,
      name: createdAutomation.name,
      enabled: createdAutomation.enabled,
    });
  }

  isGenerationCurrent(
    requestGeneration: number,
    currentWorkspace: AutomationCreateWorkspaceIdentity,
  ): boolean {
    return (
      currentWorkspace.workspaceId !== null &&
      this.#workspace === currentWorkspace &&
      requestGeneration === this.#generation
    );
  }

  beginOpen(
    workspace: AutomationCreateWorkspaceIdentity,
    feedback: AutomationCreateFeedback,
  ): AutomationCreateOpenIntent {
    if (!this.isFeedbackCurrent(workspace, feedback, feedback)) {
      throw new AutomationCreateSupersededError();
    }
    return Object.freeze({
      generation: ++this.#openGeneration,
      workspace,
      feedback: Object.freeze({ ...feedback }),
    });
  }

  isFeedbackCurrent(
    currentWorkspace: AutomationCreateWorkspaceIdentity,
    expectedFeedback: Readonly<AutomationCreateFeedback>,
    currentFeedback: Readonly<AutomationCreateFeedback> | null,
  ): boolean {
    return (
      this.#workspace === currentWorkspace &&
      currentWorkspace.workspaceId !== null &&
      currentWorkspace.workspaceId === expectedFeedback.workspaceId &&
      expectedFeedback.requestGeneration === this.#generation &&
      sameAutomationCreateFeedback(expectedFeedback, currentFeedback)
    );
  }

  isOpenCurrent(
    intent: AutomationCreateOpenIntent,
    currentWorkspace: AutomationCreateWorkspaceIdentity,
    currentFeedback: AutomationCreateFeedback | null,
  ): boolean {
    return (
      intent.generation === this.#openGeneration &&
      intent.workspace === currentWorkspace &&
      intent.workspace === this.#workspace &&
      this.isFeedbackCurrent(currentWorkspace, intent.feedback, currentFeedback)
    );
  }

  assertOpenCurrent(
    intent: AutomationCreateOpenIntent,
    currentWorkspace: AutomationCreateWorkspaceIdentity,
    currentFeedback: AutomationCreateFeedback | null,
  ): void {
    if (!this.isOpenCurrent(intent, currentWorkspace, currentFeedback)) {
      throw new AutomationCreateSupersededError();
    }
  }

  dismiss(
    feedback: Readonly<AutomationCreateFeedback>,
    currentWorkspace: AutomationCreateWorkspaceIdentity,
    currentFeedback: Readonly<AutomationCreateFeedback> | null,
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

export class AutomationCreateOpenGate {
  readonly #pending = new Map<string, Readonly<AutomationCreateFeedback>>();

  begin(feedback: Readonly<AutomationCreateFeedback>): boolean {
    const key = automationCreateFeedbackKey(feedback);
    if (this.#pending.has(key)) return false;
    this.#pending.set(key, feedback);
    return true;
  }

  end(feedback: Readonly<AutomationCreateFeedback>): void {
    const key = automationCreateFeedbackKey(feedback);
    if (this.#pending.get(key) === feedback) this.#pending.delete(key);
  }
}

export class AutomationCreateSupersededError extends Error {
  constructor() {
    super('新建自动化结果已被较新的状态替代。');
    this.name = 'AutomationCreateSupersededError';
  }
}

export class AutomationCreateInProgressError extends Error {
  constructor() {
    super('正在创建另一条自动化，请稍候。');
    this.name = 'AutomationCreateInProgressError';
  }
}

export class AutomationCreateUnavailableError extends Error {
  constructor() {
    super('刚创建的自动化已不可用；自动化或工作区数据可能已经变化。');
    this.name = 'AutomationCreateUnavailableError';
  }
}

export class AutomationCreateNoteDraftPreservedError extends Error {
  constructor() {
    super('已取消打开自动化；当前笔记仍保留未保存的更改。');
    this.name = 'AutomationCreateNoteDraftPreservedError';
  }
}

export class AutomationCreateSyncRefreshError extends Error {
  constructor(
    message = '自动化列表仍无法安全确认。请稍后重新读取；规则可能已经创建，请不要重复创建。',
  ) {
    super(message);
    this.name = 'AutomationCreateSyncRefreshError';
  }
}

export async function resolveAutomationCreateNavigationTarget(
  intent: AutomationCreateOpenIntent,
  readAutomation: () => Promise<AutomationCreateSnapshotRefresh>,
  assertCurrent: () => void,
): Promise<AutomationCreateNavigationTarget> {
  assertCurrent();
  const refresh = await readAutomation();
  assertCurrent();
  const { feedback } = intent;
  if (refresh.snapshot.workspaceId !== feedback.workspaceId) {
    throw new AutomationCreateUnavailableError();
  }
  const matches = refresh.snapshot.items.filter(({ id }) => id === feedback.createdAutomationId);
  if (matches.length !== 1) throw new AutomationCreateUnavailableError();
  assertCurrent();
  if (!refresh.commit()) throw new AutomationCreateUnavailableError();
  assertCurrent();
  return {
    workspaceId: feedback.workspaceId,
    item: matches[0]!,
  };
}

export function automationCreateOpenStarted(
  feedback: Readonly<AutomationCreateFeedback>,
): AutomationCreateOpenState {
  return {
    feedbackKey: automationCreateFeedbackKey(feedback),
    opening: true,
    error: null,
    errorFocusKey: null,
  };
}

export function automationCreateOpenFailed(
  current: AutomationCreateOpenState | null,
  feedback: Readonly<AutomationCreateFeedback>,
  message: string,
  errorFocusKey: string,
): AutomationCreateOpenState | null {
  const feedbackKey = automationCreateFeedbackKey(feedback);
  return current?.feedbackKey === feedbackKey
    ? {
        feedbackKey,
        opening: false,
        error: message,
        errorFocusKey,
      }
    : current;
}

export function automationCreateOpenFinished(
  current: AutomationCreateOpenState | null,
  feedback: Readonly<AutomationCreateFeedback>,
): AutomationCreateOpenState | null {
  const feedbackKey = automationCreateFeedbackKey(feedback);
  return current?.feedbackKey === feedbackKey
    ? {
        ...current,
        opening: false,
      }
    : current;
}

export function automationCreateNavigationError(error: unknown): Error {
  if (
    error instanceof AutomationCreateSupersededError ||
    error instanceof AutomationCreateUnavailableError ||
    error instanceof AutomationCreateNoteDraftPreservedError
  ) {
    return error;
  }
  return new Error('无法打开刚创建的自动化，请重试。', { cause: error });
}

export function automationCreateSyncRefreshError(error: unknown): Error {
  if (
    error instanceof AutomationCreateSupersededError ||
    error instanceof AutomationCreateSyncRefreshError
  ) {
    return error;
  }
  return new AutomationCreateSyncRefreshError();
}
