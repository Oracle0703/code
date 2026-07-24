import { CalendarDays, CheckSquare2, Inbox, Pencil, X } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { InboxEntry, PlanningDay, Task, TaskPlanning } from '../../shared/contracts';
import { TASK_TITLE_MAX_LENGTH } from '../../shared/task-domain';
import { planningDayLabel } from '../planning-state';

export type TaskDialogState =
  | {
      readonly mode: 'create';
      readonly workspaceId: string;
      readonly workspaceName: string;
      readonly planning: TaskPlanning;
    }
  | {
      readonly mode: 'rename';
      readonly workspaceId: string;
      readonly workspaceName: string;
      readonly task: Task;
    }
  | {
      readonly mode: 'convert';
      readonly workspaceId: string;
      readonly workspaceName: string;
      readonly entry: InboxEntry;
      readonly planning: TaskPlanning;
    };

interface TaskDialogProps {
  state: TaskDialogState;
  planningDays: readonly PlanningDay[];
  onClose: () => void;
  onCreate: (title: string, planning: TaskPlanning) => Promise<void>;
  onRename: (taskId: string, title: string) => Promise<void>;
  onConvert: (entryId: string, planning: TaskPlanning) => Promise<void>;
}

export function TaskDialog({
  state,
  planningDays,
  onClose,
  onCreate,
  onRename,
  onConvert,
}: TaskDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const planningRef = useRef<HTMLSelectElement>(null);
  const [title, setTitle] = useState(state.mode === 'rename' ? state.task.title : '');
  const [planning, setPlanning] = useState<TaskPlanning>(
    state.mode === 'rename' ? 'none' : state.planning,
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const normalizedTitle = title.trim();
  const titleLength = Array.from(normalizedTitle).length;
  const titleTooLong = titleLength > TASK_TITLE_MAX_LENGTH;
  const planningValid = planning === 'none' || planningDays.some(({ token }) => token === planning);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    const frame = window.requestAnimationFrame(() => {
      if (state.mode === 'convert') planningRef.current?.focus();
      else titleRef.current?.focus();
    });
    return () => {
      window.cancelAnimationFrame(frame);
      if (dialog?.open) dialog.close();
    };
  }, [state.mode]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (
      submitting ||
      titleTooLong ||
      !planningValid ||
      (state.mode !== 'convert' && !normalizedTitle)
    ) {
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      if (state.mode === 'create') await onCreate(title, planning);
      else if (state.mode === 'rename') await onRename(state.task.id, title);
      else await onConvert(state.entry.id, planning);
      onClose();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : '任务操作失败，请重试。');
    } finally {
      setSubmitting(false);
    }
  };

  const isConvert = state.mode === 'convert';
  const heading =
    state.mode === 'create' ? '新建任务' : state.mode === 'rename' ? '编辑任务' : '转为任务';
  const submitLabel =
    state.mode === 'create' ? '创建任务' : state.mode === 'rename' ? '保存标题' : '确认转换';
  const HeaderIcon =
    state.mode === 'convert' ? Inbox : state.mode === 'rename' ? Pencil : CheckSquare2;

  return (
    <dialog
      ref={dialogRef}
      className="task-dialog"
      aria-labelledby="task-dialog-title"
      aria-describedby="task-dialog-description"
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
          <span className="task-dialog__icon">
            <HeaderIcon size={18} aria-hidden="true" />
          </span>
          <div>
            <h2 id="task-dialog-title">{heading}</h2>
            <p id="task-dialog-description">
              保存到 <strong>{state.workspaceName}</strong>
            </p>
          </div>
          <button type="button" aria-label="关闭" onClick={onClose} disabled={submitting}>
            <X size={16} />
          </button>
        </header>

        <div className="task-dialog__body">
          {isConvert ? (
            <div className="task-dialog__source">
              <span>收件箱内容</span>
              <strong>{state.entry.content}</strong>
              <small>转换成功后，这条收件箱记录会被归档。</small>
            </div>
          ) : (
            <label className="task-dialog__title-field">
              <span>任务标题</span>
              <input
                ref={titleRef}
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="下一步要完成什么？"
                autoComplete="off"
                disabled={submitting}
                aria-invalid={titleTooLong}
                aria-describedby="task-title-limit"
                required
              />
              <small id="task-title-limit" className={titleTooLong ? 'is-error' : undefined}>
                {titleLength} / {TASK_TITLE_MAX_LENGTH}
              </small>
            </label>
          )}

          {state.mode !== 'rename' ? (
            <label className="task-dialog__planning-field">
              <span>
                <CalendarDays size={15} aria-hidden="true" /> 安排时间
              </span>
              <select
                ref={planningRef}
                value={planning}
                disabled={submitting}
                aria-invalid={!planningValid}
                onChange={(event) => setPlanning(event.target.value as TaskPlanning)}
              >
                {planningDays.map((day) => {
                  const label = planningDayLabel(day);
                  return (
                    <option value={day.token} key={day.token}>
                      {label.short} · {label.date}
                    </option>
                  );
                })}
                <option value="none">稍后安排</option>
              </select>
              <small className={!planningValid ? 'is-error' : undefined}>
                {planningValid
                  ? '可在接下来 7 天内安排，或保留在任务列表。'
                  : '日期窗口正在更新，请稍后重试。'}
              </small>
            </label>
          ) : null}
        </div>

        {error ? (
          <p className="task-dialog__error" role="alert">
            {error}
          </p>
        ) : null}

        <footer>
          <span>
            <kbd>Enter</kbd> 确认 · <kbd>Esc</kbd> 取消
          </span>
          <button
            type="button"
            className="task-dialog__cancel"
            onClick={onClose}
            disabled={submitting}
          >
            取消
          </button>
          <button
            type="submit"
            className="task-dialog__primary"
            disabled={
              submitting ||
              titleTooLong ||
              !planningValid ||
              (state.mode !== 'convert' && normalizedTitle.length === 0)
            }
          >
            {submitting ? '正在保存…' : submitLabel}
          </button>
        </footer>
      </form>
    </dialog>
  );
}
