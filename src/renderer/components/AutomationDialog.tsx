import { Archive, Bot, CheckSquare2, FileText, Pencil, X } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  type AutomationAction,
  type AutomationActionKind,
  type AutomationCadence,
  type AutomationItem,
  type AutomationSchedule,
} from '../../shared/contracts';
import {
  AUTOMATION_NAME_MAX_LENGTH,
  normalizeAutomationAction,
  normalizeAutomationName,
  normalizeAutomationSchedule,
} from '../../shared/automation-domain';
import { NOTE_BODY_MAX_LENGTH, NOTE_TITLE_MAX_LENGTH } from '../../shared/note-domain';
import { TASK_TITLE_MAX_LENGTH } from '../../shared/task-domain';
import {
  AUTOMATION_WEEKDAY_LABELS,
  formatAutomationInputMinute,
  parseAutomationInputMinute,
} from '../automation-state';

export type AutomationDialogState =
  | {
      readonly mode: 'create';
      readonly workspaceId: string;
      readonly workspaceName: string;
    }
  | {
      readonly mode: 'edit';
      readonly workspaceId: string;
      readonly workspaceName: string;
      readonly item: AutomationItem;
    };

interface AutomationDialogProps {
  readonly state: AutomationDialogState;
  readonly onClose: () => void;
  readonly onCreate: (
    name: string,
    schedule: AutomationSchedule,
    action: AutomationAction,
  ) => Promise<void>;
  readonly onUpdate: (
    item: AutomationItem,
    name: string,
    schedule: AutomationSchedule,
    action: AutomationAction,
  ) => Promise<void>;
  readonly onArchive: (item: AutomationItem) => Promise<void>;
}

export function AutomationDialog({
  state,
  onClose,
  onCreate,
  onUpdate,
  onArchive,
}: AutomationDialogProps) {
  const initialItem = state.mode === 'edit' ? state.item : null;
  const dialogRef = useRef<HTMLDialogElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const [name, setName] = useState(initialItem?.name ?? '');
  const [cadence, setCadence] = useState<AutomationCadence>(
    initialItem?.schedule.cadence ?? 'daily',
  );
  const [weekday, setWeekday] = useState(initialItem?.schedule.weekday ?? 1);
  const [time, setTime] = useState(
    formatAutomationInputMinute(initialItem?.schedule.localTimeMinute ?? 540),
  );
  const [actionKind, setActionKind] = useState<AutomationActionKind>(
    initialItem?.action.kind ?? 'create-today-task',
  );
  const [taskTitle, setTaskTitle] = useState(
    initialItem?.action.kind === 'create-today-task' ? initialItem.action.title : '',
  );
  const [noteTitle, setNoteTitle] = useState(
    initialItem?.action.kind === 'create-note' ? initialItem.action.title : '',
  );
  const [noteBody, setNoteBody] = useState(
    initialItem?.action.kind === 'create-note' ? initialItem.action.body : '',
  );
  const [submitting, setSubmitting] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = submitting || archiving;

  const normalizedName = safeNormalize(() => normalizeAutomationName(name));
  const localTimeMinute = parseAutomationInputMinute(time);
  const schedule =
    localTimeMinute === null
      ? null
      : safeNormalize(() =>
          normalizeAutomationSchedule({
            cadence,
            localTimeMinute,
            weekday: cadence === 'daily' ? null : weekday,
          }),
        );
  const action = safeNormalize(() =>
    normalizeAutomationAction(
      actionKind === 'create-today-task'
        ? { kind: actionKind, title: taskTitle }
        : { kind: actionKind, title: noteTitle, body: noteBody },
    ),
  );
  const nameLength = Array.from(name.trim()).length;
  const taskTitleLength = Array.from(taskTitle.trim()).length;
  const noteTitleLength = Array.from(noteTitle.trim()).length;
  const noteBodyLength = Array.from(noteBody.replace(/\r\n?/gu, '\n')).length;
  const formInvalid = normalizedName === null || schedule === null || action === null;

  useEffect(() => {
    restoreFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    const frame = window.requestAnimationFrame(() => nameRef.current?.focus());
    return () => {
      window.cancelAnimationFrame(frame);
      if (dialog?.open) dialog.close();
      const restoreTarget = restoreFocusRef.current;
      if (restoreTarget?.isConnected) {
        window.requestAnimationFrame(() => restoreTarget.focus());
      }
    };
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || formInvalid || !normalizedName || !schedule || !action) return;
    setSubmitting(true);
    setError(null);
    try {
      if (state.mode === 'create') {
        await onCreate(normalizedName, schedule, action);
      } else {
        await onUpdate(state.item, normalizedName, schedule, action);
      }
      onClose();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : '自动化保存失败，请稍后重试。');
    } finally {
      setSubmitting(false);
    }
  };

  const archive = async () => {
    if (state.mode !== 'edit' || busy) return;
    if (
      !window.confirm(
        `归档自动化“${state.item.name}”？它将停止运行并从当前列表隐藏，但仍保留在本地备份中。`,
      )
    ) {
      return;
    }
    setArchiving(true);
    setError(null);
    try {
      await onArchive(state.item);
      onClose();
    } catch (archiveError) {
      setError(
        archiveError instanceof Error ? archiveError.message : '自动化归档失败，请稍后重试。',
      );
    } finally {
      setArchiving(false);
    }
  };

  const HeaderIcon = state.mode === 'create' ? Bot : Pencil;

  return (
    <dialog
      ref={dialogRef}
      className="automation-dialog"
      aria-labelledby="automation-dialog-title"
      aria-describedby="automation-dialog-description"
      onCancel={(event) => {
        if (busy) event.preventDefault();
        else onClose();
      }}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form onSubmit={(event) => void submit(event)}>
        <header>
          <span className="automation-dialog__icon">
            <HeaderIcon size={18} aria-hidden="true" />
          </span>
          <div>
            <h2 id="automation-dialog-title">
              {state.mode === 'create' ? '新建自动化' : '编辑自动化'}
            </h2>
            <p id="automation-dialog-description">
              保存到 <strong>{state.workspaceName}</strong> · 仅在应用运行时执行
            </p>
          </div>
          <button type="button" aria-label="关闭" onClick={onClose} disabled={busy}>
            <X size={16} />
          </button>
        </header>

        <div className="automation-dialog__body">
          <label className="automation-dialog__field">
            <span>名称</span>
            <input
              ref={nameRef}
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="例如：服务器巡检提醒"
              autoComplete="off"
              disabled={busy}
              aria-invalid={normalizedName === null}
              aria-describedby="automation-name-limit"
              required
            />
            <small id="automation-name-limit" className={normalizedName ? undefined : 'is-error'}>
              {nameLength} / {AUTOMATION_NAME_MAX_LENGTH}
            </small>
          </label>

          <fieldset>
            <legend>重复计划</legend>
            <div className="automation-dialog__choice-grid">
              <Choice
                checked={cadence === 'daily'}
                name="automation-cadence"
                label="每天"
                description="每天按本地时间运行"
                disabled={busy}
                onChange={() => setCadence('daily')}
              />
              <Choice
                checked={cadence === 'weekly'}
                name="automation-cadence"
                label="每周"
                description="每周指定一天运行"
                disabled={busy}
                onChange={() => setCadence('weekly')}
              />
            </div>
          </fieldset>

          <div className="automation-dialog__schedule-fields">
            {cadence === 'weekly' ? (
              <label className="automation-dialog__field">
                <span>星期</span>
                <select
                  value={weekday}
                  disabled={busy}
                  onChange={(event) => setWeekday(Number(event.target.value))}
                >
                  {AUTOMATION_WEEKDAY_LABELS.map((label, value) => (
                    <option value={value} key={label}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <label className="automation-dialog__field">
              <span>本地时间</span>
              <input
                type="time"
                step={60}
                value={time}
                disabled={busy}
                aria-invalid={localTimeMinute === null}
                aria-describedby="automation-time-hint"
                onChange={(event) => setTime(event.target.value)}
                required
              />
              <small
                id="automation-time-hint"
                className={localTimeMinute === null ? 'is-error' : undefined}
              >
                使用当前系统时区
              </small>
            </label>
          </div>

          <fieldset>
            <legend>固定动作</legend>
            <div className="automation-dialog__choice-grid">
              <Choice
                checked={actionKind === 'create-today-task'}
                name="automation-action"
                label="创建今日任务"
                description="加入执行当天的今日清单"
                icon={CheckSquare2}
                disabled={busy || state.mode === 'edit'}
                onChange={() => setActionKind('create-today-task')}
              />
              <Choice
                checked={actionKind === 'create-note'}
                name="automation-action"
                label="创建笔记"
                description="创建静态 Markdown 模板"
                icon={FileText}
                disabled={busy || state.mode === 'edit'}
                onChange={() => setActionKind('create-note')}
              />
            </div>
            {state.mode === 'edit' ? (
              <p className="automation-dialog__immutable-hint">
                动作类型创建后不可更改；仍可编辑本动作的内容。
              </p>
            ) : null}
          </fieldset>

          {actionKind === 'create-today-task' ? (
            <label className="automation-dialog__field">
              <span>任务标题</span>
              <input
                value={taskTitle}
                onChange={(event) => setTaskTitle(event.target.value)}
                placeholder="例如：检查磁盘、备份与服务状态"
                autoComplete="off"
                disabled={busy}
                aria-invalid={action === null}
                aria-describedby="automation-task-title-limit"
                required
              />
              <small
                id="automation-task-title-limit"
                className={
                  taskTitleLength < 1 || taskTitleLength > TASK_TITLE_MAX_LENGTH
                    ? 'is-error'
                    : undefined
                }
              >
                {taskTitleLength} / {TASK_TITLE_MAX_LENGTH}
              </small>
            </label>
          ) : (
            <div className="automation-dialog__note-fields">
              <label className="automation-dialog__field">
                <span>笔记标题</span>
                <input
                  value={noteTitle}
                  onChange={(event) => setNoteTitle(event.target.value)}
                  placeholder="例如：每周回顾"
                  autoComplete="off"
                  disabled={busy}
                  aria-invalid={action === null}
                  aria-describedby="automation-note-title-limit"
                  required
                />
                <small
                  id="automation-note-title-limit"
                  className={
                    noteTitleLength < 1 || noteTitleLength > NOTE_TITLE_MAX_LENGTH
                      ? 'is-error'
                      : undefined
                  }
                >
                  {noteTitleLength} / {NOTE_TITLE_MAX_LENGTH}
                </small>
              </label>
              <label className="automation-dialog__field">
                <span>Markdown 模板</span>
                <textarea
                  value={noteBody}
                  onChange={(event) => setNoteBody(event.target.value)}
                  placeholder={'## 本周完成\n\n## 下周重点\n'}
                  disabled={busy}
                  aria-invalid={action === null}
                  aria-describedby="automation-note-body-limit"
                  rows={6}
                />
                <small
                  id="automation-note-body-limit"
                  className={noteBodyLength > NOTE_BODY_MAX_LENGTH ? 'is-error' : undefined}
                >
                  {noteBodyLength.toLocaleString()} / {NOTE_BODY_MAX_LENGTH.toLocaleString()}
                </small>
              </label>
            </div>
          )}

          <p className="automation-dialog__runtime-note">
            {state.mode === 'create' ? '新规则创建后默认停用，请在列表中确认并启用。' : null}
            {state.mode === 'create' ? ' ' : ''}
            应用关闭期间不会运行；再次启动时最多补执行最近一次错过的计划。
          </p>
        </div>

        {error ? (
          <p className="automation-dialog__error" role="alert">
            {error}
          </p>
        ) : null}

        <footer>
          {state.mode === 'edit' ? (
            <button
              type="button"
              className="automation-dialog__archive"
              disabled={busy}
              onClick={() => void archive()}
            >
              <Archive size={14} aria-hidden="true" />
              {archiving ? '归档中…' : '归档自动化'}
            </button>
          ) : (
            <span />
          )}
          <button
            type="button"
            className="automation-dialog__cancel"
            onClick={onClose}
            disabled={busy}
          >
            取消
          </button>
          <button
            type="submit"
            className="automation-dialog__primary"
            disabled={busy || formInvalid}
          >
            {submitting ? '保存中…' : state.mode === 'create' ? '创建自动化' : '保存更改'}
          </button>
        </footer>
      </form>
    </dialog>
  );
}

interface ChoiceProps {
  readonly checked: boolean;
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly icon?: typeof CheckSquare2;
  readonly disabled: boolean;
  readonly onChange: () => void;
}

function Choice({
  checked,
  name,
  label,
  description,
  icon: Icon,
  disabled,
  onChange,
}: ChoiceProps) {
  return (
    <label className={checked ? 'is-selected' : ''}>
      <input type="radio" name={name} checked={checked} disabled={disabled} onChange={onChange} />
      {Icon ? <Icon size={16} aria-hidden="true" /> : null}
      <span>
        <strong>{label}</strong>
        <small>{description}</small>
      </span>
    </label>
  );
}

function safeNormalize<T>(operation: () => T): T | null {
  try {
    return operation();
  } catch {
    return null;
  }
}
