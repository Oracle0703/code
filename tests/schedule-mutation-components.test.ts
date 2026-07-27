/// <reference lib="dom" />

import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  ScheduleMutationSyncWarning,
  scheduleMutationSyncWarningOwnsFocus,
} from '../src/renderer/components/ScheduleMutationSyncWarning';
import { scheduleCreateTitleSummary } from '../src/renderer/schedule-create-navigation';

describe('schedule mutation renderer components', () => {
  it.each([
    {
      kind: 'update' as const,
      heading: '日程已保存，但列表未同步',
      actionLabel: '重新读取日程列表并确认已保存',
      duplicateAction: '请勿重复保存',
    },
    {
      kind: 'archive' as const,
      heading: '日程已归档，但列表未同步',
      actionLabel: '重新读取日程列表并确认已归档',
      duplicateAction: '请勿重复归档',
    },
  ])(
    'renders one visible $kind alert with a frozen identity and one recovery action',
    ({ kind, heading, actionLabel, duplicateAction }) => {
      const title = `${'📆'.repeat(100)}不应泄露的尾部`;
      const summary = scheduleCreateTitleSummary(title);
      const message = `请重新读取并确认日程列表；日程已经${kind === 'update' ? '保存' : '归档'}，${duplicateAction}。`;
      const markup = renderToStaticMarkup(
        createElement(ScheduleMutationSyncWarning, {
          kind,
          title,
          scheduledFor: '2026-07-27',
          startMinute: 540,
          endMinute: 630,
          message,
          focusActionOnMount: false,
          focusBlocked: false,
          refreshing: false,
          refreshError: null,
          onRefresh: () => undefined,
          onFocusFallback: () => undefined,
        }),
      );

      expect(markup).toContain(
        'class="task-create-toast task-create-sync-warning schedule-mutation-sync-warning"',
      );
      expect(markup.match(/role="alert"/gu)).toHaveLength(1);
      expect(markup).toContain('aria-atomic="true"');
      expect(markup).toContain('aria-busy="false"');
      expect(markup).toContain(heading);
      expect(markup).toContain(summary);
      expect(markup).not.toContain('不应泄露的尾部');
      expect(markup).toContain('dateTime="2026-07-27"');
      expect(markup).toContain('09:00–10:30');
      expect(markup).toContain(message);
      expect(markup).toContain(duplicateAction);
      expect(markup).toContain(`aria-label="${actionLabel}：“${summary}”"`);
      expect(markup.match(/<button/gu)).toHaveLength(1);
      expect(markup).toContain('重新读取');
      expect(markup).not.toContain('再次保存');
      expect(markup).not.toContain('再次归档');
      expect(markup).not.toContain('关闭');
    },
  );

  it('renders parent-owned busy, blocked, and durable error state without another alert', () => {
    const refreshError = '重新读取后仍无法确认已保存的日程。';
    const markup = renderToStaticMarkup(
      createElement(ScheduleMutationSyncWarning, {
        kind: 'update',
        title: '深度工作',
        scheduledFor: '2026-07-27',
        startMinute: 540,
        endMinute: 630,
        message: '请重新读取并确认日程列表；日程已经保存，请勿重复保存。',
        focusActionOnMount: true,
        focusBlocked: false,
        blocked: true,
        blockedReason: '当前数据操作完成后，才能重新读取日程列表。',
        refreshing: true,
        refreshError,
        onRefresh: () => undefined,
        onFocusFallback: () => undefined,
      }),
    );

    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain('disabled=""');
    expect(markup).toContain('正在读取…');
    expect(markup).toContain('当前数据操作完成后，才能重新读取日程列表。');
    expect(markup).toContain(refreshError);
    expect(markup).toContain(
      'aria-describedby="schedule-update-sync-warning-message schedule-update-sync-warning-blocked-reason schedule-update-sync-warning-error"',
    );
    expect(markup.match(/role="alert"/gu)).toHaveLength(1);
  });

  it('keeps recovery single-flight and hands off only warning-owned focus', () => {
    const source = readFileSync(
      new URL('../src/renderer/components/ScheduleMutationSyncWarning.tsx', import.meta.url),
      'utf8',
    );
    const body = focusElement();
    const warning = focusContainer();
    const action = focusElement() as HTMLButtonElement;
    const error = focusElement();
    const unrelated = focusElement();
    warning.members.add(action);
    warning.members.add(error);

    expect(scheduleMutationSyncWarningOwnsFocus(null, body, warning.element, action)).toBe(true);
    expect(scheduleMutationSyncWarningOwnsFocus(body, body, warning.element, action)).toBe(true);
    expect(scheduleMutationSyncWarningOwnsFocus(action, body, warning.element, action)).toBe(true);
    expect(scheduleMutationSyncWarningOwnsFocus(error, body, warning.element, action)).toBe(true);
    expect(scheduleMutationSyncWarningOwnsFocus(unrelated, body, warning.element, action)).toBe(
      false,
    );
    expect(source).not.toContain('useState');
    expect(source).toContain('if (blocked || refreshing || refreshRequestedRef.current) return;');
    expect(source).toContain('refreshRequestedRef.current = true;');
    expect(source).toContain('await onRefresh();');
    expect(source).toContain('refreshRequestedRef.current = false;');
    expect(source).toContain('previousRefreshError !== null || refreshError === null');
    expect(source).toContain('focusBlocked ||');
    expect(source).toContain('error.focus({ preventScroll: true });');
    expect(source).toContain('window.requestAnimationFrame(onFocusFallback)');
    expect(source).toContain('focusBlockedRef.current ||');
    expect(source).toContain('warningOwnedFocusRef.current');
    expect(source).toContain('refreshFocusContextRef.current');
    expect(source.match(/role="alert"/gu)).toHaveLength(1);
  });
});

function focusElement(): HTMLElement {
  return {} as HTMLElement;
}

function focusContainer(): {
  readonly element: HTMLElement;
  readonly members: Set<Element>;
} {
  const members = new Set<Element>();
  return {
    element: {
      contains(value: Node | null): boolean {
        return value !== null && members.has(value as Element);
      },
    } as HTMLElement,
    members,
  };
}
