/// <reference lib="dom" />

import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { NoteMutationSyncWarning } from '../src/renderer/components/NoteMutationSyncWarning';
import { NotePage } from '../src/renderer/components/NotePage';
import {
  createNoteArchiveMutationIntent,
  createNoteUpdateMutationIntent,
  type NoteMutationSyncWarningTarget,
} from '../src/renderer/note-state';
import type { Note } from '../src/shared/contracts';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const NOTE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('note mutation renderer components', () => {
  it.each([
    {
      kind: 'update' as const,
      heading: '笔记已保存，但列表未同步',
      actionLabel: '重新读取笔记列表并确认已保存',
    },
    {
      kind: 'archive' as const,
      heading: '笔记已归档，但列表未同步',
      actionLabel: '重新读取笔记列表并确认已归档',
    },
  ])(
    'renders one visible $kind alert with read-only recovery',
    ({ kind, heading, actionLabel }) => {
      const title = `${'📝'.repeat(100)}不应泄露的尾部`;
      const summary = `${'📝'.repeat(96)}…`;
      const message = '写入已经完成，但当前笔记列表未能确认该结果。';
      const markup = renderToStaticMarkup(
        createElement(NoteMutationSyncWarning, {
          kind,
          title,
          message,
          focusActionOnMount: false,
          refreshing: false,
          refreshError: null,
          onRefresh: async () => undefined,
        }),
      );

      expect(markup).toContain(
        'class="task-create-toast task-create-sync-warning note-create-sync-warning note-page__sync-warning"',
      );
      expect(markup.match(/role="alert"/gu)).toHaveLength(1);
      expect(markup).toContain('aria-atomic="true"');
      expect(markup).toContain('aria-busy="false"');
      expect(markup).toContain(heading);
      expect(markup).toContain(message);
      expect(markup).toContain(summary);
      expect(markup).not.toContain('不应泄露的尾部');
      expect(markup).toContain(`aria-label="${actionLabel}：“${summary}”"`);
      expect(markup.match(/<button/gu)).toHaveLength(1);
      expect(markup).toContain('重新读取');
      expect(markup).not.toContain('重试保存');
      expect(markup).not.toContain('重试归档');
      expect(markup).not.toContain('再次保存');
      expect(markup).not.toContain('再次归档');
      expect(markup).not.toContain('class="sr-only"');
    },
  );

  it('renders parent-owned busy and error state without adding another live region', () => {
    const message = '写入已经完成，但当前笔记列表未能确认该结果。';
    const refreshError = '重新读取后仍无法确认已保存的笔记。';
    const markup = renderToStaticMarkup(
      createElement(NoteMutationSyncWarning, {
        kind: 'update',
        title: '每周回顾',
        message,
        focusActionOnMount: false,
        refreshing: true,
        refreshError,
        onRefresh: async () => undefined,
      }),
    );

    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain('disabled=""');
    expect(markup).toContain('正在读取…');
    expect(markup).toContain(refreshError);
    expect(markup).toContain(
      'aria-describedby="note-update-sync-warning-message note-update-sync-warning-error"',
    );
    expect(markup.match(/role="alert"/gu)).toHaveLength(1);
  });

  it('keeps a local click gate while busy and error remain parent-owned', () => {
    const source = readFileSync(
      new URL('../src/renderer/components/NoteMutationSyncWarning.tsx', import.meta.url),
      'utf8',
    );

    expect(source).not.toContain('useState');
    expect(source).not.toContain('setRefreshing');
    expect(source).not.toContain('setRefreshError');
    expect(source).toContain('const refreshRequestedRef = useRef(false);');
    expect(source).toContain('if (refreshing || refreshRequestedRef.current) return;');
    expect(source).toContain('refreshRequestedRef.current = true;');
    expect(source).toContain('refreshRequestedRef.current = false;');
    expect(source).toContain('const refresh = async (): Promise<void> => {');
    expect(source).toContain('await onRefresh();');
    expect(source).toContain('finally {');
    expect(source).toContain('const previousRefreshError = previousRefreshErrorRef.current;');
    expect(source).toContain('if (previousRefreshError !== null || refreshError === null) return;');
    expect(source).toContain('const focusOwner = document.activeElement;');
    expect(source).toContain('refreshFocusOwnerRef.current = document.activeElement;');
    expect(source).toContain('active === null || active === document.body');
    expect(source).toContain('active === focusOwner || active === action');
    expect(source).toContain('action.focus({ preventScroll: true });');
    expect(source).toContain('error.focus({ preventScroll: true });');
    expect(source).toContain('tabIndex={-1}');
    expect(source.match(/role="alert"/gu)).toHaveLength(1);
  });

  it.each([
    {
      kind: 'update' as const,
      warning: updateWarning(),
      notes: [originalNote()],
      expectedTitle: '已经提交的新标题',
      expectedBody: '已经提交的新正文',
      status: '已保存 · 等待同步',
    },
    {
      kind: 'archive' as const,
      warning: archiveWarning(),
      notes: [],
      expectedTitle: '原始标题',
      expectedBody: '原始正文',
      status: '已归档 · 等待同步',
    },
  ])(
    'reconstructs a read-only committed $kind result after the Notes surface remounts',
    ({ warning, notes, expectedTitle, expectedBody, status }) => {
      const markup = renderToStaticMarkup(
        createElement(NotePage, {
          workspaceName: '产品',
          notes,
          status: 'ready',
          loadError: null,
          operationError: null,
          pendingNoteIds: new Set<string>(),
          pendingCreate: false,
          pendingMutation: false,
          requestedNoteId: warning.intent.originalNote.id,
          onRequestedNoteHandled: () => undefined,
          onDirtyChange: () => undefined,
          onRetry: () => undefined,
          onCreate: async () => {
            throw new Error('not used');
          },
          createSyncWarning: null,
          onCreateSyncWarning: () => undefined,
          onCreateSyncResolved: () => undefined,
          onRefreshCreated: async () => null,
          mutationSyncWarning: warning,
          mutationSyncWarningRefreshing: false,
          mutationSyncWarningError: null,
          focusMutationSyncWarningActionOnMount: false,
          onMutationSyncWarning: () => undefined,
          onRefreshMutation: async () => {
            throw new Error('not used');
          },
          onUpdate: async () => {
            throw new Error('not used');
          },
          onArchive: async () => {
            throw new Error('not used');
          },
          onOpenLink: () => undefined,
          onOpenAssistant: () => undefined,
        }),
      );

      expect(markup).toContain(`value="${expectedTitle}"`);
      expect(markup).toContain(expectedBody);
      expect(markup).toContain(status);
      expect(markup.match(/readOnly=""/gu)).toHaveLength(2);
      expect(markup).not.toContain('>未保存<');
      expect(markup).not.toContain('要打开的笔记已不可用');
      expect(markup.match(/role="alert"/gu)).toHaveLength(1);
      expect(markup).not.toContain('role="status"');
    },
  );

  it('keeps a mounted Notes editor read-only while an external note warning is unresolved', () => {
    const markup = renderToStaticMarkup(
      createElement(NotePage, {
        workspaceName: '产品',
        notes: [originalNote()],
        status: 'ready',
        loadError: null,
        operationError: null,
        pendingNoteIds: new Set<string>(),
        pendingCreate: false,
        pendingMutation: true,
        pendingMutationMessage: '请返回自动化重新读取运行输出',
        requestedNoteId: NOTE_ID,
        onRequestedNoteHandled: () => undefined,
        onDirtyChange: () => undefined,
        onRetry: () => undefined,
        onCreate: async () => {
          throw new Error('not used');
        },
        createSyncWarning: null,
        onCreateSyncWarning: () => undefined,
        onCreateSyncResolved: () => undefined,
        onRefreshCreated: async () => null,
        mutationSyncWarning: null,
        mutationSyncWarningRefreshing: false,
        mutationSyncWarningError: null,
        focusMutationSyncWarningActionOnMount: false,
        onMutationSyncWarning: () => undefined,
        onRefreshMutation: async () => {
          throw new Error('not used');
        },
        onUpdate: async () => {
          throw new Error('not used');
        },
        onArchive: async () => {
          throw new Error('not used');
        },
        onOpenLink: () => undefined,
        onOpenAssistant: () => undefined,
      }),
    );

    expect(markup).toContain('请返回自动化重新读取运行输出');
    expect(markup.match(/readOnly=""/gu)).toHaveLength(2);
    expect(markup).toContain('disabled=""');
  });

  it('keeps publication, navigation gates, and replacement invalidation above NotePage', () => {
    const appSource = rendererSource('App.tsx');
    const pageSource = componentSource('NotePage.tsx');
    const searchSource = appSource.slice(
      appSource.indexOf('const selectSearchResult = useCallback('),
      appSource.indexOf('const commands = useMemo<PaletteCommand[]>'),
    );

    expect(appSource).toContain('noteMutationSyncWarningState');
    expect(appSource).toContain('noteMutationSyncWarningRef.current = publication;');
    expect(appSource).toContain("noteMutationCoordinator.begin(activation, 'update')");
    expect(appSource).toContain("noteMutationCoordinator.begin(activation, 'archive')");
    expect(appSource).toContain("'inbox-note-convert'");
    expect(appSource).toContain('onCreate={createNote}');
    expect(appSource).not.toContain('onCreate={noteController.create}');
    expect(appSource).toContain('noteMutationCoordinator.isPending(snapshot.currentWorkspaceId)');
    expect(appSource).toContain('noteWriteIsBlocked(noteCreateActivation)');
    expect(appSource).toContain('noteWorkspaceChangeIsBlocked()');
    expect(searchSource.indexOf('noteWorkspaceChangeIsBlocked()')).toBeLessThan(
      searchSource.indexOf('workspaceController.activate(result.workspaceId)'),
    );
    expect(appSource).toContain('assertNoteOutputNavigationAvailable(feedback.workspaceId)');
    expect(appSource).toContain("inboxWarning.feedback.outputKind === 'note'");
    expect(appSource).toContain("automationPublication.feedback.outputKind === 'note'");
    expect(appSource).toContain("noteMutationCoordinator.begin(noteActivation, 'recover')");
    expect(appSource).toContain('invalidateNoteMutations();');
    expect(searchSource.indexOf('isNoteMutationNavigationBlocked(')).toBeLessThan(
      searchSource.indexOf('confirmLeaveNoteDraft()'),
    );
    expect(pageSource).toContain('if (!commit.committed || !commit.confirmed)');
    expect(pageSource).toContain('commit.updatedNote.id === commit.intent.originalNote.id');
    expect(pageSource).toContain('mutationRecoveryPendingRef.current = true;');
    expect(pageSource.match(/readOnly=\{noteNavigationLocked\}/gu)).toHaveLength(2);
    expect(pageSource).toContain(
      "createRecoveryPending || mutationRecoveryPending ? undefined : 'status'",
    );
  });

  it('keeps Main failures retryable while returning post-commit reconciliation failures', () => {
    const controllerSource = rendererHookSource('useNoteController.ts');
    const updateSource = controllerSource.slice(
      controllerSource.indexOf('const update = useCallback('),
      controllerSource.indexOf('const archive = useCallback('),
    );
    const archiveSource = controllerSource.slice(
      controllerSource.indexOf('const archive = useCallback('),
      controllerSource.indexOf('const recoverNoteMutation = useCallback('),
    );

    for (const source of [updateSource, archiveSource]) {
      expect(source).toContain('try {');
      expect(source).toContain('throw operationFailure(');
      expect(source).toContain('committed: reconciliation.committed');
      expect(source).toContain('reconciliation.committed');
      expect(source.indexOf('await window.workbench.note.')).toBeLessThan(
        source.indexOf('await reconcileNote'),
      );
    }
  });
});

function originalNote(): Note {
  return {
    id: NOTE_ID,
    title: '原始标题',
    body: '原始正文',
    revision: 3,
    sourceInboxEntryId: null,
    createdAt: '2026-07-27T12:00:00.000Z',
    updatedAt: '2026-07-27T12:00:00.000Z',
  };
}

function updateWarning(): NoteMutationSyncWarningTarget {
  const intent = createNoteUpdateMutationIntent(
    WORKSPACE_ID,
    originalNote(),
    '已经提交的新标题',
    '已经提交的新正文',
  );
  return {
    kind: 'update',
    intent,
    resultSnapshot: { workspaceId: WORKSPACE_ID, notes: [] },
    title: intent.title,
    message: '笔记已保存，但列表未同步。',
  };
}

function archiveWarning(): NoteMutationSyncWarningTarget {
  const intent = createNoteArchiveMutationIntent(WORKSPACE_ID, originalNote());
  return {
    kind: 'archive',
    intent,
    resultSnapshot: { workspaceId: WORKSPACE_ID, notes: [] },
    title: intent.originalNote.title,
    message: '笔记已归档，但列表未同步。',
  };
}

function componentSource(fileName: string): string {
  return readFileSync(new URL(`../src/renderer/components/${fileName}`, import.meta.url), 'utf8');
}

function rendererSource(fileName: string): string {
  return readFileSync(new URL(`../src/renderer/${fileName}`, import.meta.url), 'utf8');
}

function rendererHookSource(fileName: string): string {
  return readFileSync(new URL(`../src/renderer/hooks/${fileName}`, import.meta.url), 'utf8');
}
