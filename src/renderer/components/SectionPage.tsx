import {
  Bot,
  ChevronRight,
  Clock3,
  Globe2,
  MoreHorizontal,
  Plus,
  Settings2,
  SquareTerminal,
  Zap,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ViewId } from '../model';
import { IconButton } from './IconButton';

interface SectionPageProps {
  view: Exclude<ViewId, 'today' | 'inbox' | 'tasks' | 'notes'>;
  onOpenBrowser: () => void;
  onOpenTerminal: () => void;
}

const pageMeta: Record<
  Exclude<ViewId, 'today' | 'inbox' | 'tasks' | 'notes'>,
  { title: string; description: string; icon: LucideIcon }
> = {
  automations: { title: '自动化', description: '让重复事务在后台按计划完成。', icon: Bot },
  settings: { title: '设置', description: '调整工作台、数据与工具偏好。', icon: Settings2 },
};

export function SectionPage({ view, onOpenBrowser, onOpenTerminal }: SectionPageProps) {
  const meta = pageMeta[view];
  const PageIcon = meta.icon;

  return (
    <div className="section-page">
      <header className="section-page__header">
        <div className="section-page__title">
          <span>
            <PageIcon size={20} />
          </span>
          <div>
            <h1>{meta.title}</h1>
            <p>{meta.description}</p>
          </div>
        </div>
        {view !== 'settings' ? (
          <button type="button" className="primary-button">
            <Plus size={15} /> 新建
          </button>
        ) : null}
      </header>

      {view === 'automations' ? (
        <section className="automations-view">
          <div className="automation-hero">
            <span>
              <Zap size={21} />
            </span>
            <div>
              <h2>让工作台替你处理重复事务</h2>
              <p>按时间或条件触发提醒、命令和数据整理。</p>
            </div>
            <button type="button" className="primary-button">
              <Plus size={15} /> 新建自动化
            </button>
          </div>
          <div className="automation-list">
            {[
              ['每日工作台准备', '每天 08:30', '打开今日页面并生成计划摘要'],
              ['服务器巡检提醒', '每周一 09:00', '提醒检查磁盘空间与备份状态'],
              ['每周回顾', '每周五 17:30', '创建本周回顾笔记模板'],
            ].map(([title, schedule, description], index) => (
              <div className="automation-row" key={title}>
                <span className="automation-row__icon">
                  <Zap size={16} />
                </span>
                <div>
                  <strong>{title}</strong>
                  <p>{description}</p>
                </div>
                <time>
                  <Clock3 size={13} /> {schedule}
                </time>
                <button
                  type="button"
                  className={`toggle ${index < 2 ? 'is-on' : ''}`}
                  aria-label={`${index < 2 ? '停用' : '启用'}${title}`}
                >
                  <i />
                </button>
                <IconButton label="自动化选项">
                  <MoreHorizontal size={16} />
                </IconButton>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {view === 'settings' ? (
        <section className="settings-view">
          <nav className="settings-nav" aria-label="设置分类">
            <button type="button" className="is-active">
              通用
            </button>
            <button type="button">外观</button>
            <button type="button">数据</button>
            <button type="button">快捷键</button>
            <button type="button">关于</button>
          </nav>
          <div className="settings-content">
            <div className="settings-group">
              <h2>工具面板</h2>
              <p>选择最常用的内置工具。</p>
              <button type="button" className="setting-row" onClick={onOpenBrowser}>
                <span>
                  <Globe2 size={17} />
                </span>
                <div>
                  <strong>内置浏览器</strong>
                  <small>在右侧打开网页并保留当前工作上下文</small>
                </div>
                <ChevronRight size={16} />
              </button>
              <button type="button" className="setting-row" onClick={onOpenTerminal}>
                <span>
                  <SquareTerminal size={17} />
                </span>
                <div>
                  <strong>集成终端</strong>
                  <small>使用 PowerShell、CMD、WSL 或其他 Shell</small>
                </div>
                <ChevronRight size={16} />
              </button>
            </div>
            <div className="settings-group">
              <h2>启动</h2>
              <p>Daily Workbench 打开时恢复上次工作状态。</p>
              <div className="setting-row setting-row--static">
                <span>
                  <Settings2 size={17} />
                </span>
                <div>
                  <strong>恢复工作区</strong>
                  <small>面板尺寸、当前页面和工具会自动恢复</small>
                </div>
                <button type="button" className="toggle is-on" aria-label="关闭恢复工作区">
                  <i />
                </button>
              </div>
            </div>
          </div>
        </section>
      ) : null}
    </div>
  );
}
