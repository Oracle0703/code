import type { InboxCategory, InboxEntry, InboxSnapshot } from '../shared/contracts';

const CAPTURE_SUMMARY_MAX_LENGTH = 96;

export interface InboxCaptureWorkspaceIdentity {
  readonly workspaceId: string | null;
}

export interface InboxCaptureRequestIntent {
  readonly generation: number;
  readonly workspace: InboxCaptureWorkspaceIdentity;
}

export interface InboxCaptureFeedback {
  readonly requestGeneration: number;
  readonly workspaceId: string;
  readonly createdEntryId: string;
  readonly content: string;
  readonly category: InboxCategory;
}

export interface InboxCaptureOpenIntent {
  readonly generation: number;
  readonly workspace: InboxCaptureWorkspaceIdentity;
  readonly feedback: Readonly<InboxCaptureFeedback>;
}

export interface InboxCaptureSnapshotRefresh {
  readonly snapshot: InboxSnapshot;
  readonly commit: () => boolean;
}

export interface InboxCaptureNavigationTarget {
  readonly workspaceId: string;
  readonly entry: InboxEntry;
}

export interface InboxCaptureOpenState {
  readonly feedbackKey: string;
  readonly opening: boolean;
  readonly error: string | null;
  readonly errorFocusKey: string | null;
}

export function inboxCaptureContentSummary(content: string): string {
  const normalized = content.trim().replace(/\s+/gu, ' ');
  const codePoints = Array.from(normalized);
  if (codePoints.length <= CAPTURE_SUMMARY_MAX_LENGTH) return normalized;
  return `${codePoints.slice(0, CAPTURE_SUMMARY_MAX_LENGTH - 1).join('')}…`;
}

export function createInboxCaptureWorkspaceIdentity(
  workspaceId: string | null,
): InboxCaptureWorkspaceIdentity {
  return Object.freeze({ workspaceId });
}

export function inboxCaptureFeedbackKey(feedback: Readonly<InboxCaptureFeedback>): string {
  return JSON.stringify([
    feedback.requestGeneration,
    feedback.workspaceId,
    feedback.createdEntryId,
    feedback.content,
    feedback.category,
  ]);
}

export function sameInboxCaptureFeedback(
  expected: Readonly<InboxCaptureFeedback>,
  current: Readonly<InboxCaptureFeedback> | null,
): boolean {
  return current !== null && inboxCaptureFeedbackKey(expected) === inboxCaptureFeedbackKey(current);
}

/**
 * Owns one generation shared by capture publication and explicit opening.
 *
 * Starting a newer capture immediately supersedes both an older capture result
 * and an in-flight open. The activation object is compared by identity so an
 * A → B → A workspace cycle cannot revive work started in the first A.
 */
export class InboxCaptureCoordinator {
  #generation = 0;
  #openGeneration = 0;
  #workspace: InboxCaptureWorkspaceIdentity | null = null;
  #pendingCapture: InboxCaptureRequestIntent | null = null;

  beginCapture(workspace: InboxCaptureWorkspaceIdentity): InboxCaptureRequestIntent {
    if (workspace.workspaceId === null) throw new InboxCaptureSupersededError();
    if (this.#pendingCapture !== null) throw new InboxCaptureInProgressError();
    this.#workspace = workspace;
    this.#openGeneration += 1;
    const intent = Object.freeze({
      generation: ++this.#generation,
      workspace,
    });
    this.#pendingCapture = intent;
    return intent;
  }

  endCapture(intent: InboxCaptureRequestIntent): void {
    if (this.#pendingCapture === intent) this.#pendingCapture = null;
  }

  isCaptureCurrent(
    intent: InboxCaptureRequestIntent,
    currentWorkspace: InboxCaptureWorkspaceIdentity,
  ): boolean {
    return (
      intent.generation === this.#generation &&
      intent.workspace === this.#workspace &&
      intent.workspace === currentWorkspace &&
      intent.workspace.workspaceId !== null
    );
  }

  assertCaptureCurrent(
    intent: InboxCaptureRequestIntent,
    currentWorkspace: InboxCaptureWorkspaceIdentity,
  ): void {
    if (!this.isCaptureCurrent(intent, currentWorkspace)) {
      throw new InboxCaptureSupersededError();
    }
  }

  createFeedback(
    intent: InboxCaptureRequestIntent,
    currentWorkspace: InboxCaptureWorkspaceIdentity,
    createdEntry: Readonly<InboxEntry>,
    committed: boolean,
  ): InboxCaptureFeedback {
    this.assertCaptureCurrent(intent, currentWorkspace);
    if (!committed) throw new InboxCaptureSupersededError();
    return Object.freeze({
      requestGeneration: intent.generation,
      workspaceId: intent.workspace.workspaceId!,
      createdEntryId: createdEntry.id,
      content: createdEntry.content,
      category: createdEntry.category,
    });
  }

  beginOpen(
    workspace: InboxCaptureWorkspaceIdentity,
    feedback: InboxCaptureFeedback,
  ): InboxCaptureOpenIntent {
    if (!this.isFeedbackCurrent(workspace, feedback, feedback)) {
      throw new InboxCaptureSupersededError();
    }
    return Object.freeze({
      generation: ++this.#openGeneration,
      workspace,
      feedback: Object.freeze({ ...feedback }),
    });
  }

  isFeedbackCurrent(
    currentWorkspace: InboxCaptureWorkspaceIdentity,
    expectedFeedback: Readonly<InboxCaptureFeedback>,
    currentFeedback: Readonly<InboxCaptureFeedback> | null,
  ): boolean {
    return (
      this.#workspace === currentWorkspace &&
      currentWorkspace.workspaceId !== null &&
      currentWorkspace.workspaceId === expectedFeedback.workspaceId &&
      expectedFeedback.requestGeneration === this.#generation &&
      sameInboxCaptureFeedback(expectedFeedback, currentFeedback)
    );
  }

  isOpenCurrent(
    intent: InboxCaptureOpenIntent,
    currentWorkspace: InboxCaptureWorkspaceIdentity,
    currentFeedback: InboxCaptureFeedback | null,
  ): boolean {
    return (
      intent.generation === this.#openGeneration &&
      intent.workspace === currentWorkspace &&
      intent.workspace === this.#workspace &&
      this.isFeedbackCurrent(currentWorkspace, intent.feedback, currentFeedback)
    );
  }

  assertOpenCurrent(
    intent: InboxCaptureOpenIntent,
    currentWorkspace: InboxCaptureWorkspaceIdentity,
    currentFeedback: InboxCaptureFeedback | null,
  ): void {
    if (!this.isOpenCurrent(intent, currentWorkspace, currentFeedback)) {
      throw new InboxCaptureSupersededError();
    }
  }

  dismiss(
    feedback: Readonly<InboxCaptureFeedback>,
    currentWorkspace: InboxCaptureWorkspaceIdentity,
    currentFeedback: Readonly<InboxCaptureFeedback> | null,
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
    this.#pendingCapture = null;
  }
}

export class InboxCaptureOpenGate {
  readonly #pending = new Map<string, Readonly<InboxCaptureFeedback>>();

  begin(feedback: Readonly<InboxCaptureFeedback>): boolean {
    const key = inboxCaptureFeedbackKey(feedback);
    if (this.#pending.has(key)) return false;
    this.#pending.set(key, feedback);
    return true;
  }

  end(feedback: Readonly<InboxCaptureFeedback>): void {
    const key = inboxCaptureFeedbackKey(feedback);
    if (this.#pending.get(key) === feedback) this.#pending.delete(key);
  }
}

export class InboxCaptureSupersededError extends Error {
  constructor() {
    super('快速记录结果已被较新的状态替代。');
    this.name = 'InboxCaptureSupersededError';
  }
}

export class InboxCaptureInProgressError extends Error {
  constructor() {
    super('正在保存另一条快速记录，请稍候。');
    this.name = 'InboxCaptureInProgressError';
  }
}

export class InboxCaptureEntryUnavailableError extends Error {
  constructor() {
    super('刚创建的收件箱记录已不可用；它可能已归档或工作区数据已经变化。');
    this.name = 'InboxCaptureEntryUnavailableError';
  }
}

export async function resolveInboxCaptureNavigationTarget(
  intent: InboxCaptureOpenIntent,
  readInbox: () => Promise<InboxCaptureSnapshotRefresh>,
  assertCurrent: () => void,
): Promise<InboxCaptureNavigationTarget> {
  assertCurrent();
  const refresh = await readInbox();
  assertCurrent();
  const { feedback } = intent;
  if (refresh.snapshot.workspaceId !== feedback.workspaceId) {
    throw new InboxCaptureEntryUnavailableError();
  }
  const matches = refresh.snapshot.entries.filter(({ id }) => id === feedback.createdEntryId);
  if (matches.length !== 1) throw new InboxCaptureEntryUnavailableError();
  assertCurrent();
  if (!refresh.commit()) throw new InboxCaptureSupersededError();
  assertCurrent();
  return {
    workspaceId: feedback.workspaceId,
    entry: matches[0]!,
  };
}

export function inboxCaptureOpenStarted(
  feedback: Readonly<InboxCaptureFeedback>,
): InboxCaptureOpenState {
  return {
    feedbackKey: inboxCaptureFeedbackKey(feedback),
    opening: true,
    error: null,
    errorFocusKey: null,
  };
}

export function inboxCaptureOpenFailed(
  current: InboxCaptureOpenState | null,
  feedback: Readonly<InboxCaptureFeedback>,
  message: string,
  errorFocusKey: string,
): InboxCaptureOpenState | null {
  const feedbackKey = inboxCaptureFeedbackKey(feedback);
  return current?.feedbackKey === feedbackKey
    ? {
        feedbackKey,
        opening: false,
        error: message,
        errorFocusKey,
      }
    : current;
}

export function inboxCaptureOpenFinished(
  current: InboxCaptureOpenState | null,
  feedback: Readonly<InboxCaptureFeedback>,
): InboxCaptureOpenState | null {
  const feedbackKey = inboxCaptureFeedbackKey(feedback);
  return current?.feedbackKey === feedbackKey
    ? {
        ...current,
        opening: false,
      }
    : current;
}

export function inboxCaptureNavigationError(error: unknown): Error {
  if (
    error instanceof InboxCaptureSupersededError ||
    error instanceof InboxCaptureEntryUnavailableError
  ) {
    return error;
  }
  if (error instanceof Error && error.message.trim().length > 0) {
    const message = error.message.replace(/^Error invoking remote method '[^']+':\s*/u, '').trim();
    if (message.includes('不可用') || message.includes('归档') || message.includes('变化')) {
      return new Error(message, { cause: error });
    }
  }
  return new Error('无法打开刚创建的收件箱记录，请重试。', { cause: error });
}
