import { Clock3, Play, Target, X } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { Task } from '../../shared/contracts';
import { FOCUS_DURATION_SECONDS } from '../../shared/focus-domain';
import { formatFocusTimer } from '../focus-state';

interface FocusSessionDialogProps {
  readonly tasks: readonly Task[];
  readonly onClose: () => void;
  readonly onStart: (taskId?: string) => Promise<void>;
}

export function FocusSessionDialog({ tasks, onClose, onStart }: FocusSessionDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const taskSelectRef = useRef<HTMLSelectElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const [taskId, setTaskId] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectedTask = tasks.find((task) => task.id === taskId) ?? null;
  const selectedTaskId = selectedTask?.id ?? '';

  useEffect(() => {
    const dialog = dialogRef.current;
    returnFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (dialog && !dialog.open) dialog.showModal();
    const frame = window.requestAnimationFrame(() => taskSelectRef.current?.focus());
    return () => {
      window.cancelAnimationFrame(frame);
      if (dialog?.open) dialog.close();
      const returnTarget = returnFocusRef.current;
      if (returnTarget?.isConnected) {
        window.requestAnimationFrame(() => returnTarget.focus());
      }
    };
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await onStart(selectedTaskId || undefined);
      onClose();
    } catch (submitError) {
      setError(
        submitError instanceof Error && submitError.message.trim()
          ? submitError.message
          : '无法开始专注，请重试。',
      );
    } finally {
      setSubmitting(false);
    }
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
              value={selectedTaskId}
              onChange={(event) => setTaskId(event.target.value)}
              disabled={submitting}
            >
              <option value="">不关联任务</option>
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
              {selectedTask?.title ?? '自由专注'}
            </span>
          </div>
          {tasks.length === 0 ? (
            <p className="focus-session-dialog__hint">
              今天没有未完成任务，仍可开始一轮不关联任务的专注。
            </p>
          ) : null}
        </div>

        {error ? (
          <p className="focus-session-dialog__error" role="alert">
            {error}
          </p>
        ) : null}

        <footer>
          <button type="button" onClick={onClose} disabled={submitting}>
            取消
          </button>
          <button type="submit" className="focus-session-dialog__primary" disabled={submitting}>
            <Play size={14} fill="currentColor" aria-hidden="true" />
            {submitting ? '正在开始…' : '开始专注'}
          </button>
        </footer>
      </form>
    </dialog>
  );
}
