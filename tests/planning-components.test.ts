/// <reference lib="dom" />

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ScheduleItem, Task } from '../src/shared/contracts';
import { createRollingPlanningDays } from '../src/shared/planning-domain';
import { RollingPlan } from '../src/renderer/components/RollingPlan';
import { TaskDialog } from '../src/renderer/components/TaskDialog';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const TODAY = '2026-07-23';
const PLANNING_DAYS = createRollingPlanningDays(TODAY);

describe('rolling planning renderer components', () => {
  it('renders seven accessible day tabs and only combines the selected day content', () => {
    const tasks = [task('today task', TODAY), task('future task', '2026-07-26')];
    const items = [schedule('today schedule', TODAY), schedule('future schedule', '2026-07-26')];
    const markup = renderToStaticMarkup(
      createElement(RollingPlan, {
        taskSnapshot: {
          workspaceId: WORKSPACE_ID,
          todayDate: TODAY,
          planningDays: PLANNING_DAYS,
          tasks,
        },
        scheduleSnapshot: {
          workspaceId: WORKSPACE_ID,
          todayDate: TODAY,
          planningDays: PLANNING_DAYS,
          items,
        },
        taskStatus: 'ready',
        scheduleStatus: 'ready',
        taskError: null,
        scheduleError: null,
        pendingTaskIds: new Set<string>(),
        pendingScheduleItemIds: new Set<string>(),
        taskCreatePending: false,
        scheduleCreatePending: false,
        onRetryTasks: () => undefined,
        onRetrySchedule: () => undefined,
        onCreateTask: () => undefined,
        onOpenTask: () => undefined,
        onUpdateTaskStatus: async () => undefined,
        onUpdateTaskPlanning: async () => undefined,
        onCreateSchedule: () => undefined,
        onOpenSchedule: () => undefined,
      }),
    );

    expect(markup.match(/role="tab"/gu)).toHaveLength(7);
    expect(markup).toContain('aria-selected="true"');
    expect(markup).toContain('today task');
    expect(markup).toContain('today schedule');
    expect(markup).not.toContain('future task');
    expect(markup).not.toContain('future schedule');
    expect(markup).toContain('7月26日');
    expect(markup).toContain('1 项任务，1 段日程');
  });

  it('does not combine task and schedule data from mismatched date windows', () => {
    const markup = renderToStaticMarkup(
      createElement(RollingPlan, {
        taskSnapshot: {
          workspaceId: WORKSPACE_ID,
          todayDate: TODAY,
          planningDays: PLANNING_DAYS,
          tasks: [task('must stay hidden', TODAY)],
        },
        scheduleSnapshot: {
          workspaceId: WORKSPACE_ID,
          todayDate: '2026-07-24',
          planningDays: createRollingPlanningDays('2026-07-24'),
          items: [],
        },
        taskStatus: 'ready',
        scheduleStatus: 'ready',
        taskError: null,
        scheduleError: null,
        pendingTaskIds: new Set<string>(),
        pendingScheduleItemIds: new Set<string>(),
        taskCreatePending: false,
        scheduleCreatePending: false,
        onRetryTasks: () => undefined,
        onRetrySchedule: () => undefined,
        onCreateTask: () => undefined,
        onOpenTask: () => undefined,
        onUpdateTaskStatus: async () => undefined,
        onUpdateTaskPlanning: async () => undefined,
        onCreateSchedule: () => undefined,
        onOpenSchedule: () => undefined,
      }),
    );

    expect(markup).toContain('任务与日程的日期窗口不一致');
    expect(markup).not.toContain('must stay hidden');
    expect(markup).not.toContain('role="tab"');
  });

  it('offers only Main-defined planning tokens in the task dialog', () => {
    const markup = renderToStaticMarkup(
      createElement(TaskDialog, {
        state: {
          mode: 'create',
          workspaceId: WORKSPACE_ID,
          workspaceName: '产品',
          planning: 'day-6',
        },
        planningDays: PLANNING_DAYS,
        onClose: () => undefined,
        onCreate: async () => undefined,
        onRename: async () => undefined,
        onConvert: async () => undefined,
      }),
    );

    expect(markup.match(/<option/gu)).toHaveLength(8);
    expect(markup).toContain('value="day-0"');
    expect(markup).toContain('value="day-6" selected=""');
    expect(markup).toContain('value="none"');
    expect(markup).not.toContain('value="today"');
  });
});

function task(title: string, plannedFor: string): Task {
  return {
    id:
      plannedFor === TODAY
        ? '22222222-2222-4222-8222-222222222222'
        : '33333333-3333-4333-8333-333333333333',
    title,
    status: 'todo',
    plannedFor,
    sourceInboxEntryId: null,
    createdAt: '2026-07-23T08:00:00.000Z',
    updatedAt: '2026-07-23T08:00:00.000Z',
    completedAt: null,
  };
}

function schedule(title: string, scheduledFor: string): ScheduleItem {
  return {
    id:
      scheduledFor === TODAY
        ? '44444444-4444-4444-8444-444444444444'
        : '55555555-5555-4555-8555-555555555555',
    title,
    kind: 'focus',
    scheduledFor,
    startMinute: 540,
    endMinute: 570,
    revision: 1,
    createdAt: '2026-07-23T08:00:00.000Z',
    updatedAt: '2026-07-23T08:00:00.000Z',
  };
}
