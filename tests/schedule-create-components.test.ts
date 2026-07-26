/// <reference lib="dom" />

import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ScheduleCreateSyncWarning } from '../src/renderer/components/ScheduleCreateSyncWarning';
import { ScheduleCreateToast } from '../src/renderer/components/ScheduleCreateToast';
import {
  scheduleCreateTitleSummary,
  type ScheduleCreateFeedback,
} from '../src/renderer/schedule-create-navigation';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const SCHEDULE_ID = '22222222-2222-4222-8222-222222222222';

describe('schedule create renderer components', () => {
  it('renders one bounded polite receipt with complete schedule details and explicit edit', () => {
    const title = `  第一行\t第二行\n${'😀'.repeat(100)}不应泄露的尾部  `;
    const summary = scheduleCreateTitleSummary(title);
    const markup = renderScheduleToast({ ...feedback(), title });

    expect(Array.from(summary)).toHaveLength(96);
    expect(summary).toMatch(/^第一行 第二行 /u);
    expect(summary).toMatch(/…$/u);
    expect(summary).not.toContain('不应泄露的尾部');
    expect(markup).toContain(summary);
    expect(markup).not.toContain('不应泄露的尾部');
    expect(markup.match(/已创建日程/gu)).toHaveLength(2);
    expect(markup.match(/2026-07-27/gu)).toHaveLength(3);
    expect(markup.match(/09:00–10:30/gu)).toHaveLength(3);
    expect(markup.match(/专注/gu)).toHaveLength(3);
    expect(markup).toContain('aria-busy="false"');
    expect(markup.match(/role="status"/gu)).toHaveLength(1);
    expect(markup.match(/aria-live="polite"/gu)).toHaveLength(1);
    expect(markup).toContain('aria-atomic="true"');
    expect(markup).toContain('编辑日程');
    expect(markup).toContain('aria-label="编辑刚创建的日程"');
    expect(markup).toContain(`aria-label="关闭新建日程成功提示：“${summary}”"`);
    expect(markup).toContain('type="button"');
    expect(markup).not.toContain('href=');
    expect(markup).not.toContain('role="alert"');
  });

  it('renders every schedule kind truthfully', () => {
    for (const [kind, label] of [
      ['focus', '专注'],
      ['meeting', '会议'],
      ['review', '回顾'],
      ['personal', '个人'],
    ] as const) {
      const markup = renderScheduleToast({ ...feedback(), kind });
      expect(markup).toContain(label);
    }
  });

  it('renders the post-commit synchronization warning as an independent bounded alert', () => {
    const title = `${'日'.repeat(100)}不应泄露的尾部`;
    const summary = scheduleCreateTitleSummary(title);
    const message = '日程已创建，但当前列表未能同步。请刷新后查看，避免重复创建。';
    const markup = renderToStaticMarkup(
      createElement(ScheduleCreateSyncWarning, {
        title,
        scheduledFor: '2026-07-27',
        startMinute: 540,
        endMinute: 630,
        message,
        onRefresh: async () => undefined,
        onDismiss: () => undefined,
      }),
    );

    expect(markup).toContain(
      'class="task-create-toast task-create-sync-warning schedule-create-sync-warning"',
    );
    expect(markup.match(/role="alert"/gu)).toHaveLength(1);
    expect(markup).toContain('aria-atomic="true"');
    expect(markup).not.toContain(
      'class="task-create-toast task-create-sync-warning schedule-create-sync-warning" role="alert"',
    );
    expect(markup).toContain(summary);
    expect(markup).not.toContain('不应泄露的尾部');
    expect(markup).toContain(message);
    expect(markup).toContain('日程已创建，但列表未同步');
    expect(markup).toContain('2026-07-27');
    expect(markup).toContain('09:00–10:30');
    expect(markup).toContain('重新读取');
    expect(markup).toContain(`aria-label="重新读取日程列表并确认：“${summary}”"`);
    expect(markup).toContain(`aria-label="关闭日程同步警告：“${summary}”"`);
    expect(markup).not.toContain('编辑日程');
  });

  it('defers live-region publication, wires recovery, and moves focus before receipt removal', () => {
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const closeStart = source.indexOf('const closeScheduleDialog');
    const dialogClose = source.indexOf('setScheduleDialog(null)', closeStart);
    const publicationTake = source.indexOf('scheduleCreatePublicationGate.take(', closeStart);
    const feedbackPublication = source.indexOf('setScheduleCreateFeedbackState({', publicationTake);
    const openStart = source.indexOf('const openCreatedSchedule');
    const focusIndex = source.indexOf('focusTodayActivityRailAnchor();', openStart);
    const dismissIndex = source.indexOf('scheduleCreateCoordinator.dismiss(', openStart);
    const confirmIndex = source.indexOf('confirmLeaveNoteDraft()', openStart);
    const postConfirmDateCheck = source.indexOf(
      'isScheduleCreateTodayDateCurrent(target.todayDate, new Date())',
      confirmIndex,
    );

    expect(closeStart).toBeGreaterThan(0);
    expect(dialogClose).toBeGreaterThan(closeStart);
    expect(publicationTake).toBeGreaterThan(dialogClose);
    expect(feedbackPublication).toBeGreaterThan(publicationTake);
    expect(source).toContain('scheduleCreatePublicationGate.stage(intent.workspace, {');
    expect(source).toContain('scheduleCreatePublicationGate.clear()');
    expect(source).toContain('onClose={closeScheduleDialog}');
    expect(source).toContain('.activity-rail button[aria-label="今日"]');
    expect(focusIndex).toBeGreaterThan(openStart);
    expect(dismissIndex).toBeGreaterThan(focusIndex);
    expect(postConfirmDateCheck).toBeGreaterThan(confirmIndex);
    expect(source).toContain('const refreshScheduleCreateSyncWarning');
    expect(source).toContain('scheduleController.prepareSnapshotRefresh()');
    expect(source).toContain('id === warning.createdScheduleId');
    expect(source).toContain('scheduledFor === warning.scheduledFor');
    expect(source).toContain('scheduleCreateCoordinator.createRecoveredFeedback(');
    expect(source).toContain('throw scheduleCreateSyncRefreshError(error)');
    expect(source).toContain('const invalidateScheduleCreate');
    expect(source).toContain('setScheduleCreateSyncWarningState(null)');

    const refreshStart = source.indexOf('const refreshScheduleCreateSyncWarning');
    const awaitIndex = source.indexOf(
      'await scheduleController.prepareSnapshotRefresh()',
      refreshStart,
    );
    const postAwaitGenerationCheck = source.indexOf(
      '!scheduleCreateCoordinator.isGenerationCurrent(',
      awaitIndex,
    );
    const commitIndex = source.indexOf('refresh.commit()', awaitIndex);
    expect(postAwaitGenerationCheck).toBeGreaterThan(awaitIndex);
    expect(commitIndex).toBeGreaterThan(postAwaitGenerationCheck);
  });
});

function feedback(): ScheduleCreateFeedback {
  return {
    requestGeneration: 4,
    workspaceId: WORKSPACE_ID,
    createdScheduleId: SCHEDULE_ID,
    title: '深度工作',
    scheduledFor: '2026-07-27',
    startMinute: 540,
    endMinute: 630,
    kind: 'focus',
  };
}

function scheduleToast(value: ScheduleCreateFeedback) {
  return createElement(ScheduleCreateToast, {
    feedback: value,
    focusBlocked: false,
    onOpen: async () => undefined,
    onDismiss: () => true,
    onFocusFallback: () => undefined,
  });
}

function renderScheduleToast(value: ScheduleCreateFeedback): string {
  return renderToStaticMarkup(scheduleToast(value));
}
