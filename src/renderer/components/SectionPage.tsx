import {
  Bot,
  CheckCircle2,
  CheckSquare2,
  ChevronRight,
  Clock3,
  FileText,
  Globe2,
  Inbox,
  MoreHorizontal,
  NotebookPen,
  Plus,
  Search,
  Settings2,
  SlidersHorizontal,
  SquareTerminal,
  Zap,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ViewId } from '../model';
import { IconButton } from './IconButton';

interface SectionPageProps {
  view: Exclude<ViewId, 'today'>;
  onOpenBrowser: () => void;
  onOpenTerminal: () => void;
}

const pageMeta: Record<
  Exclude<ViewId, 'today'>,
  { title: string; description: string; icon: LucideIcon }
> = {
  inbox: { title: '收件箱', description: '集中处理随手记录、链接和待分类事项。', icon: Inbox },
  tasks: { title: '任务', description: '按状态推进你的所有项目。', icon: CheckSquare2 },
  notes: { title: '笔记', description: '把想法、资料与项目上下文放在一起。', icon: NotebookPen },
  automations: { title: '自动化', description: '让重复事务在后台按计划完成。', icon: Bot },
  settings: { title: '设置', description: '调整工作台、数据与工具偏好。', icon: Settings2 },
};

const inboxEntries = [
  {
    title: '比较三种 Wiki 试点方案',
    meta: '任务 · 12 分钟前',
    icon: CheckSquare2,
    color: '#8b7cf6',
  },
  {
    title: 'Electron WebContentsView 安全清单',
    meta: '链接 · 今天 14:08',
    icon: Globe2,
    color: '#4ca5ff',
  },
  {
    title: '下个版本可以加入全局快捷记录',
    meta: '笔记 · 今天 11:34',
    icon: FileText,
    color: '#38c79a',
  },
  { title: '周五前检查服务器磁盘空间', meta: '任务 · 昨天', icon: CheckSquare2, color: '#f3a956' },
];

const taskColumns = [
  {
    title: '待开始',
    count: 3,
    tasks: [
      ['设计数据备份流程', '服务器运维'],
      ['整理应用图标规范', 'Daily Workbench'],
      ['补充网站项目案例', '个人网站'],
    ],
  },
  {
    title: '进行中',
    count: 2,
    tasks: [
      ['搭建 Electron 项目框架', 'Daily Workbench'],
      ['验证 Wiki 内网部署', '工作'],
    ],
  },
  {
    title: '已完成',
    count: 2,
    tasks: [
      ['确定第一版功能范围', 'Daily Workbench'],
      ['配置代码仓库', 'Daily Workbench'],
    ],
  },
];

const notes = [
  {
    title: 'Daily Workbench 产品方向',
    excerpt: '工作区承载上下文，浏览器和终端作为当前事务的工具面板…',
    time: '刚刚',
    tag: '产品',
  },
  {
    title: 'Electron 安全边界',
    excerpt: '远程内容必须运行在独立 WebContents 中，关闭 Node 集成…',
    time: '今天 13:42',
    tag: '开发',
  },
  {
    title: '公司 Wiki 试点计划',
    excerpt: '目标用户约 100 人，先在现有 Windows 虚拟机上验证体验…',
    time: '今天 10:18',
    tag: '工作',
  },
  {
    title: '本周回顾',
    excerpt: '完成个人网站的基础优化，下一步关注内容和长期维护…',
    time: '星期一',
    tag: '回顾',
  },
];

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

      {view === 'inbox' ? (
        <section className="inbox-view">
          <div className="page-toolbar">
            <label className="page-search">
              <Search size={15} />
              <span className="sr-only">搜索收件箱</span>
              <input placeholder="搜索收件箱" />
            </label>
            <button type="button" className="secondary-button">
              <SlidersHorizontal size={14} /> 筛选
            </button>
          </div>
          <div className="inbox-list">
            {inboxEntries.map(({ title, meta: itemMeta, icon: Icon, color }) => (
              <button type="button" className="inbox-entry" key={title}>
                <span
                  className="inbox-entry__icon"
                  style={{ color, backgroundColor: `${color}18` }}
                >
                  <Icon size={16} />
                </span>
                <span>
                  <strong>{title}</strong>
                  <small>{itemMeta}</small>
                </span>
                <ChevronRight size={15} />
              </button>
            ))}
          </div>
          <div className="inbox-zero">
            <CheckCircle2 size={15} /> 处理完这些内容，就可以清空收件箱。
          </div>
        </section>
      ) : null}

      {view === 'tasks' ? (
        <section className="board-view">
          <div className="page-toolbar">
            <div className="segmented-control">
              <button className="is-active" type="button">
                看板
              </button>
              <button type="button">列表</button>
              <button type="button">日历</button>
            </div>
            <button type="button" className="secondary-button">
              <SlidersHorizontal size={14} /> 筛选
            </button>
          </div>
          <div className="task-board">
            {taskColumns.map((column, columnIndex) => (
              <div className="board-column" key={column.title}>
                <div className="board-column__header">
                  <span>
                    <i className={`board-dot board-dot--${columnIndex}`} />
                    {column.title}
                    <small>{column.count}</small>
                  </span>
                  <IconButton label="列表选项">
                    <MoreHorizontal size={15} />
                  </IconButton>
                </div>
                {column.tasks.map(([title, project]) => (
                  <button type="button" className="board-task" key={title}>
                    <strong>{title}</strong>
                    <span>{project}</span>
                    <small>
                      <Clock3 size={12} /> {columnIndex === 2 ? '已完成' : '本周'}
                    </small>
                  </button>
                ))}
                <button type="button" className="board-add">
                  <Plus size={14} /> 添加任务
                </button>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {view === 'notes' ? (
        <section className="notes-view">
          <div className="page-toolbar">
            <label className="page-search">
              <Search size={15} />
              <span className="sr-only">搜索笔记</span>
              <input placeholder="搜索标题和内容" />
            </label>
            <div className="segmented-control">
              <button className="is-active" type="button">
                卡片
              </button>
              <button type="button">列表</button>
            </div>
          </div>
          <div className="note-grid">
            {notes.map((note) => (
              <button type="button" className="note-card" key={note.title}>
                <span className="note-card__tag">{note.tag}</span>
                <h2>{note.title}</h2>
                <p>{note.excerpt}</p>
                <footer>
                  <span>
                    <FileText size={13} /> Markdown
                  </span>
                  <time>{note.time}</time>
                </footer>
              </button>
            ))}
            <button type="button" className="note-card note-card--new">
              <Plus size={20} />
              <strong>新建笔记</strong>
              <span>从空白页开始</span>
            </button>
          </div>
        </section>
      ) : null}

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
