/// <reference lib="dom" />

import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  InboxUndoStack,
  inboxUndoNoticeOwnsFocus,
} from '../src/renderer/components/InboxUndoStack';
import type { InboxUndoNotice } from '../src/renderer/hooks/useInboxController';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const ENTRY_ID = '22222222-2222-4222-8222-222222222222';
const UNDO_TOKEN = '33333333-3333-4333-8333-333333333333';

describe('inbox archive notices', () => {
  it('renders a normal archive status with an exact undo and dismiss action', () => {
    const content = `${'待处理'.repeat(40)}不应泄露的尾部`;
    const current = notice({ entry: entry(content) });
    const markup = renderNotice(current);

    expect(markup).toContain('class="inbox-undo-toast"');
    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain('aria-busy="false"');
    expect(markup).toContain('已归档');
    expect(markup).toContain(`${Array.from(content).slice(0, 96).join('')}…`);
    expect(markup).not.toContain('不应泄露的尾部');
    expect(markup).toContain('aria-label="撤销归档：');
    expect(markup).toContain('aria-label="关闭归档通知：');
    expect(markup).toContain(`dateTime="${current.undoExpiresAt}"`);
    expect(markup).not.toContain('重新读取');
    expect(markup).not.toContain('role="alert"');
  });

  it('renders one committed archive alert with refresh and only an unexpired undo', () => {
    const markup = renderNotice(
      notice({
        phase: 'archive-recovery',
        focusActionOnMount: true,
      }),
    );

    expect(markup).toContain('class="inbox-undo-toast inbox-undo-toast--recovery"');
    expect(markup.match(/role="alert"/gu)).toHaveLength(1);
    expect(markup).toContain('记录已归档，但列表未同步');
    expect(markup).toContain('归档已经提交，请不要重复归档');
    expect(markup).toContain('重新读取');
    expect(markup).toContain('aria-label="撤销归档：');
    expect(markup).not.toContain('关闭归档通知');

    const expiredMarkup = renderNotice(
      notice({
        phase: 'archive-recovery',
        undoAvailable: false,
      }),
    );
    expect(expiredMarkup).toContain('本次撤销窗口已结束');
    expect(expiredMarkup).not.toContain('aria-label="撤销归档：');
    expect(expiredMarkup).not.toContain('关闭归档通知');
  });

  it('renders one committed undo alert with refresh but no repeat undo or dismiss action', () => {
    const markup = renderNotice(
      notice({
        phase: 'undo-recovery',
        undoAvailable: false,
      }),
    );

    expect(markup.match(/role="alert"/gu)).toHaveLength(1);
    expect(markup).toContain('归档已撤销，但列表未同步');
    expect(markup).toContain('撤销已经提交，请不要重复撤销');
    expect(markup).toContain('重新读取');
    expect(markup).not.toContain('aria-label="撤销归档：');
    expect(markup).not.toContain('关闭归档通知');
  });

  it('exposes real pending, blocked, refreshing, and durable error state without a nested alert', () => {
    const blockedReason = '当前数据操作完成后，才能重新读取或撤销归档。';
    const refreshError = '重新读取后仍无法确认归档结果，请稍后重试。';
    const markup = renderNotice(
      notice({
        phase: 'archive-recovery',
        refreshing: true,
        refreshError,
      }),
      {
        blocked: true,
        blockedReason,
      },
    );

    expect(markup).toContain('aria-busy="true"');
    expect(markup.match(/disabled=""/gu)).toHaveLength(2);
    expect(markup).toContain('正在读取…');
    expect(markup).toContain(blockedReason);
    expect(markup).toContain(refreshError);
    expect(markup.match(/role="alert"/gu)).toHaveLength(1);
    expect(markup).not.toMatch(/class="inbox-undo-toast__error"[^>]*role="alert"/u);

    const pendingMarkup = renderNotice(notice(), {
      pendingTokens: new Set([UNDO_TOKEN]),
    });
    expect(pendingMarkup.match(/disabled=""/gu)).toHaveLength(2);
    expect(pendingMarkup).toContain('正在处理或确认这次归档撤销，请稍候。');
    expect(pendingMarkup).toContain('撤销中…');
  });

  it('blocks every other notice while one card owns the workspace lease', () => {
    const otherToken = '44444444-4444-4444-8444-444444444444';
    const workspaceLeaseBlockedReason = '另一项收件箱归档或撤销完成后，才能处理这条通知。';
    const markup = renderToStaticMarkup(
      createElement(InboxUndoStack, {
        notices: [notice(), notice({ undoToken: otherToken })],
        pendingTokens: new Set([UNDO_TOKEN]),
        focusBlocked: false,
        blocked: false,
        blockedReason: null,
        workspaceLeasePending: true,
        workspaceLeaseBlockedReason,
        workspaceRecoveryPending: false,
        workspaceRecoveryBlockedReason: '请先完成已提交归档或撤销的重新读取，再处理其他通知。',
        onUndo: async () => undefined,
        onRefresh: async () => undefined,
        onDismiss: () => undefined,
        onFocusFallback: () => undefined,
      }),
    );

    expect(markup.match(/disabled=""/gu)).toHaveLength(4);
    expect(markup).toContain('正在处理或确认这次归档撤销，请稍候。');
    expect(markup).toContain(workspaceLeaseBlockedReason);
  });

  it('keeps only the recovery card actionable while its workspace is unresolved', () => {
    const recoveryToken = '55555555-5555-4555-8555-555555555555';
    const workspaceRecoveryBlockedReason = '请先完成已提交归档或撤销的重新读取，再处理其他通知。';
    const markup = renderToStaticMarkup(
      createElement(InboxUndoStack, {
        notices: [notice({ undoToken: recoveryToken, phase: 'archive-recovery' }), notice()],
        pendingTokens: new Set<string>(),
        focusBlocked: false,
        blocked: false,
        blockedReason: null,
        workspaceLeasePending: false,
        workspaceLeaseBlockedReason: '另一项收件箱归档或撤销完成后，才能处理这条通知。',
        workspaceRecoveryPending: true,
        workspaceRecoveryBlockedReason,
        onUndo: async () => undefined,
        onRefresh: async () => undefined,
        onDismiss: () => undefined,
        onFocusFallback: () => undefined,
      }),
    );

    expect(markup.match(/disabled=""/gu)).toHaveLength(2);
    expect(markup).toContain(workspaceRecoveryBlockedReason);
    expect(markup).toContain('重新读取');
  });

  it('keeps actions single-flight and hands off only notice-owned focus', () => {
    const source = readFileSync(
      new URL('../src/renderer/components/InboxUndoStack.tsx', import.meta.url),
      'utf8',
    );
    const body = focusElement();
    const container = focusContainer();
    const action = focusElement();
    const error = focusElement();
    const unrelated = focusElement();
    container.members.add(action);
    container.members.add(error);

    expect(inboxUndoNoticeOwnsFocus(null, body, container.element)).toBe(true);
    expect(inboxUndoNoticeOwnsFocus(body, body, container.element)).toBe(true);
    expect(inboxUndoNoticeOwnsFocus(action, body, container.element)).toBe(true);
    expect(inboxUndoNoticeOwnsFocus(error, body, container.element)).toBe(true);
    expect(inboxUndoNoticeOwnsFocus(unrelated, body, container.element)).toBe(false);

    expect(source).not.toContain('useState');
    expect(source).toContain(
      'if (blocked || pending || notice.refreshing || actionRequestedRef.current) return;',
    );
    expect(source).toContain('actionRequestedRef.current = true;');
    expect(source).toContain('await action(notice);');
    expect(source).toContain(
      'The controller owns the visible failure or post-commit recovery state.',
    );
    expect(source).toContain('actionRequestedRef.current = false;');
    expect(source).toContain("notice.undoAvailable ? 'undo' : 'expired'");
    expect(source).toContain('notice.focusActionOnMount');
    expect(source).toContain('focusBlocked ||');
    expect(source).toContain('notice.entry.id');
    expect(source).toContain('activeElement.dataset.inboxArchiveId === archiveEntryId');
    expect(source).toContain('noticeElementRef.current?.contains(document.activeElement)');
    expect(source).toContain('error.focus({ preventScroll: true });');
    expect(source).toContain(
      'window.requestAnimationFrame(() => focusFallbackRef.current(latestNoticeRef.current))',
    );
    expect(source).toContain('focusBlockedRef.current || !ownsFocus');
    expect(source).toContain('noticeOwnedFocusRef.current');
    expect(source).toContain('refreshFocusContextRef.current');
  });
});

function renderNotice(
  current: InboxUndoNotice,
  options: {
    readonly pendingTokens?: ReadonlySet<string>;
    readonly focusBlocked?: boolean;
    readonly blocked?: boolean;
    readonly blockedReason?: string | null;
  } = {},
): string {
  return renderToStaticMarkup(
    createElement(InboxUndoStack, {
      notices: [current],
      pendingTokens: options.pendingTokens ?? new Set<string>(),
      focusBlocked: options.focusBlocked ?? false,
      blocked: options.blocked ?? false,
      blockedReason: options.blockedReason ?? null,
      workspaceLeasePending: false,
      workspaceLeaseBlockedReason: '另一项收件箱归档或撤销完成后，才能处理这条通知。',
      workspaceRecoveryPending: false,
      workspaceRecoveryBlockedReason: '请先完成已提交归档或撤销的重新读取，再处理其他通知。',
      onUndo: async () => undefined,
      onRefresh: async () => undefined,
      onDismiss: () => undefined,
      onFocusFallback: () => undefined,
    }),
  );
}

function notice(overrides: Partial<InboxUndoNotice> = {}): InboxUndoNotice {
  return {
    undoToken: UNDO_TOKEN,
    workspaceId: WORKSPACE_ID,
    entry: entry('整理发布检查'),
    undoExpiresAt: '2026-07-28T12:00:15.000Z',
    expiresAtMonotonicMs: 15_000,
    phase: 'archived',
    undoAvailable: true,
    refreshing: false,
    refreshError: null,
    focusActionOnMount: false,
    ...overrides,
  };
}

function entry(content: string): InboxUndoNotice['entry'] {
  return {
    id: ENTRY_ID,
    content,
    category: 'uncategorized',
    createdAt: '2026-07-28T12:00:00.000Z',
    updatedAt: '2026-07-28T12:00:00.000Z',
  };
}

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
