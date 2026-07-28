/// <reference lib="dom" />

import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { InboxConversionSyncWarning } from '../src/renderer/components/InboxConversionSyncWarning';
import { InboxPage } from '../src/renderer/components/InboxPage';
import type { InboxConversionFeedback } from '../src/renderer/inbox-conversion-navigation';
import type { InboxEntry } from '../src/shared/contracts';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';

describe('inbox renderer components', () => {
  it('keeps a converted task in Inbox with one explicit exact-output action', () => {
    const markup = renderInbox({
      requestGeneration: 7,
      workspaceId: WORKSPACE_ID,
      sourceEntryId: '22222222-2222-4222-8222-222222222222',
      outputKind: 'task',
      outputId: '33333333-3333-4333-8333-333333333333',
      outputTitle: '检查发布包',
    });

    expect(markup).toContain('已转为任务');
    expect(markup).toContain('检查发布包');
    expect(markup).toContain('打开任务');
    expect(markup).toContain('aria-label="已转为任务“检查发布包”；打开任务"');
    expect(markup).toContain('aria-label="关闭转换成功提示"');
    expect(markup.match(/已转为任务/gu)).toHaveLength(2);
    expect(markup).not.toContain('role="status"');
  });

  it('offers the same explicit action for a converted note without an automatic link', () => {
    const markup = renderInbox({
      requestGeneration: 8,
      workspaceId: WORKSPACE_ID,
      sourceEntryId: '44444444-4444-4444-8444-444444444444',
      outputKind: 'note',
      outputId: '55555555-5555-4555-8555-555555555555',
      outputTitle: '每周回顾',
    });

    expect(markup).toContain('已转为笔记');
    expect(markup).toContain('打开笔记');
    expect(markup).toContain('aria-label="已转为笔记“每周回顾”；打开笔记"');
    expect(markup).not.toContain('href=');
  });

  it('does not render a stale conversion action when there is no current feedback', () => {
    const markup = renderInbox(null);

    expect(markup).not.toContain('inbox-conversion-feedback');
    expect(markup).not.toContain('打开任务');
    expect(markup).not.toContain('打开笔记');
  });

  it.each([
    ['task', '任务', '检查发布包'],
    ['note', '笔记', '每周回顾'],
  ] as const)(
    'renders a bounded committed %s conversion warning with explicit recovery',
    (outputKind, outputLabel, outputTitle) => {
      const title = `${outputTitle}${'记'.repeat(100)}不应泄露的尾部`;
      const summary = `${Array.from(title).slice(0, 96).join('')}…`;
      const message = '转换已提交，但当前收件箱与目标列表未能同步。';
      const markup = renderToStaticMarkup(
        createElement(InboxConversionSyncWarning, {
          outputKind,
          outputTitle: title,
          message,
          focusActionOnMount: outputKind === 'task',
          focusBlocked: false,
          onRefresh: async () => undefined,
        }),
      );

      expect(markup).toContain('class="inbox-conversion-feedback inbox-conversion-sync-warning"');
      expect(markup).toContain('role="alert"');
      expect(markup).toContain('aria-atomic="true"');
      expect(markup).toContain('aria-busy="false"');
      expect(markup).toContain(`记录已转为${outputLabel}，但列表未同步`);
      expect(markup).toContain(summary);
      expect(markup).not.toContain('不应泄露的尾部');
      expect(markup).toContain(message);
      expect(markup).toContain('记录已经转换，请不要重复操作');
      expect(markup).toContain('>重新读取</button>');
      expect(markup).toContain(
        `aria-label="重新读取收件箱和${outputLabel}列表并确认：“${summary}”"`,
      );
      expect(markup).not.toContain('打开任务');
      expect(markup).not.toContain('打开笔记');
      expect(markup).not.toContain('autofocus');
    },
  );

  it('keeps conversion recovery single-flight with bounded focus-aware failures', () => {
    const source = readFileSync(
      new URL('../src/renderer/components/InboxConversionSyncWarning.tsx', import.meta.url),
      'utf8',
    );

    expect(source).toContain('const refreshingRef = useRef(false);');
    expect(source).toContain('if (refreshingRef.current) return;');
    expect(source).toContain('refreshingRef.current = true;');
    expect(source).toContain('await onRefresh();');
    expect(source).toContain('refreshingRef.current = false;');
    expect(source).toContain(
      'document.activeElement === null || document.activeElement === document.body',
    );
    expect(source).toContain('if (!focusActionOnMount && !focusWasLost) return;');
    expect(source).toContain('action?.focus({ preventScroll: true });');
    expect(source).toContain('if (refreshError === null || focusBlocked) return;');
    expect(source).toContain('errorRef.current?.focus({ preventScroll: true })');
    expect(source).not.toContain('error.message');
    expect(source).toContain('记录已经转换，请不要重复操作。');
    expect(source).not.toMatch(
      /className="inbox-conversion-navigation-error inbox-conversion-sync-warning__error"\s+role="alert"/u,
    );
  });

  it('disables every conversion action while one workspace conversion is reconciling', () => {
    const markup = renderInbox(null, {
      entries: [
        entry('22222222-2222-4222-8222-222222222222', '第一条'),
        entry('33333333-3333-4333-8333-333333333333', '第二条'),
      ],
      conversionMutationPending: true,
    });

    expect(
      markup.match(
        /class="inbox-entry__convert(?: inbox-entry__convert--note)?"[^>]*disabled=""/gu,
      ),
    ).toHaveLength(4);
    expect(markup.match(/class="inbox-entry__archive"/gu)).toHaveLength(2);
    expect(markup).not.toMatch(/class="inbox-entry__archive"[^>]*disabled=""/u);
  });

  it('disables recovery-blocked entries without pretending every entry is busy', () => {
    const blockedReason = '上一项收件箱归档或撤销仍在确认，请先重新读取完成对账。';
    const markup = renderInbox(null, {
      entries: [entry('22222222-2222-4222-8222-222222222222', '待确认记录')],
      inboxMutationBlocked: true,
      inboxMutationBlockedReason: blockedReason,
    });

    expect(markup.match(/disabled=""/gu)).toHaveLength(4);
    expect(markup).toContain(blockedReason);
    expect(markup).not.toContain('is-spinning');
    expect(markup).toContain('lucide-archive');
  });

  it('restores the failed note action and clears dialog-owned task errors before closing', () => {
    const pageSource = readFileSync(
      new URL('../src/renderer/components/InboxPage.tsx', import.meta.url),
      'utf8',
    );
    const appSource = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');

    expect(pageSource).toContain('noteConversionButtonRefs.current.get(entry.id)');
    expect(pageSource).toContain('action.focus({ preventScroll: true })');
    expect(pageSource).toContain('entryRefs.current.get(entry.id)?.focus({ preventScroll: true })');
    expect(appSource).toContain("if (taskDialog?.mode === 'convert')");
    expect(appSource).toContain('inboxConversionPublicationGate.take(');
    expect(appSource).toContain('publishInboxConversionPublication(publication);');
    expect(appSource).toContain('onClose={closeTaskDialog}');
  });

  it('gates same-kind and cross-kind conversion failures before publishing or refocusing', () => {
    const appSource = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const taskControllerSource = readFileSync(
      new URL('../src/renderer/hooks/useTaskController.ts', import.meta.url),
      'utf8',
    );
    const noteControllerSource = readFileSync(
      new URL('../src/renderer/hooks/useNoteController.ts', import.meta.url),
      'utf8',
    );

    expect(appSource.match(/const failureIsCurrent =/gu)).toHaveLength(2);
    expect(appSource.match(/if \(!failureIsCurrent\(\) \|\|/gu)).toHaveLength(2);
    expect(
      (appSource.match(/taskController\.clearOperationError\(\);/gu) ?? []).length,
    ).toBeGreaterThanOrEqual(2);
    expect(
      (appSource.match(/noteController\.clearOperationError\(\);/gu) ?? []).length,
    ).toBeGreaterThanOrEqual(2);
    expect(
      (appSource.match(/inboxController\.clearOperationError\(\);/gu) ?? []).length,
    ).toBeGreaterThanOrEqual(2);
    expect(taskControllerSource).toContain('shouldPublishFailure');
    expect(taskControllerSource).toContain('shouldPublishFailure,');
    expect(noteControllerSource).toContain('shouldPublishFailure');
    expect(noteControllerSource).toContain('shouldPublishFailure,');
  });

  it('defers success focus while a modal is open and restores failed dialog focus', () => {
    const appSource = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const pageSource = readFileSync(
      new URL('../src/renderer/components/InboxPage.tsx', import.meta.url),
      'utf8',
    );
    const dialogSource = readFileSync(
      new URL('../src/renderer/components/TaskDialog.tsx', import.meta.url),
      'utf8',
    );

    expect(appSource).toContain('conversionFeedbackFocusBlocked={overlayOpen}');
    expect(appSource).toContain('focusedConversionFeedbackKey={focusedInboxConversionFeedbackKey}');
    expect(pageSource).toContain('conversionFeedbackKey === null');
    expect(pageSource).toContain('conversionFeedbackFocusBlocked');
    expect(pageSource).toContain('focusedConversionFeedbackKey === conversionFeedbackKey');
    expect(pageSource).toContain('onConversionFeedbackFocused(conversionFeedbackKey)');
    expect(pageSource).toContain('focusedConversionErrorKeyRef.current');
    expect(pageSource).toContain('conversionNavigationErrorKey');
    expect(dialogSource).toContain('submitFocusReturnRef.current');
    expect(dialogSource).toContain("!returnTarget.matches(':disabled')");
    expect(dialogSource).toContain('returnTarget.focus({ preventScroll: true })');
    expect(dialogSource).toContain('errorRef.current?.focus({ preventScroll: true })');
  });
});

function renderInbox(
  conversionFeedback: InboxConversionFeedback | null,
  options: {
    readonly entries?: readonly InboxEntry[];
    readonly conversionMutationPending?: boolean;
    readonly inboxMutationBlocked?: boolean;
    readonly inboxMutationBlockedReason?: string | null;
  } = {},
): string {
  return renderToStaticMarkup(
    createElement(InboxPage, {
      entries: options.entries ?? [],
      status: 'ready',
      loadError: null,
      operationError: null,
      conversionFeedback,
      conversionFeedbackFocusBlocked: false,
      focusedConversionFeedbackKey: null,
      pendingEntryIds: new Set<string>(),
      pendingConversionEntryIds: new Set<string>(),
      pendingNoteConversionEntryIds: new Set<string>(),
      conversionMutationPending: options.conversionMutationPending ?? false,
      inboxMutationBlocked: options.inboxMutationBlocked ?? false,
      inboxMutationBlockedReason: options.inboxMutationBlockedReason ?? null,
      onRetry: () => undefined,
      onOpenCapture: () => undefined,
      onCategorize: async () => undefined,
      onArchive: async () => undefined,
      onDismissConversionFeedback: () => undefined,
      onOpenConversionOutput: async () => undefined,
      onConversionFeedbackFocused: () => undefined,
      onOpenConvert: () => undefined,
      onConvertNote: async () => undefined,
    }),
  );
}

function entry(id: string, content: string): InboxEntry {
  return {
    id,
    content,
    category: 'uncategorized',
    createdAt: '2026-07-27T12:00:00.000Z',
    updatedAt: '2026-07-27T12:00:00.000Z',
  };
}
