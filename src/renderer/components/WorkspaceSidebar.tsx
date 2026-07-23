import { useEffect, useRef, useState } from 'react';
import {
  Archive,
  CheckSquare2,
  ChevronDown,
  Clock3,
  FileText,
  Folder,
  Hash,
  MoreHorizontal,
  Pencil,
  Plus,
  Star,
} from 'lucide-react';
import type { WorkspaceInfo } from '../../shared/contracts';
import { createWorkspaceMark } from '../../shared/workspace-domain';
import type { WorkspaceSaveStatus } from '../hooks/useWorkspaceController';
import type { ViewId } from '../model';
import { IconButton } from './IconButton';

interface WorkspaceSidebarProps {
  activeView: ViewId;
  activeWorkspace: WorkspaceInfo;
  workspaces: readonly WorkspaceInfo[];
  busy: boolean;
  pendingWorkspaceId: string | null;
  saveError: string | null;
  saveStatus: WorkspaceSaveStatus;
  inboxCount: number | null;
  taskCount: number | null;
  todayCount: number | null;
  onRetrySave: () => void;
  onSelectView: (view: ViewId) => void;
  onSelectWorkspace: (workspaceId: string) => void;
  onCreateWorkspace: () => void;
  onRenameWorkspace: (workspace: WorkspaceInfo) => void;
  onArchiveWorkspace: (workspace: WorkspaceInfo) => void;
}

const sidebarLinks: Array<{
  id: ViewId;
  label: string;
  icon: typeof Clock3;
}> = [
  { id: 'today', label: '今天', icon: Clock3 },
  { id: 'inbox', label: '稍后处理', icon: Star },
  { id: 'tasks', label: '所有任务', icon: CheckSquare2 },
  { id: 'notes', label: '所有笔记', icon: FileText },
];

export function WorkspaceSidebar({
  activeView,
  activeWorkspace,
  workspaces,
  busy,
  pendingWorkspaceId,
  saveError,
  saveStatus,
  inboxCount,
  taskCount,
  todayCount,
  onRetrySave,
  onSelectView,
  onSelectWorkspace,
  onCreateWorkspace,
  onRenameWorkspace,
  onArchiveWorkspace,
}: WorkspaceSidebarProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const switcherButtonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!menuOpen) return;

    const closeMenu = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMenuOpen(false);
        window.requestAnimationFrame(() => switcherButtonRef.current?.focus());
      }
    };

    window.addEventListener('pointerdown', closeMenu);
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      window.removeEventListener('pointerdown', closeMenu);
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [menuOpen]);

  return (
    <aside className="workspace-sidebar" aria-label="工作区导航">
      <div className="workspace-switcher" ref={menuRef}>
        <button
          type="button"
          ref={switcherButtonRef}
          className="workspace-switcher__button"
          aria-expanded={menuOpen}
          aria-controls="workspace-switcher-popup"
          onClick={() => setMenuOpen((open) => !open)}
        >
          <span
            className="workspace-switcher__mark"
            style={{ backgroundColor: activeWorkspace.color }}
            aria-hidden="true"
          >
            {createWorkspaceMark(activeWorkspace.name)}
          </span>
          <span className="workspace-switcher__copy">
            <strong>{activeWorkspace.name}</strong>
            <small>本地工作区</small>
          </span>
          <ChevronDown size={15} aria-hidden="true" />
        </button>

        {menuOpen ? (
          <div
            className="workspace-menu"
            id="workspace-switcher-popup"
            role="group"
            aria-label="切换工作区"
            aria-busy={busy}
          >
            <p className="workspace-menu__label">工作区</p>
            {workspaces.map((workspace) => (
              <button
                key={workspace.id}
                type="button"
                aria-current={workspace.id === activeWorkspace.id ? 'true' : undefined}
                className={workspace.id === activeWorkspace.id ? 'is-selected' : ''}
                disabled={busy}
                onClick={() => {
                  onSelectWorkspace(workspace.id);
                  setMenuOpen(false);
                }}
              >
                <span style={{ backgroundColor: workspace.color }}>
                  {createWorkspaceMark(workspace.name)}
                </span>
                <span className="workspace-menu__name">{workspace.name}</span>
                {pendingWorkspaceId === workspace.id ? <small>切换中…</small> : null}
              </button>
            ))}
            <div className="workspace-menu__current-actions" aria-label="当前工作区操作">
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setMenuOpen(false);
                  onRenameWorkspace(activeWorkspace);
                }}
              >
                <Pencil size={13} aria-hidden="true" />
                重命名
              </button>
              <button
                type="button"
                disabled={busy || workspaces.length <= 1}
                aria-describedby={workspaces.length <= 1 ? 'archive-disabled-reason' : undefined}
                onClick={() => {
                  setMenuOpen(false);
                  onArchiveWorkspace(activeWorkspace);
                }}
              >
                <Archive size={13} aria-hidden="true" />
                归档
              </button>
            </div>
            {workspaces.length <= 1 ? (
              <p id="archive-disabled-reason" className="workspace-menu__hint">
                至少保留一个工作区
              </p>
            ) : null}
            <button
              type="button"
              className="workspace-menu__new"
              disabled={busy}
              onClick={() => {
                setMenuOpen(false);
                onCreateWorkspace();
              }}
            >
              <span>
                <Plus size={14} />
              </span>
              新建工作区
            </button>
          </div>
        ) : null}
      </div>

      <div className="sidebar-scroll">
        <div className="sidebar-section sidebar-section--compact">
          {sidebarLinks.map(({ id, label, icon: Icon }) => {
            const effectiveCount =
              id === 'inbox'
                ? inboxCount
                : id === 'tasks'
                  ? taskCount
                  : id === 'today'
                    ? todayCount
                    : null;
            return (
              <button
                type="button"
                className={`sidebar-link ${activeView === id ? 'is-active' : ''}`}
                key={label}
                onClick={() => onSelectView(id)}
                aria-current={activeView === id ? 'page' : undefined}
              >
                <Icon size={16} strokeWidth={1.8} aria-hidden="true" />
                <span>{label}</span>
                {effectiveCount ? (
                  <small>{effectiveCount > 999 ? '999+' : effectiveCount}</small>
                ) : null}
              </button>
            );
          })}
        </div>

        <div className="sidebar-section">
          <div className="sidebar-section__heading">
            <span>常用</span>
            <IconButton label="更多选项" tooltipSide="right">
              <MoreHorizontal size={15} aria-hidden="true" />
            </IconButton>
          </div>
          <button type="button" className="sidebar-link" onClick={() => onSelectView('notes')}>
            <Hash size={16} strokeWidth={1.8} aria-hidden="true" />
            <span>快速记录</span>
          </button>
          <button type="button" className="sidebar-link" onClick={() => onSelectView('notes')}>
            <Folder size={16} strokeWidth={1.8} aria-hidden="true" />
            <span>资源库</span>
          </button>
        </div>
      </div>

      <div className="sidebar-storage" aria-label="本地数据使用情况" aria-live="polite">
        <div>
          <span>SQLite 本地保存</span>
          <span>
            {saveStatus === 'saving' ? '保存中' : saveStatus === 'error' ? '需重试' : '已同步'}
          </span>
        </div>
        <p>
          <Hash size={12} aria-hidden="true" />{' '}
          {saveStatus === 'saving' ? '正在保存工作区更改…' : (saveError ?? '工作区更改已自动保存')}
        </p>
        {saveStatus === 'error' ? (
          <button type="button" className="sidebar-storage__retry" onClick={onRetrySave}>
            重试保存
          </button>
        ) : null}
      </div>
    </aside>
  );
}
