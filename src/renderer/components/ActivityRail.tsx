import {
  Bot,
  CheckSquare2,
  Inbox,
  LayoutDashboard,
  NotebookPen,
  Settings2,
  Sparkles,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ViewId } from '../model';
import { IconButton } from './IconButton';

interface ActivityRailProps {
  activeView: ViewId;
  inboxCount: number | null;
  onSelect: (view: ViewId) => void;
}

interface RailItem {
  id: ViewId;
  label: string;
  icon: LucideIcon;
  badge?: number;
}

const primaryItems: RailItem[] = [
  { id: 'today', label: '今日', icon: LayoutDashboard },
  { id: 'inbox', label: '收件箱', icon: Inbox },
  { id: 'tasks', label: '任务', icon: CheckSquare2 },
  { id: 'notes', label: '笔记', icon: NotebookPen },
  { id: 'automations', label: '自动化', icon: Bot },
];

export function ActivityRail({ activeView, inboxCount, onSelect }: ActivityRailProps) {
  return (
    <nav className="activity-rail" aria-label="主导航">
      <div className="activity-rail__brand" aria-label="Daily Workbench">
        <Sparkles size={18} strokeWidth={2.1} aria-hidden="true" />
      </div>

      <div className="activity-rail__items">
        {primaryItems.map(({ id, label, icon: Icon, badge }) => {
          const effectiveBadge = id === 'inbox' ? inboxCount : badge;
          return (
            <div className="activity-rail__item" key={id}>
              <IconButton
                label={label}
                active={activeView === id}
                tooltipSide="right"
                onClick={() => onSelect(id)}
                aria-current={activeView === id ? 'page' : undefined}
              >
                <Icon size={19} strokeWidth={1.8} aria-hidden="true" />
              </IconButton>
              {effectiveBadge ? (
                <span className="activity-rail__badge">
                  {effectiveBadge > 99 ? '99+' : effectiveBadge}
                </span>
              ) : null}
            </div>
          );
        })}
      </div>

      <div className="activity-rail__footer">
        <IconButton
          label="设置"
          active={activeView === 'settings'}
          tooltipSide="right"
          onClick={() => onSelect('settings')}
          aria-current={activeView === 'settings' ? 'page' : undefined}
        >
          <Settings2 size={19} strokeWidth={1.8} aria-hidden="true" />
        </IconButton>
        <button
          className="user-avatar"
          type="button"
          aria-label="打开个人资料"
          data-tooltip="Justin"
          data-tooltip-side="right"
        >
          J
          <span className="user-avatar__status" aria-label="在线" />
        </button>
      </div>
    </nav>
  );
}
