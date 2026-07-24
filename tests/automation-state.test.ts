import { describe, expect, it } from 'vitest';
import type { AutomationItem, AutomationSnapshot } from '../src/shared/contracts';
import {
  describeAutomationAction,
  describeAutomationLastRun,
  formatAutomationInputMinute,
  formatAutomationSchedule,
  isAutomationRequestLatest,
  isAutomationSequenceCurrent,
  isAutomationWorkspaceCurrent,
  parseAutomationInputMinute,
  sortAutomationItems,
} from '../src/renderer/automation-state';

const WORKSPACE_A = '11111111-1111-4111-8111-111111111111';
const WORKSPACE_B = '22222222-2222-4222-8222-222222222222';

describe('automation renderer state', () => {
  it('guards request ordering and active workspace snapshots', () => {
    expect(isAutomationSequenceCurrent(4, 5)).toBe(false);
    expect(isAutomationSequenceCurrent(5, 5)).toBe(true);
    expect(isAutomationSequenceCurrent(6, 5)).toBe(true);
    expect(isAutomationRequestLatest(4, 5)).toBe(false);
    expect(isAutomationRequestLatest(5, 5)).toBe(true);

    const snapshot: AutomationSnapshot = { workspaceId: WORKSPACE_A, items: [] };
    expect(isAutomationWorkspaceCurrent(WORKSPACE_A, snapshot)).toBe(true);
    expect(isAutomationWorkspaceCurrent(WORKSPACE_B, snapshot)).toBe(false);
    expect(isAutomationWorkspaceCurrent(null, snapshot)).toBe(false);
  });

  it('parses and formats bounded local-time schedules', () => {
    expect(parseAutomationInputMinute('00:00')).toBe(0);
    expect(parseAutomationInputMinute('09:30')).toBe(570);
    expect(parseAutomationInputMinute('23:59')).toBe(1_439);
    expect(parseAutomationInputMinute('24:00')).toBeNull();
    expect(parseAutomationInputMinute('9:30')).toBeNull();
    expect(parseAutomationInputMinute('12:60')).toBeNull();
    expect(formatAutomationInputMinute(570)).toBe('09:30');
    expect(
      formatAutomationSchedule({ cadence: 'daily', localTimeMinute: 570, weekday: null }),
    ).toBe('每天 09:30');
    expect(
      formatAutomationSchedule({ cadence: 'weekly', localTimeMinute: 1_050, weekday: 5 }),
    ).toBe('每周五 17:30');
  });

  it('keeps a stable list order and describes fixed actions and run state', () => {
    const later = item('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '2026-07-23T00:00:00.000Z');
    const earlier = item('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2026-07-22T00:00:00.000Z');
    expect(sortAutomationItems([later, earlier]).map(({ id }) => id)).toEqual([
      earlier.id,
      later.id,
    ]);
    expect(describeAutomationAction(earlier.action)).toBe('创建今日任务：检查备份');
    expect(describeAutomationLastRun({ status: 'never' })).toBe('尚未运行');
    expect(
      describeAutomationLastRun({
        status: 'failed',
        attemptedAt: '2026-07-22T08:30:00.000Z',
        errorCode: 'workspace-unavailable',
        consecutiveFailures: 1,
        nextRetryAt: '2026-07-22T08:35:00.000Z',
      }),
    ).toContain('所属工作区不可用');
  });
});

function item(id: string, createdAt: string): AutomationItem {
  return {
    id,
    name: '服务器巡检',
    enabled: true,
    schedule: { cadence: 'daily', localTimeMinute: 510, weekday: null },
    action: { kind: 'create-today-task', title: '检查备份' },
    revision: 1,
    nextRunAt: '2026-07-24T08:30:00.000Z',
    lastRun: { status: 'never' },
    createdAt,
    updatedAt: createdAt,
  };
}
