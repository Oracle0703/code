/// <reference lib="dom" />

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AutomationItem } from '../src/shared/contracts';
import { AutomationDialog } from '../src/renderer/components/AutomationDialog';
import { AutomationPage } from '../src/renderer/components/AutomationPage';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';

describe('automation renderer components', () => {
  it('renders runtime-only semantics and an accessible enable switch', () => {
    const markup = renderToStaticMarkup(
      createElement(AutomationPage, {
        items: [automationItem()],
        status: 'ready',
        loadError: null,
        operationError: null,
        pendingItemIds: new Set<string>(),
        pendingCreate: false,
        onRetry: () => undefined,
        onOpenCreate: () => undefined,
        onOpenEdit: () => undefined,
        onSetEnabled: () => undefined,
      }),
    );

    expect(markup).toContain('仅在 Daily Workbench 运行时执行');
    expect(markup).toContain('每条规则最多补执行最近一次错过的计划');
    expect(markup).toContain('role="switch"');
    expect(markup).toContain('aria-checked="true"');
    expect(markup).toContain('aria-label="停用自动化“服务器巡检”"');
    expect(markup).toContain('每周五 17:30');
    expect(markup).toContain('创建今日任务：检查备份');
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
