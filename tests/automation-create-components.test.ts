/// <reference lib="dom" />

import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AutomationCreateSyncWarning } from '../src/renderer/components/AutomationCreateSyncWarning';
import { AutomationCreateToast } from '../src/renderer/components/AutomationCreateToast';
import {
  automationCreateNameSummary,
  type AutomationCreateFeedback,
} from '../src/renderer/automation-create-navigation';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const AUTOMATION_ID = '22222222-2222-4222-8222-222222222222';

describe('automation create renderer components', () => {
  it('renders one bounded polite receipt with explicit open and close actions', () => {
    const name = `  第一行\t第二行\n${'😀'.repeat(100)}不应泄露的尾部  `;
    const summary = automationCreateNameSummary(name);
    const markup = renderAutomationToast({ ...feedback(), name });

    expect(Array.from(summary)).toHaveLength(96);
    expect(summary).toMatch(/^第一行 第二行 /u);
    expect(summary).toMatch(/…$/u);
    expect(summary).not.toContain('不应泄露的尾部');
    expect(markup).toContain(summary);
    expect(markup).not.toContain('不应泄露的尾部');
    expect(markup.match(/已创建自动化/gu)).toHaveLength(2);
    expect(markup.match(/默认停用/gu)).toHaveLength(2);
    expect(markup).toContain('aria-busy="false"');
    expect(markup.match(/role="status"/gu)).toHaveLength(1);
    expect(markup.match(/aria-live="polite"/gu)).toHaveLength(1);
    expect(markup).toContain('aria-atomic="true"');
    expect(markup).toContain('打开自动化');
    expect(markup).toContain('aria-label="打开刚创建的自动化"');
    expect(markup).toContain(`aria-label="关闭新建自动化成功提示：“${summary}”"`);
    expect(markup).toContain('type="button"');
    expect(markup).not.toContain('href=');
    expect(markup).not.toContain('role="alert"');
  });

  it('keeps the receipt truthful if a future caller returns an enabled item', () => {
    const markup = renderAutomationToast({ ...feedback(), enabled: true });

    expect(markup.match(/当前已启用/gu)).toHaveLength(2);
    expect(markup).not.toContain('默认停用');
  });

  it('renders the post-commit synchronization warning as an independent bounded alert', () => {
    const name = `${'自'.repeat(100)}不应泄露的尾部`;
    const summary = automationCreateNameSummary(name);
    const message = '自动化已创建，但当前列表未能同步。请刷新后查看，避免重复创建。';
    const markup = renderToStaticMarkup(
      createElement(AutomationCreateSyncWarning, {
        name,
        enabled: false,
        message,
        onRefresh: async () => undefined,
        onDismiss: () => undefined,
      }),
    );

    expect(markup).toContain(
      'class="task-create-toast task-create-sync-warning automation-create-sync-warning"',
    );
    expect(markup.match(/role="alert"/gu)).toHaveLength(1);
    expect(markup).toContain('aria-atomic="true"');
    expect(markup).not.toContain(
      'class="task-create-toast task-create-sync-warning automation-create-sync-warning" role="alert"',
    );
    expect(markup).toContain(summary);
    expect(markup).not.toContain('不应泄露的尾部');
    expect(markup).toContain(message);
    expect(markup).toContain('自动化已创建，但列表未同步');
    expect(markup).toContain('默认停用');
    expect(markup).toContain('重新读取');
    expect(markup).toContain(`aria-label="重新读取自动化列表并确认：“${summary}”"`);
    expect(markup).toContain(`aria-label="关闭自动化同步警告：“${summary}”"`);
    expect(markup).not.toContain('打开自动化');
  });

  it('wires authoritative warning recovery and moves focus before removing the open receipt', () => {
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const openStart = source.indexOf('const openCreatedAutomation');
    const focusIndex = source.indexOf('focusAutomationActivityRailAnchor();', openStart);
    const dismissIndex = source.indexOf('automationCreateCoordinator.dismiss(', openStart);

    expect(source).toContain('.activity-rail button[aria-label="自动化"]');
    expect(focusIndex).toBeGreaterThan(openStart);
    expect(dismissIndex).toBeGreaterThan(focusIndex);
    expect(source).toContain('const refreshAutomationCreateSyncWarning');
    expect(source).toContain('automationController.prepareSnapshotRefresh()');
    expect(source).toContain('id === warning.createdAutomationId');
    expect(source).toContain('automationCreateCoordinator.createRecoveredFeedback(');
    expect(source).toContain('throw automationCreateSyncRefreshError(error)');
    expect(source).toContain('const invalidateAutomationCreate');
    expect(source).toContain('setAutomationCreateSyncWarningState(null)');

    const refreshStart = source.indexOf('const refreshAutomationCreateSyncWarning');
    const awaitIndex = source.indexOf(
      'await automationController.prepareSnapshotRefresh()',
      refreshStart,
    );
    const postAwaitGenerationCheck = source.indexOf(
      '!automationCreateCoordinator.isGenerationCurrent(',
      awaitIndex,
    );
    const commitIndex = source.indexOf('refresh.commit()', awaitIndex);
    expect(postAwaitGenerationCheck).toBeGreaterThan(awaitIndex);
    expect(commitIndex).toBeGreaterThan(postAwaitGenerationCheck);
  });
});

function feedback(): AutomationCreateFeedback {
  return {
    requestGeneration: 4,
    workspaceId: WORKSPACE_ID,
    createdAutomationId: AUTOMATION_ID,
    name: '每日整理提醒',
    enabled: false,
  };
}

function automationToast(value: AutomationCreateFeedback) {
  return createElement(AutomationCreateToast, {
    feedback: value,
    focusBlocked: false,
    onOpen: async () => undefined,
    onDismiss: () => true,
    onFocusFallback: () => undefined,
  });
}

function renderAutomationToast(value: AutomationCreateFeedback): string {
  return renderToStaticMarkup(automationToast(value));
}
