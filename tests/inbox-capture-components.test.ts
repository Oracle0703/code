/// <reference lib="dom" />

import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { InboxCaptureSyncWarning } from '../src/renderer/components/InboxCaptureSyncWarning';
import { InboxCaptureToast } from '../src/renderer/components/InboxCaptureToast';
import {
  inboxCaptureContentSummary,
  type InboxCaptureFeedback,
} from '../src/renderer/inbox-capture-navigation';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const ENTRY_ID = '22222222-2222-4222-8222-222222222222';

describe('inbox capture renderer components', () => {
  it('renders one bounded polite success status with only an explicit open action', () => {
    const content = `  第一行\t第二行\n${'😀'.repeat(100)}不应泄露的尾部  `;
    const summary = inboxCaptureContentSummary(content);
    const markup = renderToast({ ...feedback(), content });

    expect(Array.from(summary)).toHaveLength(96);
    expect(summary).toMatch(/^第一行 第二行 /u);
    expect(summary).toMatch(/…$/u);
    expect(summary).not.toContain('不应泄露的尾部');
    expect(markup).toContain(summary);
    expect(markup).not.toContain('不应泄露的尾部');
    expect(markup.match(/role="status"/gu)).toHaveLength(1);
    expect(markup.match(/aria-live="polite"/gu)).toHaveLength(1);
    expect(markup).toContain('aria-atomic="true"');
    expect(markup).toContain('打开记录');
    expect(markup).toContain('aria-label="打开刚加入收件箱的记录"');
    expect(markup.match(/已加入收件箱/gu)).toHaveLength(2);
    expect(markup).toContain('type="button"');
    expect(markup).not.toContain('href=');
    expect(markup).not.toContain('role="alert"');
  });

  it('renders a bounded post-commit synchronization warning as an independent alert', () => {
    const content = `${'记'.repeat(100)}不应泄露的尾部`;
    const summary = inboxCaptureContentSummary(content);
    const message = '记录已创建，但当前收件箱未能同步。请重新读取，避免重复添加。';
    const markup = renderToStaticMarkup(
      createElement(InboxCaptureSyncWarning, {
        content,
        message,
        focusActionOnMount: true,
        focusBlocked: false,
        onRefresh: async () => undefined,
        onDismiss: () => undefined,
      }),
    );

    expect(markup).toContain(
      'class="inbox-capture-toast task-create-sync-warning inbox-capture-sync-warning"',
    );
    expect(markup).toContain('aria-busy="false"');
    expect(markup.match(/role="alert"/gu)).toHaveLength(1);
    expect(markup).toContain('aria-atomic="true"');
    expect(markup).not.toContain(
      'class="inbox-capture-toast task-create-sync-warning inbox-capture-sync-warning" role="alert"',
    );
    expect(markup).toContain(summary);
    expect(markup).not.toContain('不应泄露的尾部');
    expect(markup).toContain(message);
    expect(markup).toContain('记录已创建，但收件箱未同步');
    expect(markup).toContain('重新读取');
    expect(markup).toContain(`aria-label="重新读取收件箱并确认：“${summary}”"`);
    expect(markup).toContain(`aria-label="关闭快速记录同步警告：“${summary}”"`);
    expect(markup).not.toContain('打开记录');
  });

  it('keeps warning refresh single-flight and focuses an inline alert after failure', () => {
    const source = componentSource('InboxCaptureSyncWarning.tsx');

    expect(source).toContain('const refreshingRef = useRef(false);');
    expect(source).toContain(
      'if (!focusActionOnMount || focusBlocked || actionFocusedRef.current)',
    );
    expect(source).toContain('action?.focus({ preventScroll: true });');
    expect(source).toContain('if (refreshError === null || focusBlocked) return;');
    expect(source).toContain('if (refreshingRef.current) return;');
    expect(source).toContain('refreshingRef.current = true;');
    expect(source).toContain('await onRefresh();');
    expect(source).toContain('refreshingRef.current = false;');
    expect(source).toContain('errorRef.current?.focus({ preventScroll: true })');
    expect(source).toMatch(
      /className="inbox-capture-toast__error inbox-capture-sync-warning__error"\s+role="alert"\s+tabIndex=\{-1\}/u,
    );
    expect(source.match(/disabled=\{refreshing\}/gu)).toHaveLength(2);
  });

  it('keeps opening user-triggered and single-flight without an automatic navigation effect', () => {
    const source = componentSource('InboxCaptureToast.tsx');
    const appSource = rendererSource('App.tsx');
    const createSource = sourceBetween(
      appSource,
      'const createInboxCapture = useCallback(',
      'const openInboxCapture = useCallback(',
    );
    const openSource = sourceBetween(
      appSource,
      'const openInboxCapture = useCallback(',
      'const dismissInboxCapture = useCallback(',
    );

    expect(source.match(/await onOpen\(feedback\)/gu)).toHaveLength(1);
    expect(source).toContain('onClick={() => void openCapture()}');
    expect(source).toContain('if (!openGate.begin(feedback)) return;');
    expect(source).toContain('openGate.end(feedback);');
    expect(source).toContain('setOpenState(inboxCaptureOpenStarted(feedback))');
    expect(createSource).not.toContain('updatePreferences(');
    expect(createSource).not.toContain('setInboxReveal(');
    expect(openSource).toContain("updatePreferences({ activeView: 'inbox' }");
    expect(openSource).toContain('entryId: target.entry.id');
  });

  it('defers failed-open focus around overlays and exposes one focus-owned error', () => {
    const source = componentSource('InboxCaptureToast.tsx');

    expect(source).toContain('error instanceof InboxCaptureSupersededError');
    expect(source).toContain('errorFocusKey === null');
    expect(source).toContain('focusBlocked');
    expect(source).toContain('focusedErrorKeyRef.current === errorFocusKey');
    expect(source).toContain('window.requestAnimationFrame(() =>');
    expect(source).toContain('error?.focus({ preventScroll: true })');
    expect(source).toContain('focusedErrorKeyRef.current = errorFocusKey');
    expect(source).toMatch(
      /<p ref=\{errorRef\} className="inbox-capture-toast__error" tabIndex=\{-1\}>/u,
    );
    expect(source).not.toContain(
      '<p ref={errorRef} className="inbox-capture-toast__error" role="alert"',
    );
  });

  it('dismisses before restoring the connected enabled control that owned focus', () => {
    const source = componentSource('InboxCaptureToast.tsx');

    expect(source).toContain('const returnTarget = returnFocusRef.current;');
    expect(source).toMatch(
      /const returnTarget = returnFocusRef\.current;\s+if \(!onDismiss\(feedback\)\) return;\s+window\.requestAnimationFrame/u,
    );
    expect(source).toContain('returnTarget?.isConnected');
    expect(source).toContain('!returnTarget.matches(\':disabled, [aria-disabled="true"]\')');
    expect(source).toContain('returnTarget.focus({ preventScroll: true })');
    expect(source).toContain('if (document.activeElement === returnTarget) return;');
    expect(source).toContain('onFocusFallback();');
  });

  it('removes the old Today-owned success announcement while preserving capture errors', () => {
    const source = componentSource('TodayDashboard.tsx');

    expect(source).not.toContain('recentCapture');
    expect(source).not.toContain('“{recentCapture}” 已加入收件箱');
    expect(source).toMatch(/await onCapture\(title\);\s+setCapture\(''\);/u);
    expect(source).toContain('capture-confirmation is-error');
    expect(source).toContain('role="alert"');
  });

  it('keeps capture failures with their visible owner and invalidates cross-workspace state', () => {
    const appSource = rendererSource('App.tsx');
    const controllerSource = rendererSource('hooks/useInboxController.ts');
    const createSource = sourceBetween(
      appSource,
      'const createInboxCapture = useCallback(',
      'const openInboxCapture = useCallback(',
    );

    expect(createSource).toContain("errorOwner: 'dialog' | 'today' = 'dialog'");
    expect(createSource).toContain("errorOwner === 'today'");
    expect(createSource).toContain('inboxCaptureSurfaceGenerationRef.current !==');
    expect(appSource).toContain("(statusbarErrorSource === 'inbox' && activeSurface === 'inbox')");
    expect(controllerSource).toContain('shouldPublishFailure() &&');
    expect(appSource).toMatch(
      /const invalidateInboxCapture = useCallback\(\(\): void => \{[\s\S]*?inboxCaptureCoordinator\.invalidate\(\);[\s\S]*?setInboxCaptureSyncWarningState\(null\);/u,
    );
    expect(appSource).toMatch(
      /const requestWorkspaceActivation = useCallback\(\s+\(workspaceId: string\) => \{\s+if \(workspaceId === currentWorkspaceIdRef\.current\) return;[\s\S]*?invalidateInboxCapture\(\);/u,
    );
  });

  it('separates post-commit reconciliation warnings from retryable create failures', () => {
    const appSource = rendererSource('App.tsx');
    const createSource = sourceBetween(
      appSource,
      'const createInboxCapture = useCallback(',
      'const openInboxCapture = useCallback(',
    );
    const refreshSource = sourceBetween(
      appSource,
      'const refreshInboxCaptureSyncWarning = useCallback(',
      'const createManualTask = useCallback(',
    );

    expect(createSource).toContain('!commit.committed || commit.createdEntry === null');
    expect(createSource).toContain('createdEntryId: commit.result.createdEntryId');
    expect(createSource).toContain("focusActionOnMount: errorOwner === 'dialog'");
    expect(createSource).toContain('commit.reconciliationWarning ??');
    expect(createSource).toMatch(
      /if \(errorOwner === 'dialog'\) \{\s+inboxCapturePublicationGate\.stage/u,
    );
    expect(createSource).toContain('publishInboxCapturePublication(publication);');
    expect(appSource).toMatch(
      /const closeQuickCaptureDialog = useCallback\([\s\S]*?setQuickCaptureTarget\(null\);[\s\S]*?inboxCapturePublicationGate\.take/u,
    );
    expect(appSource).toContain('onClose={closeQuickCaptureDialog}');
    expect(refreshSource).toContain('resolveInboxCaptureSyncRefreshEntry(');
    expect(refreshSource).toContain('createRecoveredFeedback(');
    expect(refreshSource).toContain('!inboxCaptureCoordinator.isSyncRefreshCurrent(');
    expect(appSource).toContain('<InboxCaptureSyncWarning');
  });

  it('returns focus inside Quick Capture after a failed submit', () => {
    const source = componentSource('QuickCaptureDialog.tsx');

    expect(source).toContain('const errorRef = useRef<HTMLParagraphElement>(null);');
    expect(source).toContain('const submitFocusReturnRef = useRef<HTMLElement | null>(null);');
    expect(source).toContain('const activeElement = document.activeElement;');
    expect(source).toContain('dialogRef.current?.contains(activeElement)');
    expect(source).toContain('returnTarget.focus({ preventScroll: true })');
    expect(source).toContain('errorRef.current?.focus({ preventScroll: true })');
    expect(source).toMatch(
      /<p\s+className="quick-capture-dialog__error"\s+ref=\{errorRef\}\s+role="alert"\s+tabIndex=\{-1\}>/u,
    );
  });
});

function feedback(): InboxCaptureFeedback {
  return {
    requestGeneration: 4,
    workspaceId: WORKSPACE_ID,
    createdEntryId: ENTRY_ID,
    content: '检查发布包',
    category: 'task',
  };
}

function renderToast(value: InboxCaptureFeedback): string {
  return renderToStaticMarkup(
    createElement(InboxCaptureToast, {
      feedback: value,
      focusBlocked: false,
      onOpen: async () => undefined,
      onDismiss: () => true,
      onFocusFallback: () => undefined,
    }),
  );
}

function componentSource(fileName: string): string {
  return rendererSource(`components/${fileName}`);
}

function rendererSource(fileName: string): string {
  return readFileSync(new URL(`../src/renderer/${fileName}`, import.meta.url), 'utf8');
}

function sourceBetween(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);

  if (startIndex < 0 || endIndex < 0) {
    throw new Error(`Expected source boundaries: ${start} ... ${end}`);
  }
  return source.slice(startIndex, endIndex);
}
