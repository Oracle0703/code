/// <reference lib="dom" />

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AutomationItem } from '../src/shared/contracts';
import { AutomationDialog } from '../src/renderer/components/AutomationDialog';
import { AutomationPage } from '../src/renderer/components/AutomationPage';
import { NotePage } from '../src/renderer/components/NotePage';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';

describe('automation renderer components', () => {
  it('renders runtime-only semantics and an accessible enable switch', () => {
    const markup = renderToStaticMarkup(
      createElement(AutomationPage, {
        items: [
          automationItem(),
          {
            ...automationItem(),
            id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            name: '停用的巡检',
            enabled: false,
          },
        ],
        status: 'ready',
        loadError: null,
        operationError: null,
        runFeedback: null,
        pendingItemIds: new Set<string>(),
        runningItemIds: new Set<string>(),
        pendingCreate: false,
        onRetry: () => undefined,
        onOpenCreate: () => undefined,
        onOpenEdit: () => undefined,
        onSetEnabled: () => undefined,
        onRunNow: () => undefined,
        onOpenRunOutput: () => undefined,
      }),
    );

    expect(markup).toContain('仅在 Daily Workbench 运行时执行');
    expect(markup).toContain('每条规则最多补执行最近一次错过的计划');
    expect(markup).toContain('role="switch"');
    expect(markup).toContain('aria-checked="true"');
    expect(markup).toContain('aria-label="停用自动化“服务器巡检”"');
    expect(markup).toContain('aria-label="启用自动化“停用的巡检”"');
    expect(markup).toContain('aria-label="立即运行自动化“服务器巡检”"');
    expect(markup).toContain('aria-label="立即运行自动化“停用的巡检”"');
    expect(markup).toContain('每周五 17:30');
    expect(markup).toContain('创建今日任务：检查备份');
    expect(markup).toContain('尚无计划运行记录');
  });

  it('disables run, edit, and enable controls while an item is running and announces success', () => {
    const item = automationItem();
    const markup = renderToStaticMarkup(
      createElement(AutomationPage, {
        items: [item],
        status: 'ready',
        loadError: null,
        operationError: null,
        runFeedback: {
          workspaceId: WORKSPACE_ID,
          automationId: item.id,
          outputKind: 'task',
          outputId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          outputTitle: '检查备份',
          message: '已立即创建今日任务：检查备份',
        },
        pendingItemIds: new Set([item.id]),
        runningItemIds: new Set([item.id]),
        pendingCreate: false,
        onRetry: () => undefined,
        onOpenCreate: () => undefined,
        onOpenEdit: () => undefined,
        onSetEnabled: () => undefined,
        onRunNow: () => undefined,
        onOpenRunOutput: () => undefined,
      }),
    );

    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain('aria-label="正在立即运行自动化“服务器巡检”"');
    const runningButton = findButton(markup, '正在立即运行自动化“服务器巡检”');
    const enableSwitch = findButton(markup, '停用自动化“服务器巡检”');
    const editButton = findButton(markup, '编辑自动化“服务器巡检”');
    expect(runningButton).toContain('disabled=""');
    expect(enableSwitch).toContain('disabled=""');
    expect(editButton).toContain('disabled=""');
    expect(markup).toContain('运行中…');
    expect(markup).toContain('role="status"');
    expect(markup).toContain('已立即创建今日任务：检查备份');
    expect(markup).toContain('打开任务');
    expect(markup).toContain('aria-label="打开任务：刚创建的任务“检查备份”"');
    expect(markup).toContain('可以打开刚创建的任务');
  });

  it('shows an unavailable state instead of falling back when a requested note disappeared', () => {
    const markup = renderToStaticMarkup(
      createElement(NotePage, {
        workspaceName: '个人',
        notes: [
          {
            id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
            title: '其他笔记',
            body: '# 其他内容',
            revision: 1,
            sourceInboxEntryId: null,
            createdAt: '2026-07-25T12:00:00.000Z',
            updatedAt: '2026-07-25T12:00:00.000Z',
          },
        ],
        status: 'ready',
        loadError: null,
        operationError: null,
        pendingNoteIds: new Set<string>(),
        pendingCreate: false,
        requestedNoteId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        onRequestedNoteHandled: () => undefined,
        onDirtyChange: () => undefined,
        onRetry: () => undefined,
        onCreate: async () => {
          throw new Error('not used');
        },
        onUpdate: async () => {
          throw new Error('not used');
        },
        onArchive: async () => undefined,
        onOpenLink: () => undefined,
        onOpenAssistant: () => undefined,
      }),
    );

    expect(markup).toContain('要打开的笔记已不可用');
    expect(markup).toContain('没有打开其他笔记');
    expect(markup).toContain('返回笔记列表');
    expect(markup).not.toContain('value="其他笔记"');
  });

  it('offers an explicit note output action without navigating automatically', () => {
    const item = {
      ...automationItem(),
      action: { kind: 'create-note' as const, title: '每周回顾', body: '# 本周' },
    };
    const markup = renderToStaticMarkup(
      createElement(AutomationPage, {
        items: [item],
        status: 'ready',
        loadError: null,
        operationError: null,
        runFeedback: {
          workspaceId: WORKSPACE_ID,
          automationId: item.id,
          outputKind: 'note',
          outputId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
          outputTitle: '每周回顾',
          message: '已立即创建笔记：每周回顾',
        },
        pendingItemIds: new Set<string>(),
        runningItemIds: new Set<string>(),
        pendingCreate: false,
        onRetry: () => undefined,
        onOpenCreate: () => undefined,
        onOpenEdit: () => undefined,
        onSetEnabled: () => undefined,
        onRunNow: () => undefined,
        onOpenRunOutput: () => undefined,
      }),
    );

    expect(markup).toContain('打开笔记');
    expect(markup).toContain('aria-label="打开笔记：刚创建的笔记“每周回顾”"');
    expect(markup).toContain('可以打开刚创建的笔记');
  });

  it('makes the create default-disabled behavior explicit and groups schedule and action fields', () => {
    const markup = renderToStaticMarkup(
      createElement(AutomationDialog, {
        state: {
          mode: 'create',
          workspaceId: WORKSPACE_ID,
          workspaceName: '个人',
        },
        onClose: () => undefined,
        onCreate: async () => undefined,
        onUpdate: async () => undefined,
        onArchive: async () => undefined,
      }),
    );

    expect(markup).toContain('<dialog');
    expect(markup).toContain('aria-labelledby="automation-dialog-title"');
    expect(markup).toContain('aria-describedby="automation-dialog-description"');
    expect(markup.match(/<fieldset>/gu)).toHaveLength(2);
    expect(markup).toContain('新规则创建后默认停用，请在列表中确认并启用');
    expect(markup).toContain('应用关闭期间不会运行');
  });

  it('freezes the action kind while editing but keeps its content editable', () => {
    const markup = renderToStaticMarkup(
      createElement(AutomationDialog, {
        state: {
          mode: 'edit',
          workspaceId: WORKSPACE_ID,
          workspaceName: '个人',
          item: automationItem(),
        },
        onClose: () => undefined,
        onCreate: async () => undefined,
        onUpdate: async () => undefined,
        onArchive: async () => undefined,
      }),
    );

    const actionChoices = markup.match(/<input[^>]+name="automation-action"[^>]*>/gu) ?? [];
    expect(actionChoices).toHaveLength(2);
    expect(actionChoices.every((choice) => choice.includes('disabled=""'))).toBe(true);
    expect(markup).toContain('动作类型创建后不可更改；仍可编辑本动作的内容');
    expect(markup).toContain('value="检查备份"');
    expect(markup).toContain('归档自动化');
  });
});

function automationItem(): AutomationItem {
  return {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    name: '服务器巡检',
    enabled: true,
    schedule: { cadence: 'weekly', localTimeMinute: 1_050, weekday: 5 },
    action: { kind: 'create-today-task', title: '检查备份' },
    revision: 2,
    nextRunAt: '2026-07-24T17:30:00.000Z',
    lastRun: { status: 'never' },
    createdAt: '2026-07-22T00:00:00.000Z',
    updatedAt: '2026-07-23T00:00:00.000Z',
  };
}

function findButton(markup: string, ariaLabel: string): string {
  const buttons = markup.match(/<button\b[^>]*>/gu) ?? [];
  const button = buttons.find((candidate) => candidate.includes(`aria-label="${ariaLabel}"`));
  expect(button).toBeDefined();
  return button ?? '';
}
