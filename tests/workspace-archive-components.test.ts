/// <reference lib="dom" />

import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ArchivedWorkspaceInfo, WorkspaceInfo } from '../src/shared/contracts';
import { ArchivedWorkspacesDialog } from '../src/renderer/components/ArchivedWorkspacesDialog';
import { WorkspaceDialog } from '../src/renderer/components/WorkspaceDialog';
import { WorkspaceSidebar } from '../src/renderer/components/WorkspaceSidebar';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';

describe('workspace archive renderer surfaces', () => {
  it('renders editable restore names and discloses non-restored runtime state', () => {
    const markup = renderDialog({ status: 'ready', workspaces: [archivedWorkspace()] });

    expect(markup).toContain('<dialog');
    expect(markup).toContain('aria-labelledby="archived-workspaces-dialog-title"');
    expect(markup).toContain('aria-describedby="archived-workspaces-dialog-description"');
    expect(markup).toContain('恢复后的名称');
    expect(markup).toContain('value="已归档产品"');
    expect(markup).toContain('maxLength="80"');
    expect(markup).toContain('自动化不会自动启用');
    expect(markup).toContain('已取消的专注会话不会恢复');
    expect(markup).toContain('不会自动切换当前工作区');
    expect(markup).toContain('dateTime="2026-07-23T08:30:00.000Z"');
  });

  it('locks every dismissal and edit control while a restore is pending', () => {
    const markup = renderDialog({
      status: 'ready',
      workspaces: [archivedWorkspace()],
      pendingWorkspaceId: WORKSPACE_ID,
    });
    const source = readFileSync(
      new URL('../src/renderer/components/ArchivedWorkspacesDialog.tsx', import.meta.url),
      'utf8',
    );

    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain('恢复中…');
    expect(markup.match(/disabled=""/gu)?.length).toBeGreaterThanOrEqual(4);
    expect(source).toContain('if (busy) event.preventDefault()');
    expect(source).toContain('if (!busy) onClose()');
  });

  it('provides accessible loading, retry, and empty states', () => {
    const loading = renderDialog({ status: 'loading' });
    const failed = renderDialog({
      status: 'error',
      loadError: '归档读取失败',
    });
    const empty = renderDialog({ status: 'ready' });

    expect(loading).toContain('role="status"');
    expect(loading).toContain('正在读取归档工作区');
    expect(failed).toContain('role="alert"');
    expect(failed).toContain('归档读取失败');
    expect(failed).toContain('重新加载');
    expect(empty).toContain('暂无归档工作区');
  });

  it('offers archive management from the switcher and the command center', () => {
    const active = activeWorkspace();
    const sidebar = renderToStaticMarkup(
      createElement(WorkspaceSidebar, {
        activeView: 'today',
        activeWorkspace: active,
        workspaces: [active],
        busy: false,
        pendingWorkspaceId: null,
        saveError: null,
        saveStatus: 'saved',
        inboxCount: 0,
        taskCount: 0,
        todayCount: 0,
        onRetrySave: () => undefined,
        onSelectView: () => undefined,
        onSelectWorkspace: () => undefined,
        onCreateWorkspace: () => undefined,
        onRenameWorkspace: () => undefined,
        onArchiveWorkspace: () => undefined,
        onManageArchivedWorkspaces: () => undefined,
      }),
    );
    const appSource = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');

    const sidebarSource = readFileSync(
      new URL('../src/renderer/components/WorkspaceSidebar.tsx', import.meta.url),
      'utf8',
    );
    expect(sidebar).toContain('aria-controls="workspace-switcher-popup"');
    expect(sidebarSource).toContain('管理归档工作区');
    expect(sidebarSource).toContain('onManageArchivedWorkspaces()');
    expect(appSource).toContain("id: 'workspace:archives'");
    expect(appSource).toContain('action: workspaceController.openArchiveManager');
  });

  it('updates archive confirmation copy with the recovery path and irreversible runtime effects', () => {
    const markup = renderToStaticMarkup(
      createElement(WorkspaceDialog, {
        state: {
          mode: 'archive',
          workspace: activeWorkspace(),
          switchesWorkspace: true,
        },
        onClose: () => undefined,
        onCreate: async () => undefined,
        onRename: async () => undefined,
        onArchive: async () => undefined,
      }),
    );

    expect(markup).toContain('管理归档工作区');
    expect(markup).toContain('自动化会被停用');
    expect(markup).toContain('专注会话会被取消');
    expect(markup).toContain('不会自动启用或复活');
  });
});

function renderDialog({
  status,
  workspaces = [],
  loadError = null,
  pendingWorkspaceId = null,
}: {
  status: 'idle' | 'loading' | 'ready' | 'error';
  workspaces?: readonly ArchivedWorkspaceInfo[];
  loadError?: string | null;
  pendingWorkspaceId?: string | null;
}): string {
  return renderToStaticMarkup(
    createElement(ArchivedWorkspacesDialog, {
      status,
      workspaces,
      loadError,
      pendingWorkspaceId,
      onClose: () => undefined,
      onRetry: () => undefined,
      onRestore: async () => undefined,
    }),
  );
}

function activeWorkspace(): WorkspaceInfo {
  return {
    id: WORKSPACE_ID,
    name: '产品',
    color: '#7b6ee8',
    createdAt: '2026-07-20T08:00:00.000Z',
    updatedAt: '2026-07-22T08:00:00.000Z',
  };
}

function archivedWorkspace(): ArchivedWorkspaceInfo {
  return {
    ...activeWorkspace(),
    name: '已归档产品',
    archivedAt: '2026-07-23T08:30:00.000Z',
    updatedAt: '2026-07-23T08:30:00.000Z',
    revision: 3,
  };
}
