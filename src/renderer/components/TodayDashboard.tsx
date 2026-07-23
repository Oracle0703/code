import {
  ArrowRight,
  CalendarClock,
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronRight,
  Circle,
  Clock3,
  Inbox,
  LoaderCircle,
  Pause,
  Play,
  Plus,
  Sparkles,
  Target,
} from 'lucide-react';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import type {
  ScheduleItem,
  ScheduleSnapshot,
  Task,
  TaskSnapshot,
  TaskStatus,
} from '../../shared/contracts';
import { INBOX_CONTENT_MAX_LENGTH } from '../../shared/inbox-domain';
import { formatScheduleInputMinute } from '../schedule-state';
import { toLocalDateKey } from '../task-state';

interface TodayDashboardProps {
  inboxStatus: 'loading' | 'ready' | 'error';
  inboxCount: number | null;
  uncategorizedCount: number | null;
  capturePending: boolean;
  taskSnapshot: TaskSnapshot | null;
  taskStatus: 'loading' | 'ready' | 'error';
  taskLoadError: string | null;
  taskOperationError: string | null;
  pendingTaskIds: ReadonlySet<string>;
  taskCreatePending: boolean;
  scheduleSnapshot: ScheduleSnapshot | null;
  scheduleItems: readonly ScheduleItem[];
  scheduleStatus: 'loading' | 'ready' | 'error';
  scheduleLoadError: string | null;
  scheduleOperationError: string | null;
  pendingScheduleItemIds: ReadonlySet<string>;
  scheduleCreatePending: boolean;
  onCapture: (content: string) => Promise<void>;
  onOpenInbox: () => void;
  onOpenTasks: () => void;
  onCreateToday: () => void;
  onOpenTask: (task: Task) => void;
  onUpdateTaskStatus: (taskId: string, status: TaskStatus) => Promise<void>;
  onRetrySchedule: () => void;
  onCreateSchedule: () => void;
  onOpenSchedule: (item: ScheduleItem) => void;
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
  taskSnapshot,
  taskStatus,
  taskLoadError,
  taskOperationError,
  pendingTaskIds,
  taskCreatePending,
  scheduleSnapshot,
  scheduleItems,
  scheduleStatus,
  scheduleLoadError,
  scheduleOperationError,
  pendingScheduleItemIds,
  scheduleCreatePending,
  onCapture,
  onOpenInbox,
  onOpenTasks,
  onCreateToday,
  onOpenTask,
  onUpdateTaskStatus,
  onRetrySchedule,
  onCreateSchedule,
  onOpenSchedule,
}: TodayDashboardProps) {
  const [capture, setCapture] = useState('');
  const [recentCapture, setRecentCapture] = useState<string | null>(null);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [focusRunning, setFocusRunning] = useState(false);
  const [focusSeconds, setFocusSeconds] = useState(25 * 60);
  const captureLength = Array.from(capture.trim()).length;
  const captureTooLong = captureLength > INBOX_CONTENT_MAX_LENGTH;
  const todayDate =
    taskSnapshot?.todayDate ?? scheduleSnapshot?.todayDate ?? toLocalDateKey(new Date());
  const todayTasks = useMemo(
    () => taskSnapshot?.tasks.filter((task) => task.plannedFor === taskSnapshot.todayDate) ?? [],
    [taskSnapshot],
  );
  const remainingTasks = todayTasks.filter(({ status }) => status !== 'completed').length;
  const completedTasks = todayTasks.length - remainingTasks;
  const progress = todayTasks.length === 0 ? 0 : (completedTasks / todayTasks.length) * 100;
  const taskReady = taskSnapshot !== null;

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
            <CalendarDays size={14} aria-hidden="true" /> {formatLocalDate(todayDate)}
          </p>
          <h1>今天，从下一步开始</h1>
          <p>
            {taskReady
              ? remainingTasks > 0
                ? `还有 ${remainingTasks} 项今日任务，先完成最重要的一件事。`
                : todayTasks.length > 0
                  ? '今日任务已经完成，可以安心收尾。'
                  : '还没有安排任务，先选一件今天要推进的事。'
              : taskStatus === 'error'
                ? '任务暂时不可用，收件箱仍可继续记录。'
                : '正在同步今天的任务…'}
          </p>
        </div>
        <div
          className="streak-pill"
          aria-label={`今日已完成 ${completedTasks} 项，共 ${todayTasks.length} 项`}
        >
          <CheckCircle2 size={16} aria-hidden="true" />
          <span>
            <strong>{taskReady ? `${completedTasks} / ${todayTasks.length}` : '—'}</strong> 今日完成
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
              {taskReady ? remainingTasks : '—'}{' '}
              <em>{taskReady ? `/ ${todayTasks.length}` : ''}</em>
            </strong>
          </span>
          <span className="mini-progress">
            <i style={{ width: `${progress}%` }} />
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
        <button type="button" className="metric-card" onClick={onOpenTasks}>
          <span className="metric-card__icon metric-card__icon--green">
            <CheckCircle2 size={18} />
          </span>
          <span className="metric-card__copy">
            <small>今日完成</small>
            <strong>
              {taskReady ? completedTasks : '—'} <em>{taskReady ? '项' : ''}</em>
            </strong>
          </span>
          <span className="metric-card__meta">
            {taskReady
              ? todayTasks.length === 0
                ? '尚未安排任务'
                : `${Math.round(progress)}% 已完成`
              : taskStatus === 'error'
                ? '暂时不可用'
                : '正在同步…'}
          </span>
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

          {taskOperationError ? (
            <p className="today-task-error" role="alert">
              {taskOperationError}
            </p>
          ) : null}
          {taskStatus === 'loading' && !taskSnapshot ? (
            <div className="today-task-state" aria-live="polite">
              <LoaderCircle className="is-spinning" size={18} /> 正在同步今日任务…
            </div>
          ) : taskStatus === 'error' && !taskSnapshot ? (
            <div className="today-task-state is-error" role="alert">
              {taskLoadError ?? '今日任务暂时无法读取。'}
              <button type="button" onClick={onOpenTasks}>
                查看详情
              </button>
            </div>
          ) : todayTasks.length > 0 ? (
            <div className="task-list">
              {todayTasks.slice(0, 6).map((task) => {
                const pending = pendingTaskIds.has(task.id);
                const completed = task.status === 'completed';
                return (
                  <div className={`task-row ${completed ? 'is-done' : ''}`} key={task.id}>
                    <button
                      type="button"
                      className="task-row__toggle"
                      aria-label={completed ? `重新打开：${task.title}` : `完成：${task.title}`}
                      disabled={pending}
                      onClick={() =>
                        void onUpdateTaskStatus(task.id, completed ? 'todo' : 'completed').catch(
                          () => undefined,
                        )
                      }
                    >
                      {pending ? (
                        <LoaderCircle className="is-spinning" size={19} />
                      ) : completed ? (
                        <CheckCircle2 size={19} />
                      ) : (
                        <Circle size={19} />
                      )}
                    </button>
                    <button
                      type="button"
                      className="task-row__body"
                      disabled={pending}
                      onClick={() => onOpenTask(task)}
                    >
                      <strong>{task.title}</strong>
                      <small>
                        <i className={`task-status-dot is-${task.status}`} />{' '}
                        {taskStatusLabel(task.status)}
                        {task.sourceInboxEntryId ? ' · 来自收件箱' : ''}
                      </small>
                    </button>
                    <time dateTime={task.plannedFor ?? undefined}>
                      <Clock3 size={12} /> 今天
                    </time>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="today-task-empty">
              <CheckCircle2 size={21} />
              <strong>今天还没有任务</strong>
              <span>把一项任务安排到今天，形成清晰的下一步。</span>
            </div>
          )}
          <button
            type="button"
            className="add-row"
            onClick={onCreateToday}
            disabled={taskCreatePending}
          >
            {taskCreatePending ? (
              <LoaderCircle className="is-spinning" size={15} />
            ) : (
              <Plus size={15} />
            )}
            {taskCreatePending ? '正在创建…' : '添加今日任务'}
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
                : remainingTasks > 0
                  ? `从 ${remainingTasks} 项今日任务中选一项开始。`
                  : '安排一项今日任务，再开始专注。'}
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
              <button
                type="button"
                className="agenda-card__add"
                onClick={onCreateSchedule}
                disabled={scheduleCreatePending || !scheduleSnapshot}
                aria-label="添加今日日程"
              >
                {scheduleCreatePending ? (
                  <LoaderCircle className="is-spinning" size={14} />
                ) : (
                  <Plus size={14} />
                )}
              </button>
            </div>
            {scheduleOperationError ? (
              <p className="agenda-card__error" role="alert">
                {scheduleOperationError}
              </p>
            ) : null}
            {scheduleStatus === 'loading' && !scheduleSnapshot ? (
              <div className="agenda-card__state" aria-live="polite">
                <LoaderCircle className="is-spinning" size={16} /> 正在同步日程…
              </div>
            ) : scheduleStatus === 'error' && !scheduleSnapshot ? (
              <div className="agenda-card__state is-error" role="alert">
                <span>{scheduleLoadError ?? '今日日程暂时无法读取。'}</span>
                <button type="button" onClick={onRetrySchedule}>
                  重试
                </button>
              </div>
            ) : scheduleSnapshot && scheduleItems.length > 0 ? (
              <div className="agenda-list">
                {scheduleItems.map((item) => {
                  const pending = pendingScheduleItemIds.has(item.id);
                  return (
                    <button
                      type="button"
                      className="agenda-row"
                      key={item.id}
                      disabled={pending}
                      onClick={() => onOpenSchedule(item)}
                      aria-label={`编辑日程：${item.title}，${formatScheduleInputMinute(item.startMinute)} 到 ${formatScheduleInputMinute(item.endMinute)}`}
                    >
                      <span className="agenda-row__time">
                        <strong>{formatScheduleInputMinute(item.startMinute)}</strong>
                        <small>{formatScheduleInputMinute(item.endMinute)}</small>
                      </span>
                      <span className={`agenda-row__line agenda-row__line--${item.kind}`} />
                      <span className="agenda-row__copy">
                        <strong>{item.title}</strong>
                        <small>{scheduleKindLabel(item.kind)}</small>
                      </span>
                      {pending ? <LoaderCircle className="is-spinning" size={13} /> : null}
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="agenda-card__empty">
                <CalendarClock size={19} />
                <strong>今天还没有日程</strong>
                <span>安排一段明确的开始与结束时间。</span>
                <button type="button" onClick={onCreateSchedule} disabled={!scheduleSnapshot}>
                  <Plus size={13} /> 添加日程
                </button>
              </div>
            )}
            {scheduleSnapshot && scheduleItems.length > 0 ? (
              <div className="agenda-footer">
                <CalendarClock size={13} /> {scheduleItems.length} 段本地日程
              </div>
            ) : null}
          </section>
        </div>
      </div>
    </div>
  );
}

function formatLocalDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) return value;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'long',
    day: 'numeric',
    weekday: 'long',
  }).format(date);
}

function taskStatusLabel(status: TaskStatus): string {
  if (status === 'completed') return '已完成';
  if (status === 'in_progress') return '进行中';
  return '待办';
}

function scheduleKindLabel(kind: ScheduleItem['kind']): string {
  if (kind === 'meeting') return '会议';
  if (kind === 'review') return '回顾';
  if (kind === 'personal') return '个人';
  return '专注';
}
