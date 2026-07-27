import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { AutomationItem, AutomationSnapshot } from '../src/shared/contracts';
import {
  automationSnapshotForActivation,
  automationRunFeedbackKey,
  automationRunOutputLabel,
  automationRunFeedbackForRequest,
  automationRunFeedbackAfterMainSuccess,
  automationRunNowConfirmation,
  createdAutomationFromResult,
  createAutomationRequestIdentity,
  createAutomationRunRequestIdentity,
  createAutomationWorkspaceIdentity,
  describeAutomationAction,
  describeAutomationLastRun,
  formatAutomationInputMinute,
  formatAutomationSchedule,
  isAutomationRequestLatest,
  isAutomationRequestCurrent,
  isAutomationRunRequestCurrent,
  isAutomationSequenceCurrent,
  isAutomationWorkspaceCurrent,
  parseAutomationInputMinute,
  requestAutomationRunNow,
  reconcileAutomationCreateResult,
  shouldApplyAutomationSnapshot,
  sortAutomationItems,
} from '../src/renderer/automation-state';

const WORKSPACE_A = '11111111-1111-4111-8111-111111111111';
const WORKSPACE_B = '22222222-2222-4222-8222-222222222222';

describe('automation renderer state', () => {
  it('keeps request-sequence activation guards available for snapshot-era compatibility', () => {
    const firstWorkspaceA = createAutomationWorkspaceIdentity(WORKSPACE_A);
    const request = createAutomationRunRequestIdentity(
      firstWorkspaceA,
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      4,
    );
    expect(request).not.toBeNull();
    if (!request) return;

    expect(isAutomationRunRequestCurrent(firstWorkspaceA, 4, request)).toBe(true);
    expect(isAutomationRunRequestCurrent(firstWorkspaceA, 5, request)).toBe(false);
    expect(
      isAutomationRunRequestCurrent(createAutomationWorkspaceIdentity(WORKSPACE_B), 4, request),
    ).toBe(false);
    expect(
      isAutomationRunRequestCurrent(createAutomationWorkspaceIdentity(WORKSPACE_A), 4, request),
    ).toBe(false);
    expect(
      createAutomationRunRequestIdentity(firstWorkspaceA, request.automationId, -1),
    ).toBeNull();
    expect(
      createAutomationRunRequestIdentity(
        createAutomationWorkspaceIdentity(null),
        request.automationId,
        5,
      ),
    ).toBeNull();
  });

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

  it('binds snapshot requests and committed state to one activation identity', () => {
    const firstA = createAutomationWorkspaceIdentity(WORKSPACE_A);
    const secondA = createAutomationWorkspaceIdentity(WORKSPACE_A);
    const request = createAutomationRequestIdentity(firstA, 7);
    expect(request).not.toBeNull();
    if (!request) return;
    const snapshot: AutomationSnapshot = { workspaceId: WORKSPACE_A, items: [] };

    expect(isAutomationRequestCurrent(firstA, request)).toBe(true);
    expect(isAutomationRequestCurrent(secondA, request)).toBe(false);
    expect(shouldApplyAutomationSnapshot(firstA, 6, request, snapshot)).toBe(true);
    expect(shouldApplyAutomationSnapshot(firstA, 7, request, snapshot)).toBe(false);
    expect(
      shouldApplyAutomationSnapshot(firstA, 6, request, {
        workspaceId: WORKSPACE_B,
        items: [],
      }),
    ).toBe(false);
    expect(automationSnapshotForActivation(firstA, { activation: firstA, snapshot })).toBe(
      snapshot,
    );
    expect(automationSnapshotForActivation(secondA, { activation: firstA, snapshot })).toBeNull();
    expect(createAutomationRequestIdentity(createAutomationWorkspaceIdentity(null), 8)).toBeNull();
    expect(createAutomationRequestIdentity(firstA, -1)).toBeNull();
  });

  it('resolves a created automation only by the Main-returned opaque id', () => {
    const expected = item('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2026-07-22T00:00:00.000Z');
    const sameName = {
      ...item('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '2026-07-23T00:00:00.000Z'),
      name: expected.name,
    };
    const result = {
      automationSnapshot: {
        workspaceId: WORKSPACE_A,
        items: [sameName, expected],
      },
      createdAutomationId: expected.id,
    };

    expect(createdAutomationFromResult(WORKSPACE_A, result)).toBe(expected);
    expect(createdAutomationFromResult(WORKSPACE_B, result)).toBeNull();
    expect(
      createdAutomationFromResult(WORKSPACE_A, {
        ...result,
        createdAutomationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      }),
    ).toBeNull();
    expect(
      createdAutomationFromResult(WORKSPACE_A, {
        ...result,
        automationSnapshot: {
          ...result.automationSnapshot,
          items: [expected, { ...expected }],
        },
      }),
    ).toBeNull();
  });

  it('reconciles an onChanged race from committed state without another read', async () => {
    const created = item('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2026-07-22T00:00:00.000Z');
    const refresh = vi.fn();

    await expect(
      reconcileAutomationCreateResult({
        expectedWorkspaceId: WORKSPACE_A,
        result: {
          automationSnapshot: { workspaceId: WORKSPACE_A, items: [created] },
          createdAutomationId: created.id,
        },
        commitResultSnapshot: () => false,
        getCommittedAutomation: () => created,
        prepareSnapshotRefresh: refresh,
        isCurrent: () => true,
      }),
    ).resolves.toEqual({
      createdAutomation: created,
      committed: true,
      error: undefined,
    });
    expect(refresh).not.toHaveBeenCalled();
  });

  it('recovers a failed first refresh on the bounded second authoritative read', async () => {
    const created = item('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2026-07-22T00:00:00.000Z');
    const firstFailure = new Error('first read failed');
    const prepareSnapshotRefresh = vi
      .fn()
      .mockRejectedValueOnce(firstFailure)
      .mockResolvedValueOnce({
        snapshot: { workspaceId: WORKSPACE_A, items: [created] },
        commit: () => true,
      });

    await expect(
      reconcileAutomationCreateResult({
        expectedWorkspaceId: WORKSPACE_A,
        result: {
          automationSnapshot: { workspaceId: WORKSPACE_A, items: [created] },
          createdAutomationId: created.id,
        },
        commitResultSnapshot: () => false,
        getCommittedAutomation: () => null,
        prepareSnapshotRefresh,
        isCurrent: () => true,
      }),
    ).resolves.toEqual({
      createdAutomation: created,
      committed: true,
      error: firstFailure,
    });
    expect(prepareSnapshotRefresh).toHaveBeenCalledTimes(2);
  });

  it('stops create reconciliation when its activation is no longer current', async () => {
    const created = item('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2026-07-22T00:00:00.000Z');
    const prepareSnapshotRefresh = vi.fn();

    await expect(
      reconcileAutomationCreateResult({
        expectedWorkspaceId: WORKSPACE_A,
        result: {
          automationSnapshot: { workspaceId: WORKSPACE_A, items: [created] },
          createdAutomationId: created.id,
        },
        commitResultSnapshot: () => false,
        getCommittedAutomation: () => null,
        prepareSnapshotRefresh,
        isCurrent: () => false,
      }),
    ).resolves.toEqual({
      createdAutomation: created,
      committed: false,
      error: undefined,
    });
    expect(prepareSnapshotRefresh).not.toHaveBeenCalled();
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

  it('creates feedback from the initiating request without consulting the current workspace', () => {
    const automation = item('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2026-07-22T00:00:00.000Z');
    const request = createAutomationRunRequestIdentity(
      createAutomationWorkspaceIdentity(WORKSPACE_A),
      automation.id,
      1,
    );
    expect(request).not.toBeNull();
    if (!request) return;
    const result = {
      workspaceId: WORKSPACE_A,
      automationId: automation.id,
      outputKind: 'task' as const,
      outputId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    };

    expect(automationRunFeedbackForRequest(request, automation, result)).toMatchObject({
      workspaceId: WORKSPACE_A,
      automationId: automation.id,
      outputKind: 'task',
      outputId: result.outputId,
      outputTitle: '检查备份',
      message: '已立即创建今日任务：检查备份',
    });
    const taskFeedback = automationRunFeedbackForRequest(request, automation, result);
    expect(taskFeedback && automationRunOutputLabel(taskFeedback)).toBe('打开任务');
    expect(taskFeedback && automationRunFeedbackKey(taskFeedback)).toBe(
      JSON.stringify([WORKSPACE_A, automation.id, 'task', result.outputId]),
    );
    const note = {
      ...automation,
      action: {
        kind: 'create-note' as const,
        title: '每周回顾',
        body: '# 本周',
      },
    };
    const noteRequest = createAutomationRunRequestIdentity(
      createAutomationWorkspaceIdentity(WORKSPACE_A),
      note.id,
      2,
    );
    expect(noteRequest).not.toBeNull();
    if (!noteRequest) return;
    expect(
      automationRunFeedbackForRequest(noteRequest, note, {
        ...result,
        outputKind: 'note',
      }),
    ).toMatchObject({
      outputKind: 'note',
      outputTitle: '每周回顾',
      message: '已立即创建笔记：每周回顾',
    });
    const noteFeedback = automationRunFeedbackForRequest(noteRequest, note, {
      ...result,
      outputKind: 'note',
    });
    expect(noteFeedback && automationRunOutputLabel(noteFeedback)).toBe('打开笔记');
    expect(
      automationRunFeedbackForRequest(request, automation, {
        ...result,
        automationId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      }),
    ).toBeNull();
    expect(
      automationRunFeedbackForRequest(request, automation, {
        ...result,
        outputId: '   ',
      }),
    ).toBeNull();
    expect(
      automationRunFeedbackForRequest(
        createAutomationRunRequestIdentity(
          createAutomationWorkspaceIdentity(WORKSPACE_B),
          automation.id,
          3,
        )!,
        automation,
        result,
      ),
    ).toBeNull();
    expect(
      automationRunFeedbackForRequest(
        createAutomationRunRequestIdentity(
          createAutomationWorkspaceIdentity(WORKSPACE_A),
          'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
          4,
        )!,
        automation,
        result,
      ),
    ).toBeNull();
    expect(
      automationRunFeedbackForRequest(request, automation, {
        ...result,
        outputKind: 'note',
      }),
    ).toBeNull();
    expect(
      automationRunFeedbackAfterMainSuccess(request, automation, {
        ...result,
        automationId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      }),
    ).toMatchObject({
      workspaceId: WORKSPACE_A,
      automationId: automation.id,
      outputKind: 'task',
      outputId: '__unconfirmed_automation_output__:1',
    });
    expect(
      automationRunFeedbackAfterMainSuccess(request, automation, {
        ...result,
        outputId: '   ',
      }).outputId,
    ).toBe('__unconfirmed_automation_output__:1');
  });

  it('returns validated immediate-run feedback after Main settles without a current-view gate', () => {
    const source = readFileSync(
      new URL('../src/renderer/hooks/useAutomationController.ts', import.meta.url),
      'utf8',
    );
    const start = source.indexOf('  const runNow = useCallback(');
    const end = source.indexOf('\n  const snapshot =', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const runNowSource = source.slice(start, end);

    expect(runNowSource).toContain('async (item: AutomationItem): Promise<AutomationRunFeedback>');
    expect(runNowSource).toContain('return automationRunFeedbackAfterMainSuccess(');
    expect(runNowSource.match(/自动化立即运行失败，请重试。/gu)).toHaveLength(1);
    expect(runNowSource).not.toContain('isAutomationRunRequestCurrent');
    expect(runNowSource).not.toContain('requestIsCurrent');
    expect(runNowSource).toContain(
      [
        'finally {',
        '        endRunningItem(item.id);',
        '        endPendingItem(item.id);',
        '      }',
      ].join('\n'),
    );
    expect(source).not.toContain('setRunFeedbackState');
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
