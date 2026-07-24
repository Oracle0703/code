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
  LogIn,
  Pause,
  Play,
  Plus,
  MessageSquareText,
  Sparkles,
  Target,
  XCircle,
} from 'lucide-react';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import type {
  FocusSnapshot,
  PlanningDayToken,
  ScheduleItem,
  ScheduleSnapshot,
  Task,
  TaskPlanning,
  TaskSnapshot,
  TaskStatus,
} from '../../shared/contracts';
import { INBOX_CONTENT_MAX_LENGTH } from '../../shared/inbox-domain';
import { describeFocusTimer, FOCUS_DURATION_SECONDS, formatFocusTimer } from '../focus-state';
import { formatScheduleInputMinute } from '../schedule-state';
import { toLocalDateKey } from '../task-state';
import { FocusSessionDialog } from './FocusSessionDialog';
import { RollingPlan } from './RollingPlan';

export interface TodayDashboardProps {
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
  focusSnapshot: FocusSnapshot | null;
  focusStatus: 'loading' | 'ready' | 'error';
  focusError: string | null;
  focusOperation: 'start' | 'pause' | 'resume' | 'cancel' | null;
  focusRemainingSeconds: number;
  onCapture: (content: string) => Promise<void>;
  onOpenInbox: () => void;
  onOpenTasks: () => void;
  onRetryTasks: () => void;
  onCreateTask: (planning: PlanningDayToken) => void;
  onOpenTask: (task: Task) => void;
  onUpdateTaskStatus: (taskId: string, status: TaskStatus) => Promise<void>;
  onUpdateTaskPlanning: (taskId: string, planning: TaskPlanning) => Promise<void>;
  onRetrySchedule: () => void;
  onCreateSchedule: (expectedDate: string) => void;
  onOpenSchedule: (item: ScheduleItem) => void;
  onOpenAssistant: () => void;
  onRetryFocus: () => void;
  onStartFocus: (taskId?: string) => Promise<void>;
  onPauseFocus: () => Promise<void>;
  onResumeFocus: () => Promise<void>;
  onCancelFocus: () => Promise<void>;
  onSwitchFocusWorkspace: (workspaceId: string) => void;
  onFocusDialogOpenChange: (open: boolean) => void;
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
  focusSnapshot,
  focusStatus,
  focusError,
  focusOperation,
  focusRemainingSeconds,
  onCapture,
  onOpenInbox,
  onOpenTasks,
  onRetryTasks,
  onCreateTask,
  onOpenTask,
  onUpdateTaskStatus,
  onUpdateTaskPlanning,
  onRetrySchedule,
  onCreateSchedule,
  onOpenSchedule,
  onOpenAssistant,
  onRetryFocus,
  onStartFocus,
  onPauseFocus,
  onResumeFocus,
  onCancelFocus,
  onSwitchFocusWorkspace,
  onFocusDialogOpenChange,
}: TodayDashboardProps) {
  const [capture, setCapture] = useState('');
  const [recentCapture, setRecentCapture] = useState<string | null>(null);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [focusDialogOpen, setFocusDialogOpen] = useState(false);
  const captureLength = Array.from(capture.trim()).length;
  const captureTooLong = captureLength > INBOX_CONTENT_MAX_LENGTH;
  const todayDate =
    taskSnapshot?.todayDate ?? scheduleSnapshot?.todayDate ?? toLocalDateKey(new Date());
  const todayTasks = useMemo(
    () => taskSnapshot?.tasks.filter((task) => task.plannedFor === taskSnapshot.todayDate) ?? [],
    [taskSnapshot],
  );
  const todayScheduleSnapshot =
    scheduleSnapshot && (!taskSnapshot || scheduleSnapshot.todayDate === taskSnapshot.todayDate)
      ? scheduleSnapshot
      : null;
  const scheduleWindowMismatch = scheduleSnapshot !== null && todayScheduleSnapshot === null;
  const todayScheduleItems = useMemo(
    () =>
      todayScheduleSnapshot
        ? scheduleItems.filter(
            ({ scheduledFor }) => scheduledFor === todayScheduleSnapshot.todayDate,
          )
        : [],
    [scheduleItems, todayScheduleSnapshot],
  );
  const remainingTasks = todayTasks.filter(({ status }) => status !== 'completed').length;
  const completedTasks = todayTasks.length - remainingTasks;
  const progress = todayTasks.length === 0 ? 0 : (completedTasks / todayTasks.length) * 100;
  const taskReady = taskSnapshot !== null;
  const unfinishedTodayTasks = todayTasks.filter(({ status }) => status !== 'completed');
  const focusSession = focusSnapshot?.session ?? null;
  const focusSessionIsCurrent =
    focusSession !== null && focusSession.workspaceId === focusSnapshot?.workspaceId;
  const foreignFocusSession = focusSession !== null && !focusSessionIsCurrent ? focusSession : null;
  const focusReady = focusStatus === 'ready' && focusSnapshot !== null;
  const focusBusy = focusOperation !== null;
  const displayedFocusSeconds = focusReady ? focusRemainingSeconds : FOCUS_DURATION_SECONDS;
  const focusAnnouncement = focusStatusMessage(focusSnapshot, focusStatus, focusRemainingSeconds);

  useEffect(
    () => () => {
      onFocusDialogOpenChange(false);
    },
    [onFocusDialogOpenChange],
  );

  const openFocusDialog = () => {
    onFocusDialogOpenChange(true);
    setFocusDialogOpen(true);
  };

  const closeFocusDialog = () => {
    onFocusDialogOpenChange(false);
    setFocusDialogOpen(false);
  };

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
        <div className="dashboard-hero__actions">
          <button type="button" className="assistant-entry-button" onClick={onOpenAssistant}>
            <MessageSquareText size={15} aria-hidden="true" />
            询问 AI 今日安排
          </button>
          <div
            className="streak-pill"
            aria-label={`今日已完成 ${completedTasks} 项，共 ${todayTasks.length} 项`}
          >
            <CheckCircle2 size={16} aria-hidden="true" />
            <span>
              <strong>{taskReady ? `${completedTasks} / ${todayTasks.length}` : '—'}</strong>{' '}
              今日完成
            </span>
          </div>
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
            onClick={() => onCreateTask('day-0')}
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
          <section
            className={`focus-card${focusSession?.status === 'paused' ? ' is-paused' : ''}`}
            aria-labelledby="focus-session-heading"
            aria-busy={focusStatus === 'loading' || focusBusy}
          >
            <div className="focus-card__topline">
              <span id="focus-session-heading">
                <Target size={14} /> 专注模式
              </span>
              <small>
                今日完成 {focusSnapshot?.todayCompletedCount ?? 0} 轮 ·{' '}
                {FOCUS_DURATION_SECONDS / 60} 分钟
              </small>
            </div>
            <h2>
              <span
                role="timer"
                aria-live="off"
                aria-label={
                  focusReady ? describeFocusTimer(displayedFocusSeconds) : '专注计时器正在同步'
                }
              >
                {focusReady ? formatFocusTimer(displayedFocusSeconds) : '––:––'}
              </span>
            </h2>

            {focusStatus === 'loading' && !focusSnapshot ? (
              <p className="focus-card__state">
                <LoaderCircle className="is-spinning" size={13} aria-hidden="true" />
                正在同步专注会话…
              </p>
            ) : focusStatus === 'error' && !focusSnapshot ? (
              <div className="focus-card__error" role="alert">
                <span>{focusError ?? '专注会话暂时无法读取。'}</span>
                <button type="button" onClick={onRetryFocus}>
                  重试
                </button>
              </div>
            ) : foreignFocusSession ? (
              <>
                <p>
                  <strong>{foreignFocusSession.workspaceName}</strong>{' '}
                  {foreignFocusSession.status === 'paused' ? '专注已暂停' : '正在专注'}
                  {foreignFocusSession.taskTitle ? ` · ${foreignFocusSession.taskTitle}` : ''}。
                </p>
                <div className="focus-card__actions">
                  <button
                    type="button"
                    onClick={() => onSwitchFocusWorkspace(foreignFocusSession.workspaceId)}
                  >
                    <LogIn size={14} aria-hidden="true" />
                    切换到该工作区
                  </button>
                </div>
              </>
            ) : focusSession && focusSessionIsCurrent ? (
              <>
                <p>
                  {focusSession.taskTitle ? (
                    <>
                      当前任务：<strong>{focusSession.taskTitle}</strong>
                    </>
                  ) : focusSession.status === 'paused' ? (
                    '本轮专注已暂停，可以稍后继续。'
                  ) : (
                    '保持节奏，暂时忽略其他事情。'
                  )}
                </p>
                <div className="focus-card__actions">
                  {focusSession.status === 'running' ? (
                    <button
                      type="button"
                      onClick={() => void onPauseFocus().catch(() => undefined)}
                      disabled={focusBusy}
                    >
                      {focusOperation === 'pause' ? (
                        <LoaderCircle className="is-spinning" size={14} aria-hidden="true" />
                      ) : (
                        <Pause size={14} fill="currentColor" aria-hidden="true" />
                      )}
                      {focusOperation === 'pause' ? '暂停中…' : '暂停'}
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => void onResumeFocus().catch(() => undefined)}
                      disabled={focusBusy}
                    >
                      {focusOperation === 'resume' ? (
                        <LoaderCircle className="is-spinning" size={14} aria-hidden="true" />
                      ) : (
                        <Play size={14} fill="currentColor" aria-hidden="true" />
                      )}
                      {focusOperation === 'resume' ? '继续中…' : '继续'}
                    </button>
                  )}
                  <button
                    type="button"
                    className="focus-card__cancel"
                    onClick={() => void onCancelFocus().catch(() => undefined)}
                    disabled={focusBusy}
                  >
                    {focusOperation === 'cancel' ? (
                      <LoaderCircle className="is-spinning" size={14} aria-hidden="true" />
                    ) : (
                      <XCircle size={14} aria-hidden="true" />
                    )}
                    {focusOperation === 'cancel' ? '取消中…' : '取消本轮'}
                  </button>
                </div>
              </>
            ) : (
              <>
                <p>
                  {remainingTasks > 0
                    ? `可从 ${remainingTasks} 项今日任务中选择一项，或开始自由专注。`
                    : '今天没有未完成任务，仍可开始一轮自由专注。'}
                </p>
                <div className="focus-card__actions">
                  <button
                    type="button"
                    onClick={openFocusDialog}
                    disabled={!focusReady || focusBusy}
                  >
                    <Play size={14} fill="currentColor" aria-hidden="true" />
                    开始专注
                  </button>
                </div>
              </>
            )}

            {focusError && focusSnapshot ? (
              <p className="focus-card__operation-error" role="alert">
                {focusError}
              </p>
            ) : null}
            <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
              {focusAnnouncement}
            </p>
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
                onClick={() =>
                  todayScheduleSnapshot && onCreateSchedule(todayScheduleSnapshot.todayDate)
                }
                disabled={scheduleCreatePending || !todayScheduleSnapshot}
                aria-label="添加今日日程"
              >
                {scheduleCreatePending ? (
                  <LoaderCircle className="is-spinning" size={14} />
                ) : (
                  <Plus size={14} />
                )}
              </button>
            </div>
            {scheduleOperationError && todayScheduleSnapshot ? (
              <p className="agenda-card__error" role="alert">
                {scheduleOperationError}
              </p>
            ) : null}
            {(scheduleStatus === 'loading' && !todayScheduleSnapshot) || scheduleWindowMismatch ? (
              <div className="agenda-card__state" aria-live="polite">
                <LoaderCircle className="is-spinning" size={16} /> 正在同步日程…
              </div>
            ) : scheduleStatus === 'error' && !todayScheduleSnapshot ? (
              <div className="agenda-card__state is-error" role="alert">
                <span>{scheduleLoadError ?? '今日日程暂时无法读取。'}</span>
                <button type="button" onClick={onRetrySchedule}>
                  重试
                </button>
              </div>
            ) : todayScheduleSnapshot && todayScheduleItems.length > 0 ? (
              <div className="agenda-list">
                {todayScheduleItems.map((item) => {
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
                <button
                  type="button"
                  onClick={() =>
                    todayScheduleSnapshot && onCreateSchedule(todayScheduleSnapshot.todayDate)
                  }
                  disabled={!todayScheduleSnapshot}
                >
                  <Plus size={13} /> 添加日程
                </button>
              </div>
            )}
            {todayScheduleSnapshot && todayScheduleItems.length > 0 ? (
              <div className="agenda-footer">
                <CalendarClock size={13} /> {todayScheduleItems.length} 段本地日程
              </div>
            ) : null}
          </section>
        </div>
      </div>
      <RollingPlan
        taskSnapshot={taskSnapshot}
        scheduleSnapshot={scheduleSnapshot}
        taskStatus={taskStatus}
        scheduleStatus={scheduleStatus}
        taskError={taskLoadError}
        scheduleError={scheduleLoadError}
        pendingTaskIds={pendingTaskIds}
        pendingScheduleItemIds={pendingScheduleItemIds}
        taskCreatePending={taskCreatePending}
        scheduleCreatePending={scheduleCreatePending}
        onRetryTasks={onRetryTasks}
        onRetrySchedule={onRetrySchedule}
        onCreateTask={onCreateTask}
        onOpenTask={onOpenTask}
        onUpdateTaskStatus={onUpdateTaskStatus}
        onUpdateTaskPlanning={onUpdateTaskPlanning}
        onCreateSchedule={onCreateSchedule}
        onOpenSchedule={onOpenSchedule}
      />
      {focusDialogOpen ? (
        <FocusSessionDialog
          tasks={unfinishedTodayTasks}
          onClose={closeFocusDialog}
          onStart={onStartFocus}
        />
      ) : null}
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

function focusStatusMessage(
  snapshot: FocusSnapshot | null,
  status: TodayDashboardProps['focusStatus'],
  remainingSeconds: number,
): string {
  if (status === 'loading') return '正在同步专注会话。';
  if (status === 'error' && !snapshot) return '专注会话暂时不可用。';
  const session = snapshot?.session;
  if (!session) {
    return `当前没有专注会话，今天已完成 ${snapshot?.todayCompletedCount ?? 0} 轮。`;
  }
  const task = session.taskTitle ? `，任务：${session.taskTitle}` : '';
  const workspace =
    session.workspaceId === snapshot?.workspaceId ? '' : `，工作区：${session.workspaceName}`;
  if (session.status === 'paused') {
    return `专注会话已暂停${workspace}${task}。`;
  }
  if (remainingSeconds === 0) return `专注时间已结束${workspace}${task}。`;
  return `专注会话进行中${workspace}${task}。`;
}
