/// <reference lib="dom" />

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { InboxUndoStack } from '../src/renderer/components/InboxUndoStack';
import { TaskCreateSyncWarning } from '../src/renderer/components/TaskCreateSyncWarning';
import { TaskCreateToast } from '../src/renderer/components/TaskCreateToast';
import type { InboxUndoNotice } from '../src/renderer/hooks/useInboxController';
import type { InboxEntry } from '../src/shared/contracts';
import {
  taskCreateTitleSummary,
  type TaskCreateFeedback,
} from '../src/renderer/task-create-navigation';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const TASK_ID = '22222222-2222-4222-8222-222222222222';
const INBOX_ID = '33333333-3333-4333-8333-333333333333';
const UNDO_TOKEN = '44444444-4444-4444-8444-444444444444';

describe('task create renderer components', () => {
  it('renders one bounded polite success status with explicit open and close actions', () => {
    const title = `  第一行\t第二行\n${'😀'.repeat(100)}不应泄露的尾部  `;
    const summary = taskCreateTitleSummary(title);
    const markup = renderTaskToast({ ...feedback(), title });

    expect(Array.from(summary)).toHaveLength(96);
    expect(summary).toMatch(/^第一行 第二行 /u);
    expect(summary).toMatch(/…$/u);
    expect(summary).not.toContain('不应泄露的尾部');
    expect(markup).toContain(summary);
    expect(markup).not.toContain('不应泄露的尾部');
    expect(markup.match(/已创建任务/gu)).toHaveLength(2);
    expect(markup).toContain('aria-busy="false"');
    expect(markup.match(/role="status"/gu)).toHaveLength(1);
    expect(markup.match(/aria-live="polite"/gu)).toHaveLength(1);
    expect(markup).toContain('aria-atomic="true"');
    expect(markup).toContain('打开任务');
    expect(markup).toContain('aria-label="打开刚创建的任务"');
    expect(markup).toContain(`aria-label="关闭新建任务成功提示：“${summary}”"`);
    expect(markup).toContain('type="button"');
    expect(markup).not.toContain('href=');
    expect(markup).not.toContain('role="alert"');
  });

  it('hosts task and inbox notifications together in the generalized operation stack', () => {
    const archivedEntry = inboxEntry();
    const undoExpiresAt = '2026-07-27T12:00:15.000Z';
    const notice: InboxUndoNotice = {
      undoToken: UNDO_TOKEN,
      workspaceId: WORKSPACE_ID,
      entry: archivedEntry,
      undoExpiresAt,
      expiresAtMonotonicMs: 10_000,
      phase: 'archived',
      undoAvailable: true,
      refreshing: false,
      refreshError: null,
      focusActionOnMount: false,
    };
    const markup = renderToStaticMarkup(
      createElement(
        InboxUndoStack,
        {
          notices: [notice],
          pendingTokens: new Set<string>(),
          focusBlocked: false,
          blocked: false,
          workspaceLeasePending: false,
          workspaceLeaseBlockedReason: '另一项收件箱归档或撤销完成后，才能处理这条通知。',
          workspaceRecoveryPending: false,
          workspaceRecoveryBlockedReason: '请先完成已提交归档或撤销的重新读取，再处理其他通知。',
          onUndo: async () => undefined,
          onRefresh: async () => undefined,
          onDismiss: () => undefined,
          onFocusFallback: () => undefined,
        },
        taskToast(feedback()),
      ),
    );

    expect(markup).toContain('<section class="inbox-undo-stack" aria-label="操作通知">');
    expect(markup).not.toContain('aria-label="收件箱操作通知"');
    expect(markup).toContain('class="task-create-toast"');
    expect(markup).toContain('已创建任务');
    expect(markup).toContain('整理发布清单');
    expect(markup).toContain('class="inbox-undo-toast"');
    expect(markup).toContain('已归档');
    expect(markup).toContain('稍后整理');
  });

  it('renders the post-commit synchronization warning as an independent bounded alert', () => {
    const title = `${'任'.repeat(100)}不应泄露的尾部`;
    const summary = taskCreateTitleSummary(title);
    const message = '任务已创建，但当前任务列表未能同步。请刷新后查看，避免重复创建。';
    const markup = renderToStaticMarkup(
      createElement(TaskCreateSyncWarning, {
        title,
        message,
        onDismiss: () => undefined,
      }),
    );

    expect(markup).toContain('class="task-create-toast task-create-sync-warning"');
    expect(markup).toContain('role="alert"');
    expect(markup).toContain('aria-atomic="true"');
    expect(markup).toContain(summary);
    expect(markup).not.toContain('不应泄露的尾部');
    expect(markup).toContain(message);
    expect(markup).toContain('任务已创建，但列表未同步');
    expect(markup).toContain(`aria-label="关闭任务同步警告：“${summary}”"`);
    expect(markup).not.toContain('打开任务');
  });
});

function feedback(): TaskCreateFeedback {
  return {
    requestGeneration: 4,
    workspaceId: WORKSPACE_ID,
    createdTaskId: TASK_ID,
    title: '整理发布清单',
    plannedFor: '2026-07-27',
  };
}

function inboxEntry(): InboxEntry {
  return {
    id: INBOX_ID,
    content: '稍后整理',
    category: 'uncategorized',
    createdAt: '2026-07-27T12:00:00.000Z',
    updatedAt: '2026-07-27T12:00:00.000Z',
  };
}

function taskToast(value: TaskCreateFeedback) {
  return createElement(TaskCreateToast, {
    feedback: value,
    focusBlocked: false,
    onOpen: async () => undefined,
    onDismiss: () => true,
    onFocusFallback: () => undefined,
  });
}

function renderTaskToast(value: TaskCreateFeedback): string {
  return renderToStaticMarkup(taskToast(value));
}
