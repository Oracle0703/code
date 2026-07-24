/// <reference lib="dom" />

import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { FocusSession, FocusSnapshot, Task, TaskSnapshot } from '../src/shared/contracts';
import { createRollingPlanningDays } from '../src/shared/planning-domain';
import {
  TodayDashboard,
  type TodayDashboardProps,
} from '../src/renderer/components/TodayDashboard';
import { FocusSessionDialog } from '../src/renderer/components/FocusSessionDialog';

const WORKSPACE_A = '11111111-1111-4111-8111-111111111111';
const WORKSPACE_B = '22222222-2222-4222-8222-222222222222';
const SESSION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TASK_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const TODAY = '2026-07-23';
const OBSERVED_AT = '2026-07-23T12:00:00.000Z';
const PLANNING_DAYS = createRollingPlanningDays(TODAY);

describe('focus renderer components', () => {
  it('renders an idle fixed-duration timer and today completed-round count', () => {
    const markup = renderToStaticMarkup(
      createElement(
        TodayDashboard,
        dashboardProps({
          focusSnapshot: snapshot({ todayCompletedCount: 3 }),
          focusRemainingSeconds: 1_500,
        }),
      ),
    );

    expect(markup).toContain('role="timer"');
    expect(markup).toContain('aria-live="off"');
    expect(markup).toContain('25:00');
    expect(markup).toContain('今日完成 3 轮');
    expect(markup).toContain('开始专注');
    expect(markup).toContain('role="status"');
    expect(markup).not.toContain('暂停中');
  });

  it('offers pause and cancel only for a running session owned by this workspace', () => {
    const markup = renderToStaticMarkup(
      createElement(
        TodayDashboard,
        dashboardProps({
          focusSnapshot: snapshot({ session: session() }),
          focusRemainingSeconds: 1_274,
        }),
      ),
    );

    expect(markup).toContain('21:14');
    expect(markup).toContain('aria-label="剩余 21 分 14 秒"');
    expect(markup).toContain('当前任务：');
    expect(markup).toContain('撰写发布说明');
    expect(markup).toContain('>暂停</button>');
    expect(markup).toContain('取消本轮');
    expect(markup).not.toContain('切换到该工作区');
  });

  it('offers resume for a paused current-workspace session', () => {
    const markup = renderToStaticMarkup(
      createElement(
        TodayDashboard,
        dashboardProps({
          focusSnapshot: snapshot({
            session: session({ status: 'paused', deadlineAt: null, remainingSeconds: 600 }),
          }),
          focusRemainingSeconds: 600,
        }),
      ),
    );

    expect(markup).toContain('is-paused');
    expect(markup).toContain('10:00');
    expect(markup).toContain('>继续</button>');
    expect(markup).toContain('专注会话已暂停');
  });

  it('discloses a foreign session and only offers an explicit workspace switch', () => {
    const markup = renderToStaticMarkup(
      createElement(
        TodayDashboard,
        dashboardProps({
          focusSnapshot: snapshot({
            session: session({
              workspaceId: WORKSPACE_B,
              workspaceName: '研发',
              taskId: null,
              taskTitle: null,
            }),
          }),
          focusRemainingSeconds: 900,
        }),
      ),
    );

    expect(markup).toContain('<strong>研发</strong> 正在专注');
    expect(markup).toContain('切换到该工作区');
    expect(markup).not.toContain('取消本轮');
    expect(markup).not.toContain('>暂停</button>');
  });

  it('labels a paused foreign session without implying that its timer is running', () => {
    const markup = renderToStaticMarkup(
      createElement(
        TodayDashboard,
        dashboardProps({
          focusSnapshot: snapshot({
            session: session({
              workspaceId: WORKSPACE_B,
              workspaceName: '研发',
              status: 'paused',
              deadlineAt: null,
              remainingSeconds: 540,
            }),
          }),
          focusRemainingSeconds: 540,
        }),
      ),
    );

    expect(markup).toContain('<strong>研发</strong> 专注已暂停');
    expect(markup).toContain('切换到该工作区');
    expect(markup).not.toContain('<strong>研发</strong> 正在专注');
    expect(markup).not.toContain('取消本轮');
  });

  it('renders a labelled optional-task dialog and restores focus to its connected invoker', () => {
    const markup = renderToStaticMarkup(
      createElement(FocusSessionDialog, {
        tasks: [task()],
        onClose: () => undefined,
        onStart: async () => undefined,
      }),
    );
    const source = readFileSync(
      new URL('../src/renderer/components/FocusSessionDialog.tsx', import.meta.url),
      'utf8',
    );

    expect(markup).toContain('<dialog');
    expect(markup).toContain('aria-labelledby="focus-session-dialog-title"');
    expect(markup).toContain('aria-describedby="focus-session-dialog-description"');
    expect(markup).toContain('关联今日任务（可选）');
    expect(markup).toContain('不关联任务');
    expect(markup).toContain('撰写发布说明');
    expect(markup).toContain('25:00');
    expect(source).toContain('returnTarget?.isConnected');
    expect(source).toContain('returnTarget.focus()');
  });

  it('reports dialog visibility to the shell and clears it during dashboard cleanup', () => {
    const source = readFileSync(
      new URL('../src/renderer/components/TodayDashboard.tsx', import.meta.url),
      'utf8',
    );

    expect(source).toContain('onFocusDialogOpenChange(true)');
    expect(source).toContain('onFocusDialogOpenChange(false)');
    expect(source).toMatch(
      /useEffect\(\s*\(\) => \(\) => \{\s*onFocusDialogOpenChange\(false\);\s*\}/u,
    );
  });

  it('does not paint an old schedule snapshot while the task window advances at midnight', () => {
    const tomorrow = '2026-07-24';
    const staleItem = {
      id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      title: 'yesterday schedule must stay hidden',
      kind: 'review' as const,
      scheduledFor: TODAY,
      startMinute: 540,
      endMinute: 570,
      revision: 1,
      createdAt: OBSERVED_AT,
      updatedAt: OBSERVED_AT,
    };
    const markup = renderToStaticMarkup(
      createElement(
        TodayDashboard,
        dashboardProps({
          taskSnapshot: {
            workspaceId: WORKSPACE_A,
            todayDate: tomorrow,
            planningDays: createRollingPlanningDays(tomorrow),
            tasks: [],
          },
          scheduleItems: [staleItem],
          scheduleSnapshot: {
            workspaceId: WORKSPACE_A,
            todayDate: TODAY,
            planningDays: PLANNING_DAYS,
            items: [staleItem],
          },
        }),
      ),
    );

    expect(markup).not.toContain(staleItem.title);
    expect(markup).toContain('任务与日程的日期窗口不一致');
  });
});

function dashboardProps(overrides: Partial<TodayDashboardProps> = {}): TodayDashboardProps {
  const taskSnapshot: TaskSnapshot = {
    workspaceId: WORKSPACE_A,
    todayDate: TODAY,
    planningDays: PLANNING_DAYS,
    tasks: [task()],
  };
  return {
    inboxStatus: 'ready',
    inboxCount: 0,
    uncategorizedCount: 0,
    capturePending: false,
    taskSnapshot,
    taskStatus: 'ready',
    taskLoadError: null,
    taskOperationError: null,
    pendingTaskIds: new Set<string>(),
    taskCreatePending: false,
    scheduleSnapshot: {
      workspaceId: WORKSPACE_A,
      todayDate: TODAY,
      planningDays: PLANNING_DAYS,
      items: [],
    },
    scheduleItems: [],
    scheduleStatus: 'ready',
    scheduleLoadError: null,
    scheduleOperationError: null,
    pendingScheduleItemIds: new Set<string>(),
    scheduleCreatePending: false,
    focusSnapshot: snapshot(),
    focusStatus: 'ready',
    focusError: null,
    focusOperation: null,
    focusRemainingSeconds: 1_500,
    onCapture: async () => undefined,
    onOpenInbox: () => undefined,
    onOpenTasks: () => undefined,
    onRetryTasks: () => undefined,
    onCreateTask: () => undefined,
    onOpenTask: () => undefined,
    onUpdateTaskStatus: async () => undefined,
    onUpdateTaskPlanning: async () => undefined,
    onRetrySchedule: () => undefined,
    onCreateSchedule: () => undefined,
    onOpenSchedule: () => undefined,
    onOpenAssistant: () => undefined,
    onRetryFocus: () => undefined,
    onStartFocus: async () => undefined,
    onPauseFocus: async () => undefined,
    onResumeFocus: async () => undefined,
    onCancelFocus: async () => undefined,
    onSwitchFocusWorkspace: () => undefined,
    onFocusDialogOpenChange: () => undefined,
    ...overrides,
  };
}

function snapshot(overrides: Partial<FocusSnapshot> = {}): FocusSnapshot {
  return {
    workspaceId: WORKSPACE_A,
    todayDate: TODAY,
    observedAt: OBSERVED_AT,
    session: null,
    todayCompletedCount: 0,
    ...overrides,
  };
}

function session(overrides: Partial<FocusSession> = {}): FocusSession {
  return {
    id: SESSION_ID,
    workspaceId: WORKSPACE_A,
    workspaceName: '产品',
    taskId: TASK_ID,
    taskTitle: '撰写发布说明',
    status: 'running',
    remainingSeconds: 1_500,
    deadlineAt: '2026-07-23T12:25:00.000Z',
    revision: 1,
    createdAt: OBSERVED_AT,
    updatedAt: OBSERVED_AT,
    ...overrides,
  };
}

function task(): Task {
  return {
    id: TASK_ID,
    title: '撰写发布说明',
    status: 'todo',
    plannedFor: TODAY,
    sourceInboxEntryId: null,
    createdAt: OBSERVED_AT,
    updatedAt: OBSERVED_AT,
    completedAt: null,
  };
}
