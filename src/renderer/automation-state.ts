import type {
  AutomationAction,
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

export interface AutomationWorkspaceIdentity {
  readonly workspaceId: string | null;
}

export interface AutomationRunRequestIdentity {
  readonly workspace: AutomationWorkspaceIdentity;
  readonly workspaceId: string;
  readonly automationId: string;
  readonly sequence: number;
}

export interface AutomationRunFeedbackState {
  readonly workspace: AutomationWorkspaceIdentity;
  readonly feedback: AutomationRunFeedback;
}

export type AutomationRunNowConfirmation = (message: string) => boolean;

const RUN_ERROR_LABELS = {
  'action-failed': '动作执行失败',
  'database-unavailable': '本地数据库暂时不可用',
  'workspace-unavailable': '所属工作区不可用',
} as const;

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

export function automationRunFeedbackForActivation(
  currentWorkspace: AutomationWorkspaceIdentity,
  state: AutomationRunFeedbackState | null,
): AutomationRunFeedback | null {
  return state !== null &&
    state.workspace === currentWorkspace &&
    state.workspace.workspaceId === state.feedback.workspaceId
    ? state.feedback
    : null;
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

export function automationRunFeedbackForCurrentWorkspace(
  activeWorkspaceId: string | null,
  targetWorkspaceId: string,
  item: AutomationItem,
  result: AutomationRunNowResult,
): AutomationRunFeedback | null {
  const expectedOutputKind = item.action.kind === 'create-today-task' ? 'task' : 'note';
  if (
    activeWorkspaceId !== targetWorkspaceId ||
    result.workspaceId !== targetWorkspaceId ||
    result.automationId !== item.id ||
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
