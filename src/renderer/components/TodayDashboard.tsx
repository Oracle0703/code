import {
  ArrowRight,
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronRight,
  Circle,
  Clock3,
  Coffee,
  FileText,
  Flame,
  Inbox,
  MoreHorizontal,
  Pause,
  Play,
  Plus,
  Sparkles,
  Target,
} from 'lucide-react';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { usePersistentState } from '../hooks/usePersistentState';
import { INBOX_CONTENT_MAX_LENGTH } from '../../shared/inbox-domain';
import { IconButton } from './IconButton';

interface TodayDashboardProps {
  inboxStatus: 'loading' | 'ready' | 'error';
  inboxCount: number | null;
  uncategorizedCount: number | null;
  capturePending: boolean;
  onCapture: (content: string) => Promise<void>;
  onOpenInbox: () => void;
  onOpenTasks: () => void;
  onOpenNotes: () => void;
}

interface Task {
  id: string;
  title: string;
  project: string;
  accent: string;
  due?: string;
  done: boolean;
}

const initialTasks: Task[] = [
  {
    id: 'task-workbench-shell',
    title: '完成 Daily Workbench 基础框架',
    project: 'Daily Workbench',
    accent: '#8b7cf6',
    due: '18:00',
    done: false,
  },
  {
    id: 'task-review-wiki',
    title: '整理公司 Wiki 试点反馈',
    project: '工作',
    accent: '#4ca5ff',
    due: '今天',
    done: false,
  },
  {
    id: 'task-backup-server',
    title: '检查服务器自动备份状态',
    project: '服务器运维',
    accent: '#38c79a',
    done: true,
  },
  {
    id: 'task-site-copy',
    title: '更新个人网站项目介绍',
    project: '个人网站',
    accent: '#f3a956',
    done: false,
  },
];

const agenda = [
  { time: '09:30', end: '10:00', title: '整理今日计划', type: 'focus' },
  { time: '11:00', end: '11:30', title: 'Wiki 试点沟通', type: 'meeting' },
  { time: '14:00', end: '15:30', title: 'Workbench 开发', type: 'focus' },
  { time: '17:30', end: '18:00', title: '回顾与收尾', type: 'review' },
];

function formatDate() {
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'long',
    day: 'numeric',
    weekday: 'long',
  }).format(new Date());
}

function formatTimer(seconds: number) {
  const minutes = Math.floor(seconds / 60)
    .toString()
    .padStart(2, '0');
  const remainingSeconds = (seconds % 60).toString().padStart(2, '0');
  return `${minutes}:${remainingSeconds}`;
}

export function TodayDashboard({
  inboxStatus,
  inboxCount,
  uncategorizedCount,
  capturePending,
  onCapture,
  onOpenInbox,
  onOpenTasks,
  onOpenNotes,
}: TodayDashboardProps) {
  const [tasks, setTasks] = usePersistentState<Task[]>('daily.today.tasks', initialTasks);
  const [capture, setCapture] = useState('');
  const [recentCapture, setRecentCapture] = useState<string | null>(null);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [focusRunning, setFocusRunning] = useState(false);
  const [focusSeconds, setFocusSeconds] = useState(25 * 60);
  const captureLength = Array.from(capture.trim()).length;
  const captureTooLong = captureLength > INBOX_CONTENT_MAX_LENGTH;

  const remainingTasks = useMemo(() => tasks.filter((task) => !task.done).length, [tasks]);

  useEffect(() => {
    if (!focusRunning || focusSeconds <= 0) return;
    const timer = window.setInterval(() => {
      setFocusSeconds((seconds) => Math.max(0, seconds - 1));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [focusRunning, focusSeconds]);

  const addCapture = async (event: FormEvent) => {
    event.preventDefault();
    const title = capture.trim();
    if (!title || capturePending || captureTooLong) return;
    setCaptureError(null);
    try {
      await onCapture(title);
      setRecentCapture(title);
      setCapture('');
    } catch (error) {
      setCaptureError(error instanceof Error ? error.message : '快速记录失败，请重试。');
    }
  };

  return (
    <div className="dashboard">
      <header className="dashboard-hero">
        <div>
          <p className="eyebrow">
            <CalendarDays size={14} aria-hidden="true" /> {formatDate()}
          </p>
          <h1>下午好，Justin</h1>
          <p>你今天还有 {remainingTasks} 项任务。先完成最重要的一件事。</p>
        </div>
        <div className="streak-pill" aria-label="连续规划 6 天">
          <Flame size={16} aria-hidden="true" />
          <span>
            <strong>6 天</strong> 连续规划
          </span>
        </div>
      </header>

      <form className="quick-capture" onSubmit={(event) => void addCapture(event)}>
        <div className="quick-capture__icon">
          <Plus size={18} aria-hidden="true" />
        </div>
        <label htmlFor="quick-capture-input" className="sr-only">
          快速记录到收件箱
        </label>
        <input
          id="quick-capture-input"
          value={capture}
          onChange={(event) => setCapture(event.target.value)}
          placeholder="记录到收件箱…"
          autoComplete="off"
          aria-invalid={captureTooLong}
        />
        <div className="quick-capture__actions">
          <span className={`key-hint${captureTooLong ? ' is-error' : ''}`}>
            {captureTooLong ? `${captureLength} / ${INBOX_CONTENT_MAX_LENGTH}` : 'Ctrl N'}
          </span>
          <button type="submit" disabled={!capture.trim() || capturePending || captureTooLong}>
            {capturePending ? '保存中…' : '添加'}
          </button>
        </div>
      </form>
      {captureTooLong ? (
        <div className="capture-confirmation is-error" role="alert">
          记录内容最多 {INBOX_CONTENT_MAX_LENGTH} 个字符。
        </div>
      ) : null}
      {recentCapture ? (
        <div className="capture-confirmation" role="status">
          <Check size={14} aria-hidden="true" /> “{recentCapture}” 已加入收件箱
        </div>
      ) : null}
      {captureError ? (
        <div className="capture-confirmation is-error" role="alert">
          {captureError}
        </div>
      ) : null}

      <section className="metric-grid" aria-label="今日概览">
        <button type="button" className="metric-card" onClick={onOpenTasks}>
          <span className="metric-card__icon metric-card__icon--violet">
            <Target size={18} />
          </span>
          <span className="metric-card__copy">
            <small>今日任务</small>
            <strong>
              {remainingTasks}
              <em> / {tasks.length}</em>
            </strong>
          </span>
          <span className="mini-progress">
            <i style={{ width: `${((tasks.length - remainingTasks) / tasks.length) * 100}%` }} />
          </span>
          <ChevronRight size={16} aria-hidden="true" />
        </button>
        <button type="button" className="metric-card" onClick={onOpenInbox}>
          <span className="metric-card__icon metric-card__icon--blue">
            <Inbox size={18} />
          </span>
          <span className="metric-card__copy">
            <small>收件箱</small>
            <strong>
              {inboxCount === null ? '—' : inboxCount} <em>{inboxCount === null ? '' : '项'}</em>
            </strong>
          </span>
          <span className="metric-card__meta">
            {inboxCount === null || uncategorizedCount === null
              ? inboxStatus === 'error'
                ? '暂时不可用'
                : '正在同步…'
              : uncategorizedCount > 0
                ? `${uncategorizedCount} 项未分类`
                : '已全部分类'}
          </span>
          <ChevronRight size={16} aria-hidden="true" />
        </button>
        <button type="button" className="metric-card" onClick={onOpenNotes}>
          <span className="metric-card__icon metric-card__icon--green">
            <FileText size={18} />
          </span>
          <span className="metric-card__copy">
            <small>本周笔记</small>
            <strong>
              12 <em>篇</em>
            </strong>
          </span>
          <span className="metric-card__meta">最近 14:32</span>
          <ChevronRight size={16} aria-hidden="true" />
        </button>
      </section>

      <div className="dashboard-grid">
        <section className="panel-card task-card" aria-labelledby="focus-tasks-heading">
          <div className="panel-card__header">
            <div>
              <span className="panel-card__kicker">
                <Sparkles size={13} /> 优先处理
              </span>
              <h2 id="focus-tasks-heading">今日任务</h2>
            </div>
            <button type="button" className="text-button" onClick={onOpenTasks}>
              查看全部 <ArrowRight size={14} />
            </button>
          </div>
          <div className="task-list">
            {tasks.slice(0, 5).map((task) => (
              <label className={`task-row ${task.done ? 'is-done' : ''}`} key={task.id}>
                <input
                  type="checkbox"
                  checked={task.done}
                  onChange={() => {
                    setTasks((currentTasks) =>
                      currentTasks.map((item) =>
                        item.id === task.id ? { ...item, done: !item.done } : item,
                      ),
                    );
                  }}
                />
                <span className="task-row__check" aria-hidden="true">
                  {task.done ? <CheckCircle2 size={19} /> : <Circle size={19} />}
                </span>
                <span className="task-row__body">
                  <strong>{task.title}</strong>
                  <small>
                    <i style={{ background: task.accent }} /> {task.project}
                  </small>
                </span>
                {task.due ? (
                  <time>
                    <Clock3 size={12} /> {task.due}
                  </time>
                ) : null}
                <IconButton label="任务选项" tooltipSide="left" tabIndex={-1}>
                  <MoreHorizontal size={16} />
                </IconButton>
              </label>
            ))}
          </div>
          <button type="button" className="add-row" onClick={onOpenTasks}>
            <Plus size={15} /> 添加任务
          </button>
        </section>

        <div className="dashboard-side-stack">
          <section className="focus-card" aria-labelledby="focus-session-heading">
            <div className="focus-card__topline">
              <span>
                <Target size={14} /> 专注模式
              </span>
              <small>25 分钟</small>
            </div>
            <h2 id="focus-session-heading">{formatTimer(focusSeconds)}</h2>
            <p>
              {focusRunning && focusSeconds > 0
                ? '保持节奏，暂时忽略其他事情。'
                : '准备好完成今天最重要的任务了吗？'}
            </p>
            <button
              type="button"
              onClick={() => {
                if (focusSeconds === 0) {
                  setFocusSeconds(25 * 60);
                  setFocusRunning(true);
                  return;
                }
                setFocusRunning((running) => !running);
              }}
            >
              {focusRunning && focusSeconds > 0 ? (
                <Pause size={15} fill="currentColor" />
              ) : (
                <Play size={15} fill="currentColor" />
              )}
              {focusRunning && focusSeconds > 0
                ? '暂停专注'
                : focusSeconds === 0
                  ? '再来一次'
                  : '开始专注'}
            </button>
            <div className="focus-card__glow" aria-hidden="true" />
          </section>

          <section className="panel-card agenda-card" aria-labelledby="agenda-heading">
            <div className="panel-card__header">
              <div>
                <h2 id="agenda-heading">今日日程</h2>
              </div>
              <IconButton label="日程选项" tooltipSide="left">
                <MoreHorizontal size={16} />
              </IconButton>
            </div>
            <div className="agenda-list">
              {agenda.map((item) => (
                <div className="agenda-row" key={`${item.time}-${item.title}`}>
                  <div className="agenda-row__time">
                    <strong>{item.time}</strong>
                    <small>{item.end}</small>
                  </div>
                  <span className={`agenda-row__line agenda-row__line--${item.type}`} />
                  <p>{item.title}</p>
                </div>
              ))}
            </div>
            <div className="agenda-footer">
              <Coffee size={14} /> 下一段空闲时间：15:30
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
