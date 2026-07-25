import { ChevronDown, ChevronUp, Circle, History, LoaderCircle } from 'lucide-react';
import { useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { Task, TaskPlanning, TaskSnapshot } from '../../shared/contracts';
import {
  nextOverdueTaskId,
  overdueTaskReviewIdentity,
  OVERDUE_TASK_PREVIEW_LIMIT,
  OverdueTaskActionGate,
  selectOverdueTasks,
} from '../overdue-task-state';
import { planningDayLabel } from '../planning-state';

type TaskMutationResult = boolean | void;

interface OverdueTaskReviewProps {
  readonly snapshot: TaskSnapshot | null;
  readonly pendingTaskIds: ReadonlySet<string>;
  readonly fallbackFocusRef: RefObject<HTMLElement | null>;
  readonly onOpenTask: (task: Task) => void;
  readonly onUpdateTaskStatus: (taskId: string, status: 'completed') => Promise<TaskMutationResult>;
  readonly onUpdateTaskPlanning: (
    taskId: string,
    planning: TaskPlanning,
  ) => Promise<TaskMutationResult>;
}

export function OverdueTaskReview({
  snapshot,
  pendingTaskIds,
  fallbackFocusRef,
  onOpenTask,
  onUpdateTaskStatus,
  onUpdateTaskPlanning,
}: OverdueTaskReviewProps) {
  const tasks = useMemo(() => selectOverdueTasks(snapshot), [snapshot]);
  const identity = overdueTaskReviewIdentity(snapshot);
  const identityRef = useRef(identity);
  const rowRefs = useRef(new Map<string, HTMLLIElement>());
  const [actionGate] = useState(() => new OverdueTaskActionGate());
  const [expansion, setExpansion] = useState<{
    readonly identity: string | null;
    readonly expanded: boolean;
  }>({ identity: null, expanded: false });
  const [announcement, setAnnouncement] = useState<{
    readonly sequence: number;
    readonly message: string;
  }>({ sequence: 0, message: '' });
  const [liveRegionActive, setLiveRegionActive] = useState(false);
  const expanded = expansion.identity === identity && expansion.expanded;
  const visibleTasks = expanded ? tasks : tasks.slice(0, OVERDUE_TASK_PREVIEW_LIMIT);
  const hiddenCount = Math.max(0, tasks.length - visibleTasks.length);

  useLayoutEffect(() => {
    identityRef.current = identity;
    return () => {
      identityRef.current = null;
    };
  }, [identity]);

  const runAction = async (
    task: Task,
    action: () => Promise<TaskMutationResult>,
    successMessage: string,
  ) => {
    if (!identity || !actionGate.begin(task.id)) return;
    setLiveRegionActive(true);
    const actionIdentity = identity;
    const nextTaskId = nextOverdueTaskId(tasks, task.id);
    try {
      const applied = await action();
      if (applied === false || identityRef.current !== actionIdentity) return;
      setAnnouncement((current) => ({
        sequence: current.sequence + 1,
        message: successMessage,
      }));
      window.requestAnimationFrame(() => {
        if (identityRef.current !== actionIdentity) return;
        const nextRow = nextTaskId ? rowRefs.current.get(nextTaskId) : null;
        (nextRow ?? fallbackFocusRef.current)?.focus({ preventScroll: true });
      });
    } catch {
      // The active task surface publishes one alert; keep keyboard focus with the failed row.
      window.requestAnimationFrame(() => {
        if (identityRef.current !== actionIdentity) return;
        rowRefs.current.get(task.id)?.focus({ preventScroll: true });
      });
    } finally {
      actionGate.end(task.id);
    }
  };

  if (!snapshot || (tasks.length === 0 && !liveRegionActive)) return null;

  return (
    <>
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {announcement.message ? (
          <span key={announcement.sequence}>{announcement.message}</span>
        ) : null}
      </p>
      {tasks.length > 0 ? (
        <section
          className="overdue-task-review"
          aria-labelledby="overdue-task-review-heading"
          data-overdue-task-identity={identity ?? undefined}
        >
          <header className="overdue-task-review__header">
            <span className="overdue-task-review__icon">
              <History size={17} aria-hidden="true" />
            </span>
            <div>
              <h3 id="overdue-task-review-heading">待重新安排</h3>
              <p>{tasks.length} 项任务仍保留旧计划；逐项决定下一步，不会自动顺延。</p>
            </div>
            {tasks.length > OVERDUE_TASK_PREVIEW_LIMIT ? (
              <button
                type="button"
                className="overdue-task-review__expand"
                aria-controls="overdue-task-review-list"
                aria-expanded={expanded}
                onClick={() =>
                  setExpansion({
                    identity,
                    expanded: !expanded,
                  })
                }
              >
                {expanded ? (
                  <>
                    <ChevronUp size={14} aria-hidden="true" /> 收起
                  </>
                ) : (
                  <>
                    <ChevronDown size={14} aria-hidden="true" />
                    展开其余 {hiddenCount} 项
                  </>
                )}
              </button>
            ) : null}
          </header>

          <ul id="overdue-task-review-list" aria-label="待重新安排的任务">
            {visibleTasks.map((task) => {
              const pending = pendingTaskIds.has(task.id);
              const originalDate = overdueDateLabel(task.plannedFor!, snapshot.todayDate);
              return (
                <li
                  ref={(element) => {
                    if (element) rowRefs.current.set(task.id, element);
                    else rowRefs.current.delete(task.id);
                  }}
                  key={task.id}
                  tabIndex={-1}
                  aria-busy={pending}
                  data-overdue-task-id={task.id}
                >
                  <button
                    type="button"
                    className="overdue-task-review__complete"
                    aria-label={`完成遗留任务：${task.title}`}
                    disabled={pending}
                    onClick={() =>
                      void runAction(
                        task,
                        () => onUpdateTaskStatus(task.id, 'completed'),
                        `已完成任务“${task.title}”。`,
                      )
                    }
                  >
                    {pending ? (
                      <LoaderCircle className="is-spinning" size={17} aria-hidden="true" />
                    ) : (
                      <Circle size={17} aria-hidden="true" />
                    )}
                  </button>
                  <button
                    type="button"
                    className="overdue-task-review__title"
                    disabled={pending}
                    onClick={() => onOpenTask(task)}
                  >
                    <strong>{task.title}</strong>
                    <small>
                      原计划{' '}
                      <time dateTime={task.plannedFor!} aria-label={`原计划 ${originalDate}`}>
                        {originalDate}
                      </time>
                    </small>
                  </button>
                  <label className="overdue-task-review__planning">
                    <span className="sr-only">重新安排“{task.title}”</span>
                    <select
                      value=""
                      disabled={pending}
                      aria-label={`重新安排：${task.title}`}
                      onChange={(event) => {
                        const planning = event.target.value;
                        if (
                          planning !== 'none' &&
                          !snapshot.planningDays.some(({ token }) => token === planning)
                        ) {
                          return;
                        }
                        const typedPlanning = planning as TaskPlanning;
                        const destination =
                          typedPlanning === 'none'
                            ? '移出计划'
                            : planningDayLabel(
                                snapshot.planningDays.find(({ token }) => token === typedPlanning)!,
                              ).accessible;
                        void runAction(
                          task,
                          () => onUpdateTaskPlanning(task.id, typedPlanning),
                          typedPlanning === 'none'
                            ? `已将任务“${task.title}”移出计划。`
                            : `已将任务“${task.title}”安排到${destination}。`,
                        );
                      }}
                    >
                      <option value="" disabled hidden>
                        选择新安排
                      </option>
                      {snapshot.planningDays.map((day) => {
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
                  <span className="overdue-task-review__status" aria-hidden="true">
                    {pending ? '更新中' : '等待决定'}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
    </>
  );
}

function overdueDateLabel(value: string, todayDate: string): string {
  const label = planningDayLabel({ token: 'day-1', date: value }).date;
  return value.slice(0, 4) === todayDate.slice(0, 4) ? label : `${value.slice(0, 4)}年${label}`;
}
