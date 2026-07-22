import { useEffect, useRef, useState } from 'react';
import {
  ChevronDown,
  Clock3,
  FileText,
  Folder,
  Hash,
  MoreHorizontal,
  Plus,
  Star,
  Users,
} from 'lucide-react';
import type { ViewId, Workspace } from '../model';
import { IconButton } from './IconButton';

interface WorkspaceSidebarProps {
  activeView: ViewId;
  workspaceId: string;
  workspaces: Workspace[];
  onSelectView: (view: ViewId) => void;
  onSelectWorkspace: (workspaceId: string) => void;
}

const sidebarLinks: Array<{
  id: ViewId;
  label: string;
  icon: typeof Clock3;
  count?: number;
}> = [
  { id: 'today', label: '今天', icon: Clock3 },
  { id: 'inbox', label: '稍后处理', icon: Star, count: 3 },
  { id: 'notes', label: '所有笔记', icon: FileText },
];

const projects = [
  { name: 'Daily Workbench', color: '#8b7cf6', count: 8 },
  { name: '个人网站', color: '#4ca5ff', count: 4 },
  { name: '服务器运维', color: '#38c79a', count: 2 },
  { name: '灵感与探索', color: '#f3a956', count: 6 },
];

export function WorkspaceSidebar({
  activeView,
  workspaceId,
  workspaces,
  onSelectView,
  onSelectWorkspace,
}: WorkspaceSidebarProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const activeWorkspace =
    workspaces.find((workspace) => workspace.id === workspaceId) ?? workspaces[0];

  useEffect(() => {
    if (!menuOpen) return;

    const closeMenu = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false);
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
          className="workspace-switcher__button"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((open) => !open)}
        >
          <span
            className="workspace-switcher__mark"
            style={{ backgroundColor: activeWorkspace.color }}
            aria-hidden="true"
          >
            {activeWorkspace.shortName}
          </span>
          <span className="workspace-switcher__copy">
            <strong>{activeWorkspace.name}</strong>
            <small>个人工作区</small>
          </span>
          <ChevronDown size={15} aria-hidden="true" />
        </button>

        {menuOpen ? (
          <div className="workspace-menu" role="menu" aria-label="切换工作区">
            <p className="workspace-menu__label">工作区</p>
            {workspaces.map((workspace) => (
              <button
                key={workspace.id}
                type="button"
                role="menuitemradio"
                aria-checked={workspace.id === workspaceId}
                className={workspace.id === workspaceId ? 'is-selected' : ''}
                onClick={() => {
                  onSelectWorkspace(workspace.id);
                  setMenuOpen(false);
                }}
              >
                <span style={{ backgroundColor: workspace.color }}>{workspace.shortName}</span>
                {workspace.name}
              </button>
            ))}
            <button type="button" role="menuitem" className="workspace-menu__new">
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
          {sidebarLinks.map(({ id, label, icon: Icon, count }) => (
            <button
              type="button"
              className={`sidebar-link ${activeView === id ? 'is-active' : ''}`}
              key={label}
              onClick={() => onSelectView(id)}
              aria-current={activeView === id ? 'page' : undefined}
            >
              <Icon size={16} strokeWidth={1.8} aria-hidden="true" />
              <span>{label}</span>
              {count ? <small>{count}</small> : null}
            </button>
          ))}
        </div>

        <div className="sidebar-section">
          <div className="sidebar-section__heading">
            <span>项目</span>
            <IconButton label="新建项目" tooltipSide="right">
              <Plus size={15} aria-hidden="true" />
            </IconButton>
          </div>
          <div className="project-list">
            {projects.map((project, index) => (
              <button
                type="button"
                className={`project-link ${index === 0 ? 'is-selected' : ''}`}
                key={project.name}
                onClick={() => onSelectView('tasks')}
              >
                <span className="project-link__dot" style={{ background: project.color }} />
                <span>{project.name}</span>
                <small>{project.count}</small>
              </button>
            ))}
          </div>
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
          <button type="button" className="sidebar-link" onClick={() => onSelectView('tasks')}>
            <Users size={16} strokeWidth={1.8} aria-hidden="true" />
            <span>等待中</span>
          </button>
          <button type="button" className="sidebar-link" onClick={() => onSelectView('notes')}>
            <Folder size={16} strokeWidth={1.8} aria-hidden="true" />
            <span>资源库</span>
          </button>
        </div>
      </div>

      <div className="sidebar-storage" aria-label="本地数据使用情况">
        <div>
          <span>本地数据</span>
          <span>24 MB</span>
        </div>
        <div className="storage-meter">
          <span />
        </div>
        <p>
          <Hash size={12} aria-hidden="true" /> 所有内容已保存
        </p>
      </div>
    </aside>
  );
}
