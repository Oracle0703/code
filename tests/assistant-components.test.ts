/// <reference lib="dom" />
// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="../src/types/workbench.d.ts" />

import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  WORKSPACE_VIEW_IDS,
  type AssistantSnapshot,
  type TaskSnapshot,
} from '../src/shared/contracts';
import { ActivityRail } from '../src/renderer/components/ActivityRail';
import { AssistantPage } from '../src/renderer/components/AssistantPage';
import { NotePage } from '../src/renderer/components/NotePage';
import { AssistantSettings } from '../src/renderer/components/SettingsPage';
import { TaskPage } from '../src/renderer/components/TaskPage';
import { TodayDashboard } from '../src/renderer/components/TodayDashboard';
import {
  assistantEntryContextForWorkspace,
  shouldApplyAssistantSnapshot,
  visibleAssistantRuntime,
} from '../src/renderer/assistant-state';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const TASK_ID = '22222222-2222-4222-8222-222222222222';

beforeAll(() => {
  vi.stubGlobal('window', { workbench: {} });
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe('assistant renderer surfaces', () => {
  it('keys the assistant page to the active workspace so local drafts cannot cross boundaries', () => {
    const appSource = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');

    expect(appSource).toMatch(
      /<AssistantPage\s+key=\{snapshot\.currentWorkspaceId\}\s+workspaceName=/u,
    );
  });

  it('drops an explicit entry context before rendering a different workspace', () => {
    const context = { kind: 'tasks', taskIds: [TASK_ID] } as const;
    const nextWorkspaceId = '33333333-3333-4333-8333-333333333333';

    expect(assistantEntryContextForWorkspace(nextWorkspaceId, WORKSPACE_ID, context)).toEqual({
      kind: 'none',
    });
    expect(assistantEntryContextForWorkspace(WORKSPACE_ID, WORKSPACE_ID, context)).toBe(context);
  });

  it('keeps assistant out of persisted workspace view identifiers', () => {
    expect(WORKSPACE_VIEW_IDS).not.toContain('assistant');
  });

  it('marks assistant navigation as the current page without toggle semantics', () => {
    const markup = renderToStaticMarkup(
      createElement(ActivityRail, {
        activeView: 'assistant',
        inboxCount: 0,
        taskCount: 1,
        todayCount: 1,
        onSelect: () => undefined,
      }),
    );

    const assistantButton = markup.match(/<button[^>]+aria-label="AI 助手"[^>]*>/u)?.[0] ?? '';
    expect(assistantButton).toContain('aria-current="page"');
    expect(assistantButton).toContain('is-active');
    expect(assistantButton).not.toContain('aria-pressed');
  });

  it('renders partial streamed output as inert Markdown and discloses truncated context', () => {
    const markup = renderToStaticMarkup(
      createElement(AssistantPage, {
        workspaceName: '产品',
        credential: credential(),
        credentialStatus: 'ready',
        credentialError: null,
        runtimeStatus: 'ready',
        runtimeError: null,
        runtime: runtimeSnapshot({
          phase: 'running',
          response: '部分回答：[参考](https://example.com)',
          contextSummary: {
            kind: 'today',
            label: '今日任务与日程',
            includedCount: 50,
            totalCount: 63,
            truncated: true,
          },
        }),
        operation: null,
        notes: [],
        tasks: [],
        initialContext: { kind: 'today' },
        contextGeneration: 1,
        promptMaxLength: 4_000,
        onRetry: () => undefined,
        onOpenSettings: () => undefined,
        onStart: async () => undefined,
        onCancel: async () => undefined,
        onSaveResponse: async () => undefined,
      }),
    );

    expect(markup).toContain('role="log"');
    expect(markup).toContain('正在生成');
    expect(markup).toContain('停止回答');
    expect(markup).toContain('已包含 50 / 63');
    expect(markup).toContain('已按安全上限截断');
    expect(markup).toContain('class="markdown-preview__blocked-link"');
    expect(markup).not.toContain('href=');
    expect(markup).not.toContain('markdown-preview__link');
    expect(markup).not.toContain('Escape');
  });

  it('offers an explicit note write only after a completed response', () => {
    const completed = renderToStaticMarkup(
      createElement(AssistantPage, {
        workspaceName: '产品',
        credential: credential(),
        credentialStatus: 'ready',
        credentialError: null,
        runtimeStatus: 'ready',
        runtimeError: null,
        runtime: runtimeSnapshot({ phase: 'completed', response: '# 可保存回答' }),
        operation: null,
        notes: [],
        tasks: [],
        initialContext: { kind: 'none' },
        contextGeneration: 0,
        promptMaxLength: 4_000,
        onRetry: () => undefined,
        onOpenSettings: () => undefined,
        onStart: async () => undefined,
        onCancel: async () => undefined,
        onSaveResponse: async () => undefined,
      }),
    );
    const running = renderToStaticMarkup(
      createElement(AssistantPage, {
        workspaceName: '产品',
        credential: credential(),
        credentialStatus: 'ready',
        credentialError: null,
        runtimeStatus: 'ready',
        runtimeError: null,
        runtime: runtimeSnapshot({ phase: 'running', response: '# 未完成' }),
        operation: null,
        notes: [],
        tasks: [],
        initialContext: { kind: 'none' },
        contextGeneration: 0,
        promptMaxLength: 4_000,
        onRetry: () => undefined,
        onOpenSettings: () => undefined,
        onStart: async () => undefined,
        onCancel: async () => undefined,
        onSaveResponse: async () => undefined,
      }),
    );

    expect(completed).toContain('保存为笔记');
    expect(running).not.toContain('保存为笔记');
  });

  it('states separate API billing and renders the bounded transient credential form', () => {
    const markup = renderToStaticMarkup(
      createElement(AssistantSettings, {
        credential: credential(),
        credentialStatus: 'ready',
        credentialError: null,
        credentialOperation: null,
        apiKeyMinLength: 20,
        apiKeyMaxLength: 512,
        onRetryCredential: () => undefined,
        onConfigureCredential: async () => undefined,
        onRemoveCredential: async () => undefined,
      }),
    );

    expect(markup).toContain('OpenAI API 用量单独计费，不包含在 ChatGPT 订阅中');
    expect(markup).toContain('受信任设置页临时提交');
    expect(markup).toContain('type="password"');
    expect(markup).toContain('minLength="20"');
    expect(markup).toContain('maxLength="512"');
  });

  it('distinguishes corrupt credentials from an unsafe plaintext storage backend', () => {
    const corrupt = renderToStaticMarkup(
      createElement(AssistantSettings, {
        credential: {
          ...credential(),
          configured: false,
          reason: 'credential-corrupt',
        },
        credentialStatus: 'ready',
        credentialError: null,
        credentialOperation: null,
        apiKeyMinLength: 20,
        apiKeyMaxLength: 512,
        onRetryCredential: () => undefined,
        onConfigureCredential: async () => undefined,
        onRemoveCredential: async () => undefined,
      }),
    );
    const plaintext = renderToStaticMarkup(
      createElement(AssistantSettings, {
        credential: {
          ...credential(),
          availability: 'unavailable',
          configured: false,
          removable: true,
          reason: 'plaintext-storage',
        },
        credentialStatus: 'ready',
        credentialError: null,
        credentialOperation: null,
        apiKeyMinLength: 20,
        apiKeyMaxLength: 512,
        onRetryCredential: () => undefined,
        onConfigureCredential: async () => undefined,
        onRemoveCredential: async () => undefined,
      }),
    );

    expect(corrupt).toContain('已保存的 API 密钥无法解密');
    expect(corrupt).toContain('移除');
    expect(plaintext).toContain('操作系统只提供明文凭据后端');
    expect(plaintext).toContain('拒绝降级保存密钥');
    expect(plaintext).toContain('删除本机凭据');
  });

  it('provides an explicit bounded unfinished-task selection entry point', () => {
    const snapshot: TaskSnapshot = {
      workspaceId: WORKSPACE_ID,
      todayDate: '2026-07-23',
      tasks: [
        {
          id: TASK_ID,
          title: '审查发布说明',
          status: 'todo',
          plannedFor: '2026-07-23',
          sourceInboxEntryId: null,
          createdAt: '2026-07-23T00:00:00.000Z',
          updatedAt: '2026-07-23T00:00:00.000Z',
          completedAt: null,
        },
      ],
    };
    const markup = renderToStaticMarkup(
      createElement(TaskPage, {
        snapshot,
        tasks: snapshot.tasks,
        status: 'ready',
        loadError: null,
        operationError: null,
        pendingTaskIds: new Set<string>(),
        onRetry: () => undefined,
        onOpenCreate: () => undefined,
        onOpenRename: () => undefined,
        onUpdateStatus: async () => undefined,
        onUpdatePlanning: async () => undefined,
        assistantTaskLimit: 20,
        onOpenAssistant: () => undefined,
      }),
    );

    expect(markup).toContain('选择任务询问 AI');
    expect(markup).toContain('aria-pressed="false"');
  });

  it('offers explicit Today and clean saved-note context entry points without sending', () => {
    const taskSnapshot: TaskSnapshot = {
      workspaceId: WORKSPACE_ID,
      todayDate: '2026-07-23',
      tasks: [],
    };
    const today = renderToStaticMarkup(
      createElement(TodayDashboard, {
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
          workspaceId: WORKSPACE_ID,
          todayDate: '2026-07-23',
          items: [],
        },
        scheduleItems: [],
        scheduleStatus: 'ready',
        scheduleLoadError: null,
        scheduleOperationError: null,
        pendingScheduleItemIds: new Set<string>(),
        scheduleCreatePending: false,
        onCapture: async () => undefined,
        onOpenInbox: () => undefined,
        onOpenTasks: () => undefined,
        onCreateToday: () => undefined,
        onOpenTask: () => undefined,
        onUpdateTaskStatus: async () => undefined,
        onRetrySchedule: () => undefined,
        onCreateSchedule: () => undefined,
        onOpenSchedule: () => undefined,
        onOpenAssistant: () => undefined,
      }),
    );
    const note = renderToStaticMarkup(
      createElement(NotePage, {
        workspaceName: '产品',
        notes: [
          {
            id: '44444444-4444-4444-8444-444444444444',
            title: '发布上下文',
            body: '已保存正文',
            revision: 2,
            sourceInboxEntryId: null,
            createdAt: '2026-07-23T00:00:00.000Z',
            updatedAt: '2026-07-23T00:00:00.000Z',
          },
        ],
        status: 'ready',
        loadError: null,
        operationError: null,
        pendingNoteIds: new Set<string>(),
        pendingCreate: false,
        requestedNoteId: null,
        onRequestedNoteHandled: () => undefined,
        onDirtyChange: () => undefined,
        onRetry: () => undefined,
        onCreate: async () => {
          throw new Error('not called');
        },
        onUpdate: async () => {
          throw new Error('not called');
        },
        onArchive: async () => undefined,
        onOpenLink: () => undefined,
        onOpenAssistant: () => undefined,
      }),
    );

    expect(today).toContain('询问 AI 今日安排');
    expect(note).toContain('询问 AI');
    expect(note).not.toContain('note-assistant-disabled-reason');
  });

  it('rejects late and out-of-order snapshots for the active workspace', () => {
    expect(
      shouldApplyAssistantSnapshot(WORKSPACE_ID, 7, {
        workspaceId: WORKSPACE_ID,
        sequence: 8,
      }),
    ).toBe(true);
    expect(
      shouldApplyAssistantSnapshot(WORKSPACE_ID, 8, {
        workspaceId: WORKSPACE_ID,
        sequence: 8,
      }),
    ).toBe(false);
    expect(
      shouldApplyAssistantSnapshot(WORKSPACE_ID, 8, {
        workspaceId: WORKSPACE_ID,
        sequence: 6,
      }),
    ).toBe(false);
    expect(
      shouldApplyAssistantSnapshot(WORKSPACE_ID, 8, {
        workspaceId: '33333333-3333-4333-8333-333333333333',
        sequence: 9,
      }),
    ).toBe(false);
  });

  it('hides the previous workspace response synchronously during a workspace switch', () => {
    const previous = runtimeSnapshot({
      workspaceId: WORKSPACE_ID,
      phase: 'completed',
      response: 'A 工作区的私密回答',
    });
    const nextWorkspaceId = '33333333-3333-4333-8333-333333333333';

    expect(visibleAssistantRuntime(nextWorkspaceId, previous, 'ready', '旧错误')).toEqual({
      snapshot: null,
      status: 'loading',
      error: null,
    });
    expect(visibleAssistantRuntime(WORKSPACE_ID, previous, 'ready', null)).toEqual({
      snapshot: previous,
      status: 'ready',
      error: null,
    });
  });
});

function credential() {
  return {
    availability: 'available' as const,
    configured: true,
    removable: true,
    provider: 'OpenAI' as const,
    model: 'gpt-5.6' as const,
    reason: null,
  };
}

function runtimeSnapshot(overrides: Partial<AssistantSnapshot>): AssistantSnapshot {
  const snapshot: AssistantSnapshot = {
    workspaceId: WORKSPACE_ID,
    sequence: 1,
    phase: 'idle',
    runId: null,
    prompt: '请帮我梳理下一步',
    context: { kind: 'none' },
    contextSummary: {
      kind: 'none',
      label: '仅问题',
      includedCount: 0,
      totalCount: 0,
      truncated: false,
    },
    response: '',
    startedAt: null,
    completedAt: null,
    error: null,
  };
  return Object.assign(snapshot, overrides);
}
