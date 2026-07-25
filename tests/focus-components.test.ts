/// <reference lib="dom" />

import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { FocusSession, FocusSnapshot, Task, TaskSnapshot } from '../src/shared/contracts';
import { createRollingPlanningDays } from '../src/shared/planning-domain';
import {
  TodayDashboard,
  type TodayDashboardProps,
} from '../src/renderer/components/TodayDashboard';
import { FocusSessionDialog } from '../src/renderer/components/FocusSessionDialog';
import {
  submitFocusDialogSelection,
  type FocusDialogSubmissionGate,
} from '../src/renderer/focus-dialog-submission';
import { createFocusWorkspaceIdentity } from '../src/renderer/focus-state';
import { TaskPage } from '../src/renderer/components/TaskPage';

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

  it('offers an explicit accessible completion action for the exact linked task', () => {
    const markup = renderToStaticMarkup(
      createElement(
        TodayDashboard,
        dashboardProps({
          focusSnapshot: snapshot({
            latestTerminal: {
              sessionId: SESSION_ID,
              workspaceId: WORKSPACE_A,
              taskId: TASK_ID,
              taskTitle: '撰写发布说明',
              status: 'completed',
              endedAt: OBSERVED_AT,
            },
            todayCompletedCount: 1,
          }),
          focusTaskCompletion: completionNotice(),
        }),
      ),
    );

    expect(markup).toContain('本轮专注已完成');
    expect(markup).toContain('已完成 25 分钟');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain('aria-atomic="true"');
    expect(markup).toContain('aria-label="标记任务完成：撰写发布说明"');
    expect(markup).toContain('>标记任务完成</button>');
    expect(markup).toContain('>暂不处理</button>');
    expect(markup).not.toContain('>开始专注</button>');
    expect(markup.match(/role="status"/gu)).toHaveLength(1);
  });

  it('keeps a completion actionable after failure and exposes one busy submission', () => {
    const failedMarkup = renderToStaticMarkup(
      createElement(
        TodayDashboard,
        dashboardProps({
          focusTaskCompletion: completionNotice(),
          focusTaskCompletionAction: {
            completionKey: completionNotice().key,
            pending: false,
            error: '任务更新失败，请重试。',
          },
        }),
      ),
    );
    expect(failedMarkup).toContain('role="alert"');
    expect(failedMarkup).toContain('任务更新失败，请重试。');
    expect(failedMarkup).toContain('>标记任务完成</button>');

    const pendingMarkup = renderToStaticMarkup(
      createElement(
        TodayDashboard,
        dashboardProps({
          focusTaskCompletion: completionNotice(),
          focusTaskCompletionAction: {
            completionKey: completionNotice().key,
            pending: true,
            error: null,
          },
        }),
      ),
    );
    expect(pendingMarkup).toContain('aria-busy="true"');
    expect(pendingMarkup).toContain('>正在完成…</button>');
    expect(pendingMarkup).toMatch(/>暂不处理<\/button>/u);
    expect(pendingMarkup).toMatch(/class="focus-card__cancel" disabled=""/u);
  });

  it('distinguishes an unavailable task snapshot from a loading completion', () => {
    const markup = renderToStaticMarkup(
      createElement(
        TodayDashboard,
        dashboardProps({
          taskSnapshot: null,
          taskStatus: 'error',
          taskLoadError: '任务读取失败。',
          focusTaskCompletion: completionNotice(),
        }),
      ),
    );

    expect(markup).toContain('role="alert"');
    expect(markup).toContain('任务读取失败。');
    expect(markup).toContain('>重新读取任务</button>');
    expect(markup).not.toContain('正在复核关联任务');
    expect(markup).not.toContain('aria-label="标记任务完成');
  });

  it('does not offer another mutation when the linked task is already complete', () => {
    const completedTask = {
      ...task(),
      status: 'completed' as const,
      completedAt: OBSERVED_AT,
    };
    const markup = renderToStaticMarkup(
      createElement(
        TodayDashboard,
        dashboardProps({
          taskSnapshot: {
            workspaceId: WORKSPACE_A,
            todayDate: TODAY,
            planningDays: PLANNING_DAYS,
            tasks: [completedTask],
          },
          focusTaskCompletion: completionNotice(),
        }),
      ),
    );

    expect(markup).toContain('关联任务已经完成');
    expect(markup).toContain('>知道了</button>');
    expect(markup).not.toContain('aria-label="标记任务完成');
  });

  it('renders a labelled optional-task dialog and restores focus to its connected invoker', () => {
    const markup = renderToStaticMarkup(
      createElement(FocusSessionDialog, {
        tasks: [task()],
        initialTask: task(),
        startBlockedReason: null,
        taskOptionsUnavailableReason: null,
        onClose: () => undefined,
        onStart: async () => undefined,
        onStarted: () => undefined,
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
    expect(markup).toContain('自由专注（不关联任务）');
    expect(markup).toContain('撰写发布说明');
    expect(markup).toContain('selected=""');
    expect(markup).toContain('25:00');
    expect(source).toContain('returnTarget?.isConnected');
    expect(source).toContain('returnTarget.focus()');
    expect(source).toContain('restoreInvokerRef.current');
  });

  it('keeps a missing direct task invalid instead of silently selecting free focus', () => {
    const markup = renderToStaticMarkup(
      createElement(FocusSessionDialog, {
        tasks: [],
        initialTask: task(),
        startBlockedReason: null,
        taskOptionsUnavailableReason: null,
        onClose: () => undefined,
        onStart: async () => undefined,
        onStarted: () => undefined,
      }),
    );

    expect(markup).toContain('不再可用 · 撰写发布说明');
    expect(markup).toContain('任务不可用 · 撰写发布说明');
    expect(markup).toContain('已完成、改期或不再可用');
    expect(markup).toContain('aria-invalid="true"');
    expect(markup).toContain('aria-errormessage="focus-session-task-error"');
    expect(markup).toMatch(/class="focus-session-dialog__primary" disabled=""/u);
  });

  it('distinguishes unavailable task options from a truly empty task list', () => {
    const reason = '正在同步任务状态，请稍候。';
    const markup = renderToStaticMarkup(
      createElement(FocusSessionDialog, {
        tasks: [],
        startBlockedReason: null,
        taskOptionsUnavailableReason: reason,
        onClose: () => undefined,
        onStart: async () => undefined,
        onStarted: () => undefined,
      }),
    );

    expect(markup).toContain(reason);
    expect(markup).toContain('仍可开始自由专注（不关联任务）');
    expect(markup).not.toContain('今天没有未完成任务');
  });

  it('submits the exact task identity and reports success while still mounted', async () => {
    const selectedTask = task();
    const gate: FocusDialogSubmissionGate = { mounted: true, submitting: false };
    const onStart = vi.fn(async () => undefined);
    const onSucceeded = vi.fn();

    await submitFocusDialogSelection(
      gate,
      { task: selectedTask, taskId: selectedTask.id, invalid: false },
      null,
      selectedTask.title,
      {
        onStart,
        onSubmittingChange: vi.fn(),
        onError: vi.fn(),
        onSucceeded,
      },
    );

    expect(onStart).toHaveBeenCalledOnce();
    expect(onStart).toHaveBeenCalledWith(selectedTask.id);
    expect(onSucceeded).toHaveBeenCalledOnce();
    expect(gate.submitting).toBe(false);
  });

  it('blocks double submission and ignores a success that arrives after unmount', async () => {
    const selectedTask = task();
    const gate: FocusDialogSubmissionGate = { mounted: true, submitting: false };
    let resolveStart: (() => void) | undefined;
    const onStart = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveStart = resolve;
        }),
    );
    const onSucceeded = vi.fn();
    const callbacks = {
      onStart,
      onSubmittingChange: vi.fn(),
      onError: vi.fn(),
      onSucceeded,
    };
    const selection = { task: selectedTask, taskId: selectedTask.id, invalid: false };

    const first = submitFocusDialogSelection(gate, selection, null, selectedTask.title, callbacks);
    const second = submitFocusDialogSelection(gate, selection, null, selectedTask.title, callbacks);

    expect(onStart).toHaveBeenCalledOnce();
    gate.mounted = false;
    resolveStart?.();
    await Promise.all([first, second]);

    expect(onSucceeded).not.toHaveBeenCalled();
    expect(gate.submitting).toBe(false);
  });

  it('keeps invalid selection separate from an explicit free-focus submission', async () => {
    const onStart = vi.fn(async () => undefined);
    const onError = vi.fn();
    const callbacks = {
      onStart,
      onSubmittingChange: vi.fn(),
      onError,
      onSucceeded: vi.fn(),
    };

    await submitFocusDialogSelection(
      { mounted: true, submitting: false },
      { task: null, taskId: undefined, invalid: true },
      null,
      '撰写发布说明',
      callbacks,
    );
    expect(onStart).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('自由专注（不关联任务）'));

    await submitFocusDialogSelection(
      { mounted: true, submitting: false },
      { task: null, taskId: undefined, invalid: false },
      null,
      '',
      callbacks,
    );
    expect(onStart).toHaveBeenCalledOnce();
    expect(onStart).toHaveBeenCalledWith(undefined);
  });

  it('owns one shared dialog and moves focus to the Today focus card after success', () => {
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');

    expect(source).toContain('activation: focusActivation');
    expect(source).toContain("requestActiveView('today')");
    expect(source).toContain('setFocusSuccessSequence');
    expect(source.match(/<FocusSessionDialog/gu)).toHaveLength(1);
  });

  it('offers direct focus only for unfinished today tasks in Today and Tasks', () => {
    const completedToday = {
      ...task(),
      id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      title: '已经完成',
      status: 'completed' as const,
      completedAt: OBSERVED_AT,
    };
    const futureTask = {
      ...task(),
      id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      title: '明天处理',
      plannedFor: '2026-07-24',
    };
    const unplannedTask = {
      ...task(),
      id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      title: '尚未安排',
      plannedFor: null,
    };
    const taskSnapshot: TaskSnapshot = {
      workspaceId: WORKSPACE_A,
      todayDate: TODAY,
      planningDays: PLANNING_DAYS,
      tasks: [task(), completedToday, futureTask, unplannedTask],
    };
    const todayMarkup = renderToStaticMarkup(
      createElement(
        TodayDashboard,
        dashboardProps({
          taskSnapshot,
        }),
      ),
    );
    const tasksMarkup = renderToStaticMarkup(
      createElement(TaskPage, {
        snapshot: taskSnapshot,
        tasks: taskSnapshot.tasks,
        status: 'ready',
        loadError: null,
        operationError: null,
        pendingTaskIds: new Set<string>(),
        onRetry: () => undefined,
        onOpenCreate: () => undefined,
        onOpenRename: () => undefined,
        onUpdateStatus: async () => undefined,
        onUpdatePlanning: async () => undefined,
        taskFocusStartUnavailableReason: null,
        onOpenFocus: () => undefined,
        onOpenFocusStatus: () => undefined,
        assistantTaskLimit: 8,
        onOpenAssistant: () => undefined,
      }),
    );

    for (const markup of [todayMarkup, tasksMarkup]) {
      expect(markup).toContain('aria-label="开始专注：撰写发布说明"');
      expect(markup).not.toContain('aria-label="开始专注：已经完成"');
      expect(markup).not.toContain('aria-label="开始专注：明天处理"');
      expect(markup).not.toContain('aria-label="开始专注：尚未安排"');
    }
  });

  it('keeps blocked direct entries focusable with an explicit reason and recovery path', () => {
    const reason = '研发已有正在运行的专注会话，请先处理该会话。';
    const taskSnapshot: TaskSnapshot = {
      workspaceId: WORKSPACE_A,
      todayDate: TODAY,
      planningDays: PLANNING_DAYS,
      tasks: [task()],
    };
    const todayMarkup = renderToStaticMarkup(
      createElement(
        TodayDashboard,
        dashboardProps({
          taskFocusStartUnavailableReason: reason,
        }),
      ),
    );
    const tasksMarkup = renderToStaticMarkup(
      createElement(TaskPage, {
        snapshot: taskSnapshot,
        tasks: taskSnapshot.tasks,
        status: 'ready',
        loadError: null,
        operationError: null,
        pendingTaskIds: new Set<string>(),
        onRetry: () => undefined,
        onOpenCreate: () => undefined,
        onOpenRename: () => undefined,
        onUpdateStatus: async () => undefined,
        onUpdatePlanning: async () => undefined,
        taskFocusStartUnavailableReason: reason,
        onOpenFocus: () => undefined,
        onOpenFocusStatus: () => undefined,
        assistantTaskLimit: 8,
        onOpenAssistant: () => undefined,
      }),
    );

    for (const markup of [todayMarkup, tasksMarkup]) {
      expect(markup).toContain('aria-label="开始专注：撰写发布说明"');
      expect(markup).toContain(reason);
      expect(markup).toMatch(/aria-label="开始专注：撰写发布说明"[^>]*aria-disabled="true"/u);
    }
    expect(todayMarkup).toContain('id="today-task-focus-unavailable"');
    expect(tasksMarkup).toContain('id="task-focus-unavailable"');
    expect(tasksMarkup).toContain('前往今日处理');
  });

  it('keeps a pending task focusable and explains its local guard', () => {
    const markup = renderToStaticMarkup(
      createElement(
        TodayDashboard,
        dashboardProps({
          pendingTaskIds: new Set([TASK_ID]),
        }),
      ),
    );

    expect(markup).toContain(`aria-describedby="today-task-focus-pending-${TASK_ID}"`);
    expect(markup).toContain('aria-disabled="true"');
    expect(markup).toContain('任务正在更新，请稍候。');
  });

  it('adapts task actions to the actual page pane width', () => {
    const styles = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(styles).toContain('container-name: task-page');
    expect(styles).toContain('@container task-page (max-width: 760px)');
    expect(styles).toContain('@container task-page (max-width: 520px)');
    expect(styles).not.toMatch(/\.task-(?:row|page-row)__focus\s*\{[^}]*#c3baff/su);
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
    focusSuccessSequence: 0,
    focusTaskCompletion: null,
    focusTaskCompletionAction: null,
    taskFocusStartUnavailableReason: null,
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
    onOpenFocus: () => undefined,
    onPauseFocus: async () => undefined,
    onResumeFocus: async () => undefined,
    onCancelFocus: async () => undefined,
    onSwitchFocusWorkspace: () => undefined,
    onCompleteFocusTask: async () => undefined,
    onDismissFocusTaskCompletion: () => undefined,
    ...overrides,
  };
}

function snapshot(overrides: Partial<FocusSnapshot> = {}): FocusSnapshot {
  return {
    workspaceId: WORKSPACE_A,
    todayDate: TODAY,
    observedAt: OBSERVED_AT,
    session: null,
    latestTerminal: null,
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

function completionNotice() {
  const workspace = createFocusWorkspaceIdentity(WORKSPACE_A);
  return {
    key: 'focus-task-completion',
    workspace,
    workspaceId: WORKSPACE_A,
    todayDate: TODAY,
    sessionId: SESSION_ID,
    taskId: TASK_ID,
    taskTitle: '撰写发布说明',
    endedAt: OBSERVED_AT,
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
