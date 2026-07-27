import type {
  AutomationAction,
  AutomationCreateResult,
  AutomationItem,
  AutomationLastRun,
  AutomationRunNowResult,
  AutomationSchedule,
  AutomationSnapshot,
} from '../shared/contracts';
import { formatAutomationMinute } from '../shared/automation-domain';

export const AUTOMATION_WEEKDAY_LABELS = [
  '星期日',
  '星期一',
  '星期二',
  '星期三',
  '星期四',
  '星期五',
  '星期六',
] as const;

export interface AutomationRunFeedback {
  readonly workspaceId: string;
  readonly automationId: string;
  readonly outputKind: 'task' | 'note';
  readonly outputId: string;
  readonly outputTitle: string;
  readonly message: string;
}

export interface AutomationRunActivity {
  readonly automationId: string;
  readonly phase: 'running' | 'confirming' | 'recovering';
}

export interface AutomationWorkspaceIdentity {
  readonly workspaceId: string | null;
}

export interface AutomationRequestIdentity {
  readonly workspace: AutomationWorkspaceIdentity;
  readonly workspaceId: string;
  readonly sequence: number;
}

export interface AutomationSnapshotState {
  readonly activation: AutomationWorkspaceIdentity;
  readonly snapshot: AutomationSnapshot;
}

export interface AutomationCreateSnapshotRefresh {
  readonly snapshot: AutomationSnapshot;
  readonly commit: () => boolean;
}

export interface AutomationCreateReconciliation {
  readonly createdAutomation: AutomationItem | null;
  readonly committed: boolean;
  readonly error: unknown;
}

interface AutomationCreateReconciliationInput {
  readonly expectedWorkspaceId: string;
  readonly result: AutomationCreateResult;
  readonly commitResultSnapshot: () => boolean;
  readonly getCommittedAutomation: () => AutomationItem | null;
  readonly prepareSnapshotRefresh: () => Promise<AutomationCreateSnapshotRefresh>;
  readonly isCurrent: () => boolean;
}

export interface AutomationRunRequestIdentity {
  readonly workspace: AutomationWorkspaceIdentity;
  readonly workspaceId: string;
  readonly automationId: string;
  readonly sequence: number;
}

export type AutomationRunNowConfirmation = (message: string) => boolean;

const RUN_ERROR_LABELS = {
  'action-failed': '动作执行失败',
  'database-unavailable': '本地数据库暂时不可用',
  'workspace-unavailable': '所属工作区不可用',
} as const;

const AUTOMATION_CREATE_REFRESH_ATTEMPTS = 2;

export function isAutomationSequenceCurrent(
  sequence: number,
  lastAppliedSequence: number,
): boolean {
  return Number.isSafeInteger(sequence) && sequence >= 0 && sequence >= lastAppliedSequence;
}

export function isAutomationRequestLatest(
  sequence: number,
  latestRequestedSequence: number,
): boolean {
  return Number.isSafeInteger(sequence) && sequence >= 0 && sequence === latestRequestedSequence;
}

export function isAutomationWorkspaceCurrent(
  activeWorkspaceId: string | null,
  snapshot: AutomationSnapshot,
): boolean {
  return activeWorkspaceId !== null && snapshot.workspaceId === activeWorkspaceId;
}

export function createAutomationWorkspaceIdentity(
  workspaceId: string | null,
): AutomationWorkspaceIdentity {
  return { workspaceId };
}

export function createAutomationRequestIdentity(
  workspace: AutomationWorkspaceIdentity,
  sequence: number,
): AutomationRequestIdentity | null {
  if (workspace.workspaceId === null || !Number.isSafeInteger(sequence) || sequence < 0) {
    return null;
  }
  return {
    workspace,
    workspaceId: workspace.workspaceId,
    sequence,
  };
}

export function isAutomationRequestCurrent(
  currentWorkspace: AutomationWorkspaceIdentity,
  request: AutomationRequestIdentity,
): boolean {
  return (
    currentWorkspace === request.workspace && currentWorkspace.workspaceId === request.workspaceId
  );
}

export function shouldApplyAutomationSnapshot(
  currentWorkspace: AutomationWorkspaceIdentity,
  lastAppliedSequence: number,
  request: AutomationRequestIdentity,
  snapshot: AutomationSnapshot,
): boolean {
  return (
    isAutomationRequestCurrent(currentWorkspace, request) &&
    snapshot.workspaceId === request.workspaceId &&
    request.sequence > lastAppliedSequence
  );
}

export function automationSnapshotForActivation(
  currentWorkspace: AutomationWorkspaceIdentity,
  state: AutomationSnapshotState | null,
): AutomationSnapshot | null {
  return state !== null &&
    state.activation === currentWorkspace &&
    state.snapshot.workspaceId === currentWorkspace.workspaceId
    ? state.snapshot
    : null;
}

export function createdAutomationFromResult(
  expectedWorkspaceId: string,
  result: AutomationCreateResult,
): AutomationItem | null {
  if (result.automationSnapshot.workspaceId !== expectedWorkspaceId) return null;
  const matches = result.automationSnapshot.items.filter(
    ({ id }) => id === result.createdAutomationId,
  );
  return matches.length === 1 ? matches[0]! : null;
}

export async function reconcileAutomationCreateResult(
  input: AutomationCreateReconciliationInput,
): Promise<AutomationCreateReconciliation> {
  let createdAutomation: AutomationItem | null = null;
  let committed = false;
  let error: unknown;

  try {
    createdAutomation = createdAutomationFromResult(input.expectedWorkspaceId, input.result);
    committed = createdAutomation !== null ? input.commitResultSnapshot() : false;
  } catch (caughtError) {
    error = caughtError;
  }

  for (
    let attempt = 0;
    !committed && input.isCurrent() && attempt < AUTOMATION_CREATE_REFRESH_ATTEMPTS;
    attempt += 1
  ) {
    try {
      const currentAutomation = input.getCommittedAutomation();
      if (currentAutomation) {
        createdAutomation = currentAutomation;
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
      const freshAutomation = createdAutomationFromResult(input.expectedWorkspaceId, {
        automationSnapshot: refresh.snapshot,
        createdAutomationId: input.result.createdAutomationId,
      });
      if (!freshAutomation) {
        throw new Error('The committed automation was not returned by the authoritative refresh.');
      }
      createdAutomation = freshAutomation;
      if (refresh.commit()) {
        committed = true;
        break;
      }
      error = new Error('The authoritative automation snapshot could not be committed.');
    } catch (caughtError) {
      error = caughtError;
    }
  }

  if (!committed && input.isCurrent()) {
    try {
      const currentAutomation = input.getCommittedAutomation();
      if (currentAutomation) {
        createdAutomation = currentAutomation;
        committed = true;
      }
    } catch (caughtError) {
      error = caughtError;
    }
  }

  return { createdAutomation, committed, error };
}

export function createAutomationRunRequestIdentity(
  workspace: AutomationWorkspaceIdentity,
  automationId: string,
  sequence: number,
): AutomationRunRequestIdentity | null {
  if (
    workspace.workspaceId === null ||
    automationId.length === 0 ||
    !Number.isSafeInteger(sequence) ||
    sequence < 0
  ) {
    return null;
  }
  return {
    workspace,
    workspaceId: workspace.workspaceId,
    automationId,
    sequence,
  };
}

export function isAutomationRunRequestCurrent(
  currentWorkspace: AutomationWorkspaceIdentity,
  latestSequence: number,
  request: AutomationRunRequestIdentity,
): boolean {
  return (
    currentWorkspace === request.workspace &&
    currentWorkspace.workspaceId === request.workspaceId &&
    latestSequence === request.sequence
  );
}

export function sortAutomationItems(items: readonly AutomationItem[]): readonly AutomationItem[] {
  return [...items].sort(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
  );
}

export function parseAutomationInputMinute(value: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/u.exec(value);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

export function formatAutomationInputMinute(value: number): string {
  return formatAutomationMinute(value);
}

export function formatAutomationSchedule(schedule: AutomationSchedule): string {
  const time = formatAutomationInputMinute(schedule.localTimeMinute);
  if (schedule.cadence === 'daily') return `每天 ${time}`;
  const weekday =
    schedule.weekday === null
      ? '未知星期'
      : (AUTOMATION_WEEKDAY_LABELS[schedule.weekday] ?? '未知星期');
  return `每周${weekday.slice(2)} ${time}`;
}

export function describeAutomationAction(action: AutomationAction): string {
  return action.kind === 'create-today-task'
    ? `创建今日任务：${action.title}`
    : `创建笔记：${action.title}`;
}

export function automationRunNowConfirmation(item: AutomationItem): string {
  const action =
    item.action.kind === 'create-today-task'
      ? `创建今日任务“${item.action.title}”。`
      : `创建 Markdown 笔记“${item.action.title}”，正文逐字使用当前保存的模板：\n${item.action.body}`;
  return [
    `立即运行自动化“${item.name}”？`,
    '',
    `已保存动作：${action}`,
    '',
    '这次手动运行不会改变启用状态、重复计划或计划运行记录。',
  ].join('\n');
}

export async function requestAutomationRunNow(
  item: AutomationItem,
  runNow: (item: AutomationItem) => void | Promise<void>,
  confirm: AutomationRunNowConfirmation = (message) => window.confirm(message),
): Promise<boolean> {
  if (!confirm(automationRunNowConfirmation(item))) return false;
  await runNow(item);
  return true;
}

export function automationRunFeedbackForRequest(
  request: AutomationRunRequestIdentity,
  item: AutomationItem,
  result: AutomationRunNowResult,
): AutomationRunFeedback | null {
  const expectedOutputKind =
    item.action.kind === 'create-today-task'
      ? 'task'
      : item.action.kind === 'create-note'
        ? 'note'
        : null;
  if (
    item.id !== request.automationId ||
    expectedOutputKind === null ||
    result.workspaceId !== request.workspaceId ||
    result.automationId !== request.automationId ||
    result.outputKind !== expectedOutputKind ||
    typeof result.outputId !== 'string' ||
    result.outputId.trim().length === 0
  ) {
    return null;
  }
  return {
    workspaceId: result.workspaceId,
    automationId: result.automationId,
    outputKind: result.outputKind,
    outputId: result.outputId,
    outputTitle: item.action.title,
    message:
      result.outputKind === 'task'
        ? `已立即创建今日任务：${item.action.title}`
        : `已立即创建笔记：${item.action.title}`,
  };
}

export function automationRunFeedbackAfterMainSuccess(
  request: AutomationRunRequestIdentity,
  item: AutomationItem,
  result: AutomationRunNowResult,
): AutomationRunFeedback {
  const confirmed = automationRunFeedbackForRequest(request, item, result);
  if (confirmed !== null) return confirmed;

  const outputKind = item.action.kind === 'create-today-task' ? 'task' : 'note';
  return {
    workspaceId: request.workspaceId,
    automationId: request.automationId,
    outputKind,
    outputId: `__unconfirmed_automation_output__:${request.sequence}`,
    outputTitle: item.action.title,
    message:
      outputKind === 'task'
        ? `已立即创建今日任务：${item.action.title}`
        : `已立即创建笔记：${item.action.title}`,
  };
}

export function automationRunOutputLabel(feedback: AutomationRunFeedback): string {
  return feedback.outputKind === 'task' ? '打开任务' : '打开笔记';
}

export function automationRunFeedbackKey(feedback: AutomationRunFeedback): string {
  return JSON.stringify([
    feedback.workspaceId,
    feedback.automationId,
    feedback.outputKind,
    feedback.outputId,
  ]);
}

export function describeAutomationLastRun(lastRun: AutomationLastRun): string {
  if (lastRun.status === 'never') return '尚无计划运行记录';
  if (lastRun.status === 'success') {
    const output = lastRun.outputKind === 'task' ? '任务' : '笔记';
    return `上次计划运行成功 ${formatAutomationDateTime(lastRun.completedAt)} · 已创建${output}`;
  }
  const attempts =
    lastRun.consecutiveFailures > 1 ? ` · 连续失败 ${lastRun.consecutiveFailures} 次` : '';
  return `上次计划运行失败 ${formatAutomationDateTime(lastRun.attemptedAt)} · ${
    RUN_ERROR_LABELS[lastRun.errorCode]
  }${attempts} · ${formatAutomationDateTime(lastRun.nextRetryAt)} 重试`;
}

export function formatAutomationDateTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}
