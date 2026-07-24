import {
  CalendarClock,
  CalendarDays,
  CheckCircle2,
  Circle,
  LoaderCircle,
  Plus,
} from 'lucide-react';
import { useMemo, useState, type KeyboardEvent } from 'react';
import type {
  PlanningDayToken,
  ScheduleItem,
  ScheduleSnapshot,
  Task,
  TaskPlanning,
  TaskSnapshot,
  TaskStatus,
} from '../../shared/contracts';
import { planningDayLabel, planningSnapshotsMatch, planningTokenAt } from '../planning-state';
import { formatScheduleInputMinute, sortScheduleItems } from '../schedule-state';

interface RollingPlanProps {
  taskSnapshot: TaskSnapshot | null;
  scheduleSnapshot: ScheduleSnapshot | null;
  taskStatus: 'loading' | 'ready' | 'error';
  scheduleStatus: 'loading' | 'ready' | 'error';
  taskError: string | null;
  scheduleError: string | null;
  pendingTaskIds: ReadonlySet<string>;
  pendingScheduleItemIds: ReadonlySet<string>;
  taskCreatePending: boolean;
  scheduleCreatePending: boolean;
  onRetryTasks: () => void;
  onRetrySchedule: () => void;
  onCreateTask: (planning: PlanningDayToken) => void;
  onOpenTask: (task: Task) => void;
  onUpdateTaskStatus: (taskId: string, status: TaskStatus) => Promise<void>;
  onUpdateTaskPlanning: (taskId: string, planning: TaskPlanning) => Promise<void>;
  onCreateSchedule: (expectedDate: string) => void;
  onOpenSchedule: (item: ScheduleItem) => void;
}

export function RollingPlan({
  taskSnapshot,
  scheduleSnapshot,
  taskStatus,
  scheduleStatus,
  taskError,
  scheduleError,
  pendingTaskIds,
  pendingScheduleItemIds,
  taskCreatePending,
  scheduleCreatePending,
  onRetryTasks,
  onRetrySchedule,
  onCreateTask,
  onOpenTask,
  onUpdateTaskStatus,
  onUpdateTaskPlanning,
  onCreateSchedule,
  onOpenSchedule,
}: RollingPlanProps) {
  const snapshotsMatch = planningSnapshotsMatch(taskSnapshot, scheduleSnapshot);
  const planningIdentity = snapshotsMatch
    ? `${taskSnapshot!.workspaceId}:${taskSnapshot!.todayDate}`
    : null;
  const [selection, setSelection] = useState<{
    readonly identity: string | null;
    readonly token: PlanningDayToken;
  }>({ identity: null, token: 'day-0' });
  const selectedToken = selection.identity === planningIdentity ? selection.token : 'day-0';
  const planningDays = snapshotsMatch ? taskSnapshot!.planningDays : [];
  const selectedIndex = Math.max(
    0,
    planningDays.findIndex(({ token }) => token === selectedToken),
  );
  const selectedDay = planningDays[selectedIndex] ?? null;
  const selectedTasks = useMemo(
    () =>
      selectedDay && taskSnapshot
        ? taskSnapshot.tasks.filter(({ plannedFor }) => plannedFor === selectedDay.date)
        : [],
    [selectedDay, taskSnapshot],
  );
  const selectedScheduleItems = useMemo(
    () =>
      selectedDay && scheduleSnapshot
        ? sortScheduleItems(
            scheduleSnapshot.items.filter(({ scheduledFor }) => scheduledFor === selectedDay.date),
          )
        : [],
    [scheduleSnapshot, selectedDay],
  );
  const hasError = taskStatus === 'error' || scheduleStatus === 'error';
  const hasStalePair =
    !hasError &&
    taskStatus === 'ready' &&
    scheduleStatus === 'ready' &&
    taskSnapshot !== null &&
    scheduleSnapshot !== null &&
    !snapshotsMatch;

  const selectDayAt = (index: number, event?: KeyboardEvent<HTMLButtonElement>) => {
    const token = planningTokenAt(planningDays, index);
    setSelection({ identity: planningIdentity, token });
    if (event) {
      const tablist = event.currentTarget.parentElement;
      window.requestAnimationFrame(() => {
        tablist?.querySelector<HTMLButtonElement>(`#rolling-plan-tab-${token}`)?.focus();
      });
    }
  };

  const handleDayKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let targetIndex: number | null = null;
    if (event.key === 'ArrowLeft') targetIndex = index - 1;
    else if (event.key === 'ArrowRight') targetIndex = index + 1;
    else if (event.key === 'Home') targetIndex = 0;
    else if (event.key === 'End') targetIndex = planningDays.length - 1;
    if (targetIndex === null) return;
    event.preventDefault();
    selectDayAt(
      event.key === 'ArrowLeft' || event.key === 'ArrowRight'
        ? (targetIndex + planningDays.length) % planningDays.length
        : targetIndex,
      event,
    );
  };

  return (
    <section className="rolling-plan" aria-labelledby="rolling-plan-heading">
      <header className="rolling-plan__header">
        <div>
          <span>
            <CalendarDays size={14} aria-hidden="true" /> 接下来 7 天
          </span>
          <h2 id="rolling-plan-heading">滚动计划</h2>
          <p>任务与日程共用同一日期窗口；每天午夜由本机重新对账。</p>
        </div>
        {selectedDay ? (
          <div className="rolling-plan__actions">
            <button
              type="button"
              onClick={() => onCreateTask(selectedDay.token)}
              disabled={taskCreatePending}
            >
              {taskCreatePending ? (
                <LoaderCircle className="is-spinning" size={14} />
              ) : (
                <Plus size={14} />
              )}
              添加任务
            </button>
            <button
              type="button"
              onClick={() => onCreateSchedule(selectedDay.date)}
              disabled={scheduleCreatePending}
            >
              {scheduleCreatePending ? (
                <LoaderCircle className="is-spinning" size={14} />
              ) : (
                <CalendarClock size={14} />
              )}
              添加日程
            </button>
          </div>
        ) : null}
      </header>

      {snapshotsMatch ? (
        <>
          <div className="rolling-plan__days" role="tablist" aria-label="选择计划日期">
            {planningDays.map((day, index) => {
              const label = planningDayLabel(day);
              const selected = day.token === selectedDay?.token;
              const taskCount =
                taskSnapshot?.tasks.filter(({ plannedFor }) => plannedFor === day.date).length ?? 0;
              const scheduleCount =
                scheduleSnapshot?.items.filter(({ scheduledFor }) => scheduledFor === day.date)
                  .length ?? 0;
              return (
                <button
                  type="button"
                  role="tab"
                  id={`rolling-plan-tab-${day.token}`}
                  aria-controls="rolling-plan-panel"
                  aria-selected={selected}
                  aria-label={`${label.accessible}，${taskCount} 项任务，${scheduleCount} 段日程`}
                  tabIndex={selected ? 0 : -1}
                  className={selected ? 'is-selected' : ''}
                  key={day.token}
                  onClick={() => selectDayAt(index)}
                  onKeyDown={(event) => handleDayKeyDown(event, index)}
                >
                  <strong>{label.short}</strong>
                  <span>{label.date}</span>
                  <small>{taskCount + scheduleCount || '—'}</small>
                </button>
              );
            })}
          </div>

          <div
            className="rolling-plan__content"
            id="rolling-plan-panel"
            role="tabpanel"
            aria-labelledby={`rolling-plan-tab-${selectedDay?.token ?? 'day-0'}`}
          >
            <PlanningTaskList
              tasks={selectedTasks}
              planningDays={planningDays}
              pendingTaskIds={pendingTaskIds}
              onOpenTask={onOpenTask}
              onUpdateTaskStatus={onUpdateTaskStatus}
              onUpdateTaskPlanning={onUpdateTaskPlanning}
            />
            <PlanningScheduleList
              items={selectedScheduleItems}
              pendingItemIds={pendingScheduleItemIds}
              onOpenSchedule={onOpenSchedule}
            />
          </div>
        </>
      ) : (
        <div
          className={`rolling-plan__state${hasError || hasStalePair ? ' is-error' : ''}`}
          role={hasError || hasStalePair ? 'alert' : 'status'}
        >
          {hasError || hasStalePair ? (
            <>
              <strong>7 日计划暂时无法对齐</strong>
              <span>
                {hasStalePair
                  ? '任务与日程的日期窗口不一致，请重新读取。'
                  : (taskError ?? scheduleError ?? '请稍后重试。')}
              </span>
              <button
                type="button"
                onClick={() => {
                  onRetryTasks();
                  onRetrySchedule();
                }}
              >
                重新加载
              </button>
            </>
          ) : (
            <>
              <LoaderCircle className="is-spinning" size={18} aria-hidden="true" />
              <span>正在同步 7 日任务与日程…</span>
            </>
          )}
        </div>
      )}
    </section>
  );
}

function PlanningTaskList({
  tasks,
  planningDays,
  pendingTaskIds,
  onOpenTask,
  onUpdateTaskStatus,
  onUpdateTaskPlanning,
}: {
  tasks: readonly Task[];
  planningDays: TaskSnapshot['planningDays'];
  pendingTaskIds: ReadonlySet<string>;
  onOpenTask: (task: Task) => void;
  onUpdateTaskStatus: (taskId: string, status: TaskStatus) => Promise<void>;
  onUpdateTaskPlanning: (taskId: string, planning: TaskPlanning) => Promise<void>;
}) {
  return (
    <section className="rolling-plan__column" aria-labelledby="rolling-plan-tasks-heading">
      <header>
        <h3 id="rolling-plan-tasks-heading">任务</h3>
        <small>{tasks.length} 项</small>
      </header>
      {tasks.length > 0 ? (
        <ul>
          {tasks.map((task) => {
            const pending = pendingTaskIds.has(task.id);
            const completed = task.status === 'completed';
            return (
              <li className={completed ? 'is-completed' : ''} key={task.id}>
                <button
                  type="button"
                  className="rolling-plan__task-toggle"
                  aria-label={completed ? `重新打开：${task.title}` : `完成：${task.title}`}
                  disabled={pending}
                  onClick={() =>
                    void onUpdateTaskStatus(task.id, completed ? 'todo' : 'completed').catch(
                      () => undefined,
                    )
                  }
                >
                  {pending ? (
                    <LoaderCircle className="is-spinning" size={17} />
                  ) : completed ? (
                    <CheckCircle2 size={17} />
                  ) : (
                    <Circle size={17} />
                  )}
                </button>
                <button
                  type="button"
                  className="rolling-plan__item-title"
                  disabled={pending}
                  onClick={() => onOpenTask(task)}
                >
                  {task.title}
                </button>
                <label>
                  <span className="sr-only">修改“{task.title}”的安排</span>
                  <select
                    value={
                      planningDays.find(({ date }) => date === task.plannedFor)?.token ?? 'none'
                    }
                    disabled={pending}
                    onChange={(event) =>
                      void onUpdateTaskPlanning(task.id, event.target.value as TaskPlanning).catch(
                        () => undefined,
                      )
                    }
                  >
                    {planningDays.map((day) => {
                      const label = planningDayLabel(day);
                      return (
                        <option value={day.token} key={day.token}>
                          {label.short} · {label.date}
                        </option>
                      );
                    })}
                    <option value="none">移出计划</option>
                  </select>
                </label>
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="rolling-plan__empty">
          <CheckCircle2 size={18} />
          <span>这一天还没有任务。</span>
        </div>
      )}
    </section>
  );
}

function PlanningScheduleList({
  items,
  pendingItemIds,
  onOpenSchedule,
}: {
  items: readonly ScheduleItem[];
  pendingItemIds: ReadonlySet<string>;
  onOpenSchedule: (item: ScheduleItem) => void;
}) {
  return (
    <section className="rolling-plan__column" aria-labelledby="rolling-plan-schedule-heading">
      <header>
        <h3 id="rolling-plan-schedule-heading">日程</h3>
        <small>{items.length} 段</small>
      </header>
      {items.length > 0 ? (
        <ul>
          {items.map((item) => {
            const pending = pendingItemIds.has(item.id);
            return (
              <li key={item.id}>
                <span className={`agenda-row__line agenda-row__line--${item.kind}`} />
                <button
                  type="button"
                  className="rolling-plan__item-title"
                  disabled={pending}
                  onClick={() => onOpenSchedule(item)}
                  aria-label={`编辑日程：${item.title}，${formatScheduleInputMinute(item.startMinute)} 到 ${formatScheduleInputMinute(item.endMinute)}`}
                >
                  <strong>{item.title}</strong>
                  <small>
                    {formatScheduleInputMinute(item.startMinute)}–
                    {formatScheduleInputMinute(item.endMinute)}
                  </small>
                </button>
                {pending ? <LoaderCircle className="is-spinning" size={14} /> : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="rolling-plan__empty">
          <CalendarClock size={18} />
          <span>这一天还没有日程。</span>
        </div>
      )}
    </section>
  );
}
