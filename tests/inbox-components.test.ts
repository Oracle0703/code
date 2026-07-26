/// <reference lib="dom" />

import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { InboxPage } from '../src/renderer/components/InboxPage';
import type { InboxConversionFeedback } from '../src/renderer/inbox-conversion-navigation';

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

  it('restores the failed note action and clears dialog-owned task errors before closing', () => {
    const pageSource = readFileSync(
      new URL('../src/renderer/components/InboxPage.tsx', import.meta.url),
      'utf8',
    );
    const appSource = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');

    expect(pageSource).toContain('noteConversionButtonRefs.current.get(entry.id)');
    expect(pageSource).toContain('action.focus({ preventScroll: true })');
    expect(pageSource).toContain('entryRefs.current.get(entry.id)?.focus({ preventScroll: true })');
    expect(appSource).toMatch(
      /onClose=\{\(\) => \{\s+if \(taskDialog\.mode === 'convert'\) taskController\.clearOperationError\(\);\s+setTaskDialog\(null\);/u,
    );
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

function renderInbox(conversionFeedback: InboxConversionFeedback | null): string {
  return renderToStaticMarkup(
    createElement(InboxPage, {
      entries: [],
      status: 'ready',
      loadError: null,
      operationError: null,
      conversionFeedback,
      conversionFeedbackFocusBlocked: false,
      focusedConversionFeedbackKey: null,
      pendingEntryIds: new Set<string>(),
      pendingConversionEntryIds: new Set<string>(),
      pendingNoteConversionEntryIds: new Set<string>(),
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
