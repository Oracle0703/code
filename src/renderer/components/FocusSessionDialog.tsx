import { Clock3, Play, Target, X } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { Task } from '../../shared/contracts';
import { FOCUS_DURATION_SECONDS } from '../../shared/focus-domain';
import {
  submitFocusDialogSelection,
  unavailableFocusTaskMessage,
  type FocusDialogSubmissionGate,
} from '../focus-dialog-submission';
import { formatFocusTimer, resolveFocusTaskSelection } from '../focus-state';

interface FocusSessionDialogProps {
  readonly tasks: readonly Task[];
  readonly initialTask?: Pick<Task, 'id' | 'title'>;
  readonly startBlockedReason: string | null;
  readonly taskOptionsUnavailableReason: string | null;
  readonly onClose: () => void;
  readonly onStart: (taskId?: string) => Promise<void>;
  readonly onStarted: () => void;
}

export function FocusSessionDialog({
  tasks,
  initialTask,
  startBlockedReason,
  taskOptionsUnavailableReason,
  onClose,
  onStart,
  onStarted,
}: FocusSessionDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const taskSelectRef = useRef<HTMLSelectElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const restoreInvokerRef = useRef(true);
  const submissionGateRef = useRef<FocusDialogSubmissionGate>({
    mounted: true,
    submitting: false,
  });
  const [taskId, setTaskId] = useState(initialTask?.id ?? '');
  const [taskLabel, setTaskLabel] = useState(initialTask?.title ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selection = resolveFocusTaskSelection(tasks, taskId);
  const selectedTask = selection.task;
  const visibleBlockedReason = submitting ? null : startBlockedReason;

  useEffect(() => {
    const submissionGate = submissionGateRef.current;
    submissionGate.mounted = true;
    const dialog = dialogRef.current;
    returnFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (dialog && !dialog.open) dialog.showModal();
    const frame = window.requestAnimationFrame(() => taskSelectRef.current?.focus());
    return () => {
      submissionGate.mounted = false;
      window.cancelAnimationFrame(frame);
      if (dialog?.open) dialog.close();
      const returnTarget = returnFocusRef.current;
      if (restoreInvokerRef.current && returnTarget?.isConnected) {
        window.requestAnimationFrame(() => returnTarget.focus());
      }
    };
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    await submitFocusDialogSelection(
      submissionGateRef.current,
      selection,
      startBlockedReason,
      taskLabel,
      {
        onStart,
        onSubmittingChange: setSubmitting,
        onError: setError,
        onSucceeded: () => {
          restoreInvokerRef.current = false;
          onClose();
          onStarted();
        },
      },
    );
  };

  return (
    <dialog
      ref={dialogRef}
      className="focus-session-dialog"
      aria-labelledby="focus-session-dialog-title"
      aria-describedby="focus-session-dialog-description"
      aria-busy={submitting}
      onCancel={(event) => {
        if (submitting) event.preventDefault();
        else onClose();
      }}
      onClose={() => {
        if (!submitting) onClose();
      }}
    >
      <form onSubmit={(event) => void submit(event)}>
        <header>
          <span className="focus-session-dialog__icon">
            <Target size={19} aria-hidden="true" />
          </span>
          <div>
            <h2 id="focus-session-dialog-title">开始 {FOCUS_DURATION_SECONDS / 60} 分钟专注</h2>
            <p id="focus-session-dialog-description">
              任务关联是可选的；本轮完成后会计入今天的专注轮次。
            </p>
          </div>
          <button type="button" aria-label="关闭" onClick={onClose} disabled={submitting}>
            <X size={16} aria-hidden="true" />
          </button>
        </header>

        <div className="focus-session-dialog__body">
          <label>
            <span>关联今日任务（可选）</span>
            <select
              ref={taskSelectRef}
              value={taskId}
              onChange={(event) => {
                const nextTaskId = event.target.value;
                const nextTask = tasks.find(({ id }) => id === nextTaskId);
                setTaskId(nextTaskId);
                setTaskLabel(nextTask?.title ?? '');
                setError(null);
              }}
              disabled={submitting}
              aria-invalid={selection.invalid}
              aria-describedby={
                selection.invalid
                  ? 'focus-session-task-error'
                  : taskOptionsUnavailableReason
                    ? 'focus-session-task-options-status'
                    : undefined
              }
              aria-errormessage={selection.invalid ? 'focus-session-task-error' : undefined}
            >
              <option value="">自由专注（不关联任务）</option>
              {selection.invalid ? (
                <option value={taskId} disabled>
                  不再可用 · {taskLabel || '原任务'}
                </option>
              ) : null}
              {tasks.map((task) => (
                <option value={task.id} key={task.id}>
                  {task.title}
                </option>
              ))}
            </select>
          </label>
          <div className="focus-session-dialog__summary">
            <Clock3 size={16} aria-hidden="true" />
            <span>
              <strong>{formatFocusTimer(FOCUS_DURATION_SECONDS)}</strong>
              {selection.invalid
                ? `任务不可用 · ${taskLabel || '原任务'}`
                : (selectedTask?.title ?? '自由专注（不关联任务）')}
            </span>
          </div>
          {taskOptionsUnavailableReason ? (
            <p
              className="focus-session-dialog__hint"
              id="focus-session-task-options-status"
              role="status"
            >
              {taskOptionsUnavailableReason}仍可开始自由专注（不关联任务）。
            </p>
          ) : tasks.length === 0 ? (
            <p className="focus-session-dialog__hint">
              今天没有未完成任务，仍可开始自由专注（不关联任务）。
            </p>
          ) : null}
          {selection.invalid ? (
            <p className="focus-session-dialog__error" id="focus-session-task-error" role="alert">
              {unavailableFocusTaskMessage(taskLabel)}
            </p>
          ) : null}
          {visibleBlockedReason ? (
            <p className="focus-session-dialog__error" role="alert">
              {visibleBlockedReason}
            </p>
          ) : null}
        </div>

        {error && !selection.invalid && visibleBlockedReason === null ? (
          <p className="focus-session-dialog__error" role="alert">
            {error}
          </p>
        ) : null}

        <footer>
          <button type="button" onClick={onClose} disabled={submitting}>
            取消
          </button>
          <button
            type="submit"
            className="focus-session-dialog__primary"
            disabled={submitting || selection.invalid || visibleBlockedReason !== null}
          >
            <Play size={14} fill="currentColor" aria-hidden="true" />
            {submitting ? '正在开始…' : '开始专注'}
          </button>
        </footer>
      </form>
    </dialog>
  );
}
