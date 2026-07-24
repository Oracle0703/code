import { useMemo, useState } from 'react';
import {
  CalendarDays,
  Check,
  CheckCircle2,
  CheckSquare2,
  Circle,
  Inbox,
  LoaderCircle,
  MessageSquareText,
  Pencil,
  Plus,
  Search,
  Sparkles,
  Square,
} from 'lucide-react';
import type { Task, TaskPlanning, TaskSnapshot, TaskStatus } from '../../shared/contracts';
import { filterTasks, type TaskFilter } from '../task-state';

interface TaskPageProps {
  snapshot: TaskSnapshot | null;
  tasks: readonly Task[];
  status: 'loading' | 'ready' | 'error';
  loadError: string | null;
  operationError: string | null;
  pendingTaskIds: ReadonlySet<string>;
  onRetry: () => void;
  onOpenCreate: () => void;
  onOpenRename: (task: Task) => void;
  onUpdateStatus: (taskId: string, status: TaskStatus) => Promise<void>;
  onUpdatePlanning: (taskId: string, planning: TaskPlanning) => Promise<void>;
  assistantTaskLimit: number;
  onOpenAssistant: (tasks: readonly Task[]) => void;
}

const filters: readonly { id: TaskFilter; label: string }[] = [
  { id: 'open', label: '待完成' },
  { id: 'today', label: '今天' },
  { id: 'completed', label: '已完成' },
  { id: 'all', label: '全部' },
];

const statusLabels: Record<TaskStatus, string> = {
  todo: '待办',
  in_progress: '进行中',
  completed: '已完成',
};

export function TaskPage({
  snapshot,
  tasks,
  status,
  loadError,
  operationError,
  pendingTaskIds,
  onRetry,
  onOpenCreate,
  onOpenRename,
  onUpdateStatus,
  onUpdatePlanning,
  assistantTaskLimit,
  onOpenAssistant,
}: TaskPageProps) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<TaskFilter>('open');
  const [assistantSelectionOpen, setAssistantSelectionOpen] = useState(false);
  const [selectedTaskIds, setSelectedTaskIds] = useState<ReadonlySet<string>>(() => new Set());
  const todayDate = snapshot?.todayDate ?? '';
  const visibleTasks = useMemo(
    () => filterTasks(tasks, filter, query, todayDate),
    [filter, query, tasks, todayDate],
  );
  const openCount = tasks.filter(({ status: taskStatus }) => taskStatus !== 'completed').length;
  const effectiveSelectedTaskIds = useMemo(() => {
    const eligibleIds = new Set(
      tasks.filter(({ status: taskStatus }) => taskStatus !== 'completed').map(({ id }) => id),
    );
    return new Set(
      [...selectedTaskIds].filter((id) => eligibleIds.has(id)).slice(0, assistantTaskLimit),
    );
  }, [assistantTaskLimit, selectedTaskIds, tasks]);
  const selectedTasks = tasks.filter(({ id, status: taskStatus }) => {
    return taskStatus !== 'completed' && effectiveSelectedTaskIds.has(id);
  });

  const toggleAssistantTask = (taskId: string) => {
    setSelectedTaskIds(() => {
      const next = new Set(effectiveSelectedTaskIds);
      if (next.has(taskId)) {
        next.delete(taskId);
      } else if (next.size < assistantTaskLimit) {
        next.add(taskId);
      }
      return next;
    });
  };

  const closeAssistantSelection = () => {
    setAssistantSelectionOpen(false);
    setSelectedTaskIds(new Set());
  };

  return (
    <div className="section-page task-page" aria-busy={status === 'loading'}>
      <header className="section-page__header">
        <div className="section-page__title">
          <span>
            <CheckSquare2 size={20} />
          </span>
          <div>
            <h1 tabIndex={-1}>任务</h1>
            <p>{snapshot ? `${openCount} 项待完成` : '按工作区推进下一步。'}</p>
          </div>
        </div>
        <div className="section-page__header-actions">
          <button
            type="button"
            className="secondary-button"
            aria-pressed={assistantSelectionOpen}
            onClick={() => {
              if (assistantSelectionOpen) closeAssistantSelection();
              else setAssistantSelectionOpen(true);
            }}
          >
            <MessageSquareText size={15} />{' '}
            {assistantSelectionOpen ? '取消选择' : '选择任务询问 AI'}
          </button>
          <button type="button" className="primary-button" onClick={onOpenCreate}>
            <Plus size={15} /> 新建任务
          </button>
        </div>
      </header>

      {status === 'error' ? (
        <section className="task-state" role="alert">
          <CheckSquare2 size={24} />
          <h2>任务暂时无法读取</h2>
          <p>{loadError ?? '请稍后重试。'}</p>
          <button type="button" className="secondary-button" onClick={onRetry}>
            重新加载
          </button>
        </section>
      ) : status === 'loading' ? (
        <section className="task-state">
          <LoaderCircle className="is-spinning" size={24} />
          <h2>正在读取任务</h2>
          <p>正在从当前工作区的 SQLite 数据中加载任务…</p>
        </section>
      ) : (
        <section className="task-view">
          <div className="page-toolbar task-toolbar">
            <label className="page-search">
              <Search size={15} aria-hidden="true" />
              <span className="sr-only">搜索任务</span>
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索任务标题"
              />
            </label>
          </div>

          <div className="task-filters" role="group" aria-label="任务筛选">
            {filters.map(({ id, label }) => {
              const count = filterTasks(tasks, id, '', todayDate).length;
              return (
                <button
                  type="button"
                  key={id}
                  className={filter === id ? 'is-active' : ''}
                  aria-pressed={filter === id}
                  onClick={() => setFilter(id)}
                >
                  {label} <small>{count}</small>
                </button>
              );
            })}
          </div>

          {assistantSelectionOpen ? (
            <div className="task-assistant-selection">
              <span role="status" aria-live="polite">
                选择未完成任务作为本次上下文（最多 {assistantTaskLimit} 项）。已选{' '}
                {selectedTasks.length} 项。
              </span>
              <button
                type="button"
                className="primary-button"
                disabled={selectedTasks.length === 0}
                onClick={() => {
                  onOpenAssistant(selectedTasks);
                  closeAssistantSelection();
                }}
              >
                <MessageSquareText size={14} /> 带入 AI 助手
              </button>
            </div>
          ) : null}

          {operationError ? (
            <p className="task-operation-error" role="alert">
              {operationError}
            </p>
          ) : null}

          {visibleTasks.length > 0 ? (
            <ul className="task-page-list" aria-label="任务列表">
              {visibleTasks.map((task) => {
                const pending = pendingTaskIds.has(task.id);
                const completed = task.status === 'completed';
                return (
                  <li className={`task-page-row${completed ? ' is-completed' : ''}`} key={task.id}>
                    <button
                      type="button"
                      className="task-page-row__toggle"
                      aria-label={
                        assistantSelectionOpen
                          ? completed
                            ? `不能选择已完成任务：${task.title}`
                            : effectiveSelectedTaskIds.has(task.id)
                              ? `取消选择：${task.title}`
                              : `选择任务：${task.title}`
                          : completed
                            ? `重新打开：${task.title}`
                            : `完成：${task.title}`
                      }
                      aria-pressed={
                        assistantSelectionOpen && !completed
                          ? effectiveSelectedTaskIds.has(task.id)
                          : undefined
                      }
                      disabled={
                        pending ||
                        (assistantSelectionOpen &&
                          (completed ||
                            (!effectiveSelectedTaskIds.has(task.id) &&
                              effectiveSelectedTaskIds.size >= assistantTaskLimit)))
                      }
                      onClick={() => {
                        if (assistantSelectionOpen) {
                          toggleAssistantTask(task.id);
                          return;
                        }
                        void onUpdateStatus(task.id, completed ? 'todo' : 'completed').catch(
                          () => undefined,
                        );
                      }}
                    >
                      {pending ? (
                        <LoaderCircle className="is-spinning" size={19} />
                      ) : assistantSelectionOpen ? (
                        effectiveSelectedTaskIds.has(task.id) ? (
                          <CheckSquare2 size={19} />
                        ) : (
                          <Square size={19} />
                        )
                      ) : completed ? (
                        <CheckCircle2 size={19} />
                      ) : (
                        <Circle size={19} />
                      )}
                    </button>

                    <button
                      type="button"
                      className="task-page-row__title"
                      disabled={pending || assistantSelectionOpen}
                      onClick={() => onOpenRename(task)}
                    >
                      <strong>{task.title}</strong>
                      <span>
                        {task.sourceInboxEntryId ? (
                          <small className="task-source-chip">
                            <Inbox size={11} /> 来自收件箱
                          </small>
                        ) : null}
                        {task.plannedFor ? (
                          <small className="task-date-chip">
                            <CalendarDays size={11} />{' '}
                            {formatPlannedDate(task.plannedFor, todayDate)}
                          </small>
                        ) : null}
                      </span>
                    </button>

                    <label className="task-page-row__select">
                      <span className="sr-only">修改“{task.title}”的状态</span>
                      <select
                        value={task.status}
                        disabled={pending || assistantSelectionOpen}
                        onChange={(event) =>
                          void onUpdateStatus(task.id, event.target.value as TaskStatus).catch(
                            () => undefined,
                          )
                        }
                      >
                        {Object.entries(statusLabels).map(([value, label]) => (
                          <option value={value} key={value}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </label>

                    <label className="task-page-row__select">
                      <span className="sr-only">修改“{task.title}”的安排</span>
                      <select
                        value={planningValue(task, todayDate)}
                        disabled={pending || assistantSelectionOpen}
                        onChange={(event) =>
                          void onUpdatePlanning(task.id, event.target.value as TaskPlanning).catch(
                            () => undefined,
                          )
                        }
                      >
                        {task.plannedFor && task.plannedFor !== todayDate ? (
                          <option value="past" disabled>
                            原计划 {formatShortDate(task.plannedFor)}
                          </option>
                        ) : null}
                        <option value="today">今天</option>
                        <option value="none">不安排</option>
                      </select>
                    </label>

                    <button
                      type="button"
                      className="task-page-row__edit"
                      aria-label={`编辑：${task.title}`}
                      disabled={pending || assistantSelectionOpen}
                      onClick={() => onOpenRename(task)}
                    >
                      <Pencil size={14} />
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : tasks.length === 0 ? (
            <div className="task-empty">
              <span>
                <Sparkles size={21} />
              </span>
              <h2>从第一项真实任务开始</h2>
              <p>任务会保存在当前工作区，也可以安排到今天。</p>
              <button type="button" className="secondary-button" onClick={onOpenCreate}>
                <Plus size={14} /> 新建任务
              </button>
            </div>
          ) : (
            <div className="task-empty">
              <span>
                <Search size={21} />
              </span>
              <h2>没有匹配的任务</h2>
              <p>调整搜索词或筛选条件后再试。</p>
            </div>
          )}

          {snapshot && snapshot.tasks.length > 0 ? (
            <div className="task-page-summary" aria-live="polite">
              <Check size={14} /> 完成任务会保留记录；可从“已完成”筛选中重新打开。
            </div>
          ) : null}
        </section>
      )}
    </div>
  );
}

function planningValue(task: Task, todayDate: string): TaskPlanning | 'past' {
  if (task.plannedFor === todayDate) return 'today';
  return task.plannedFor === null ? 'none' : 'past';
}

function formatPlannedDate(value: string, todayDate: string): string {
  return value === todayDate ? '今天' : `原计划 ${formatShortDate(value)}`;
}

function formatShortDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) return value;
  return `${Number(match[2])}月${Number(match[3])}日`;
}
