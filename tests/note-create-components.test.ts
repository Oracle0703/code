/// <reference lib="dom" />

import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { NoteCreateSyncWarning } from '../src/renderer/components/NoteCreateSyncWarning';
import { NotePage } from '../src/renderer/components/NotePage';

describe('note create renderer components', () => {
  it('renders a bounded post-commit synchronization warning with explicit recovery', () => {
    const title = `${'笔'.repeat(100)}不应泄露的尾部`;
    const summary = `${'笔'.repeat(96)}…`;
    const message = '笔记已创建，但当前笔记列表未能同步。请重新读取后查看，避免重复创建。';
    const markup = renderToStaticMarkup(
      createElement(NoteCreateSyncWarning, {
        title,
        message,
        focusActionOnMount: false,
        onRefresh: async () => undefined,
      }),
    );

    expect(markup).toContain(
      'class="task-create-toast task-create-sync-warning note-create-sync-warning note-page__sync-warning"',
    );
    expect(markup).toContain('aria-busy="false"');
    expect(markup.match(/role="alert"/gu)).toHaveLength(1);
    expect(markup).toContain('aria-atomic="true"');
    expect(markup).toContain(summary);
    expect(markup).not.toContain('不应泄露的尾部');
    expect(markup).toContain(message);
    expect(markup).toContain('笔记已创建，但列表未同步');
    expect(markup).toContain('重新读取');
    expect(markup).toContain(`aria-label="重新读取笔记列表并确认：“${summary}”"`);
    expect(markup).not.toContain('再次保存');
  });

  it('keeps refresh and save single-flight while preserving exact-ID recovery', () => {
    const warningSource = componentSource('NoteCreateSyncWarning.tsx');
    const pageSource = componentSource('NotePage.tsx');

    expect(warningSource).toContain('const refreshingRef = useRef(false);');
    expect(warningSource).toContain('if (refreshingRef.current) return;');
    expect(warningSource).toContain('refreshingRef.current = true;');
    expect(warningSource).toContain('await onRefresh();');
    expect(warningSource).toContain('refreshingRef.current = false;');
    expect(warningSource).toContain('action?.focus({ preventScroll: true });');
    expect(warningSource).toContain('errorRef.current?.focus({ preventScroll: true })');

    expect(pageSource).toContain('const saveInFlightRef = useRef(false);');
    expect(pageSource).toContain('saveInFlightRef.current ||');
    expect(pageSource).toContain('commit.createdNote.id === commit.result.createdNoteId');
    expect(pageSource).toContain('createdNote.id !== warning.result.createdNoteId');
    expect(pageSource).toContain('onCreateSyncWarning({');
    expect(pageSource).toContain('body: editor.body');
    expect(pageSource).toContain('saveStartedFromButton &&');
    expect(pageSource).toContain('document.activeElement === saveButtonRef.current');
    expect(pageSource).toContain('document.activeElement === document.body');
    expect(pageSource.match(/readOnly=\{createNavigationLocked\}/gu)).toHaveLength(2);
    expect(pageSource).toContain('const unsavedDirty = dirty && !createRecoveryPending;');
    expect(pageSource).toContain(
      'disabled={!dirty || editorLocked || titleInvalid || bodyInvalid}',
    );
  });

  it('reconstructs a committed unsynchronized draft from controlled state after remount', () => {
    const title = '已落库的笔记';
    const body = '这段正文不能在离开 Notes 后丢失。';
    const message = '笔记已创建，但当前笔记列表未能同步。请重新读取后查看，避免重复创建。';
    const markup = renderToStaticMarkup(
      createElement(NotePage, {
        workspaceName: '产品',
        notes: [],
        status: 'ready',
        loadError: null,
        operationError: null,
        pendingNoteIds: new Set<string>(),
        pendingCreate: false,
        requestedNoteId: null,
        onRequestedNoteHandled: () => undefined,
        onDirtyChange: () => undefined,
        onRetry: () => undefined,
        onCreate: async () => {
          throw new Error('not used');
        },
        createSyncWarning: {
          result: {
            noteSnapshot: { workspaceId: 'workspace-a', notes: [] },
            createdNoteId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          },
          title,
          body,
          message,
        },
        onCreateSyncWarning: () => undefined,
        onCreateSyncResolved: () => undefined,
        onRefreshCreated: async () => null,
        onUpdate: async () => {
          throw new Error('not used');
        },
        onArchive: async () => undefined,
        onOpenLink: () => undefined,
        onOpenAssistant: () => undefined,
      }),
    );

    expect(markup).toContain(`value="${title}"`);
    expect(markup).toContain(body);
    expect(markup).toContain('已创建 · 等待同步');
    expect(markup.match(/readOnly=""/gu)).toHaveLength(2);
    expect(markup).not.toContain('>未保存<');
  });

  it('locks an existing-note editor while an earlier create survives a page remount', () => {
    const markup = renderToStaticMarkup(
      createElement(NotePage, {
        workspaceName: '产品',
        notes: [
          {
            id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            title: '已有笔记',
            body: '不能被迟到的创建回执覆盖。',
            revision: 3,
            sourceInboxEntryId: null,
            createdAt: '2026-07-27T12:00:00.000Z',
            updatedAt: '2026-07-27T12:00:00.000Z',
          },
        ],
        status: 'ready',
        loadError: null,
        operationError: null,
        pendingNoteIds: new Set<string>(),
        pendingCreate: true,
        requestedNoteId: null,
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
        onUpdate: async () => {
          throw new Error('not used');
        },
        onArchive: async () => undefined,
        onOpenLink: () => undefined,
        onOpenAssistant: () => undefined,
      }),
    );

    expect(markup).toContain('value="已有笔记"');
    expect(markup).toContain('正在确认新笔记…');
    expect(markup.match(/readOnly=""/gu)).toHaveLength(2);
    expect(markup).toContain('>创建中…</button>');
  });

  it('does not fall back to the first note for a missing explicit selection', () => {
    const pageSource = componentSource('NotePage.tsx');

    expect(pageSource).toContain("selection?.kind === 'note'");
    expect(pageSource).toContain('? selectedNote');
    expect(pageSource).toContain('requestedNoteUnavailable || selectedNoteUnavailable');
    expect(pageSource).not.toContain(
      "selectedNote ?? (selection?.kind === 'new' ? null : (notes[0] ?? null))",
    );
  });

  it('owns unresolved create state above the remounting Notes surface', () => {
    const appSource = rendererSource('App.tsx');
    const pageSource = componentSource('NotePage.tsx');
    const searchNavigationSource = appSource.slice(
      appSource.indexOf('const selectSearchResult = useCallback('),
      appSource.indexOf('const commands = useMemo<PaletteCommand[]>'),
    );

    expect(appSource).toContain('noteCreateSyncWarningState');
    expect(appSource).toContain('pageGeneration: notePageGeneration');
    expect(appSource).toContain('createSyncWarning={visibleNoteCreateSyncWarning}');
    expect(appSource).toContain('onCreateSyncWarning={publishNoteCreateSyncWarning}');
    expect(appSource).toContain('onCreateSyncResolved={resolveNoteCreateSyncWarning}');
    expect(pageSource).toContain('createSyncWarning: NoteCreateSyncWarningTarget | null');
    expect(pageSource).not.toContain('setCreateSyncWarning');
    expect(searchNavigationSource.indexOf('isNoteCreateNavigationBlocked(')).toBeLessThan(
      searchNavigationSource.indexOf('confirmLeaveNoteDraft()'),
    );
  });
});

function componentSource(fileName: string): string {
  return readFileSync(new URL(`../src/renderer/components/${fileName}`, import.meta.url), 'utf8');
}

function rendererSource(fileName: string): string {
  return readFileSync(new URL(`../src/renderer/${fileName}`, import.meta.url), 'utf8');
}
