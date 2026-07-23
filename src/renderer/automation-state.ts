import type {
  AutomationAction,
  AutomationItem,
  AutomationLastRun,
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

export function describeAutomationLastRun(lastRun: AutomationLastRun): string {
  if (lastRun.status === 'never') return '尚未运行';
  if (lastRun.status === 'success') {
    const output = lastRun.outputKind === 'task' ? '任务' : '笔记';
    return `上次成功 ${formatAutomationDateTime(lastRun.completedAt)} · 已创建${output}`;
  }
  const attempts =
    lastRun.consecutiveFailures > 1 ? ` · 连续失败 ${lastRun.consecutiveFailures} 次` : '';
  return `上次失败 ${formatAutomationDateTime(lastRun.attemptedAt)} · ${
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
