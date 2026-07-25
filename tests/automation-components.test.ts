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
    expect(markup).toContain('正在立即运行自动化');
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
