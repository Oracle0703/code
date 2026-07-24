import { describe, expect, it } from 'vitest';
import type { AutomationItem, AutomationSnapshot } from '../src/shared/contracts';
import {
  automationRunFeedbackForCurrentWorkspace,
  automationRunNowConfirmation,
  describeAutomationAction,
  describeAutomationLastRun,
  formatAutomationInputMinute,
  formatAutomationSchedule,
  isAutomationRequestLatest,
  isAutomationSequenceCurrent,
  isAutomationWorkspaceCurrent,
  parseAutomationInputMinute,
  requestAutomationRunNow,
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
    expect(describeAutomationLastRun({ status: 'never' })).toBe('尚无计划运行记录');
    expect(
      describeAutomationLastRun({
        status: 'success',
        attemptedAt: '2026-07-22T08:30:00.000Z',
        completedAt: '2026-07-22T08:30:01.000Z',
        outputKind: 'task',
      }),
    ).toContain('上次计划运行成功');
    expect(
      describeAutomationLastRun({
        status: 'failed',
        attemptedAt: '2026-07-22T08:30:00.000Z',
        errorCode: 'workspace-unavailable',
        consecutiveFailures: 1,
        nextRetryAt: '2026-07-22T08:35:00.000Z',
      }),
    ).toContain('上次计划运行失败');
  });

  it('confirms the exact saved action and never invokes a cancelled immediate run', async () => {
    const enabled = item('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2026-07-22T00:00:00.000Z');
    const disabled = { ...enabled, enabled: false };
    const prompts: string[] = [];
    const runs: AutomationItem[] = [];

    await expect(
      requestAutomationRunNow(
        enabled,
        (automation) => {
          runs.push(automation);
        },
        (message) => {
          prompts.push(message);
          return false;
        },
      ),
    ).resolves.toBe(false);
    expect(runs).toEqual([]);
    expect(prompts).toEqual([automationRunNowConfirmation(enabled)]);
    expect(prompts[0]).toContain('已保存动作：创建今日任务“检查备份”。');
    expect(prompts[0]).toContain('不会改变启用状态、重复计划或计划运行记录');

    await expect(
      requestAutomationRunNow(
        disabled,
        (automation) => {
          runs.push(automation);
        },
        () => true,
      ),
    ).resolves.toBe(true);
    expect(runs).toEqual([disabled]);
  });

  it('includes the saved Markdown body in note confirmation text', () => {
    const note = {
      ...item('cccccccc-cccc-4ccc-8ccc-cccccccccccc', '2026-07-22T00:00:00.000Z'),
      action: {
        kind: 'create-note' as const,
        title: '每周回顾',
        body: '# 本周\n\n- 完成事项',
      },
    };

    expect(automationRunNowConfirmation(note)).toContain(
      '已保存动作：创建 Markdown 笔记“每周回顾”，正文逐字使用当前保存的模板：\n# 本周\n\n- 完成事项',
    );
  });

  it('creates feedback only for a matching result that still belongs to the active workspace', () => {
    const automation = item('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2026-07-22T00:00:00.000Z');
    const result = {
      workspaceId: WORKSPACE_A,
      automationId: automation.id,
      outputKind: 'task' as const,
      outputId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    };

    expect(
      automationRunFeedbackForCurrentWorkspace(WORKSPACE_A, WORKSPACE_A, automation, result),
    ).toMatchObject({
      workspaceId: WORKSPACE_A,
      automationId: automation.id,
      outputKind: 'task',
      message: '已立即创建今日任务：检查备份',
    });
    expect(
      automationRunFeedbackForCurrentWorkspace(WORKSPACE_B, WORKSPACE_A, automation, result),
    ).toBeNull();
    const note = {
      ...automation,
      action: {
        kind: 'create-note' as const,
        title: '每周回顾',
        body: '# 本周',
      },
    };
    expect(
      automationRunFeedbackForCurrentWorkspace(WORKSPACE_A, WORKSPACE_A, note, {
        ...result,
        outputKind: 'note',
      }),
    ).toMatchObject({
      outputKind: 'note',
      message: '已立即创建笔记：每周回顾',
    });
    expect(
      automationRunFeedbackForCurrentWorkspace(WORKSPACE_A, WORKSPACE_A, automation, {
        ...result,
        automationId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      }),
    ).toBeNull();
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
