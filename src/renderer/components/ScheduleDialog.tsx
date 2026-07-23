import { Archive, CalendarClock, Pencil, X } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { ScheduleItem, ScheduleKind } from '../../shared/contracts';
import { SCHEDULE_TITLE_MAX_LENGTH } from '../../shared/schedule-domain';
import { formatScheduleInputMinute, parseScheduleInputMinute } from '../schedule-state';

export type ScheduleDialogState =
  | {
      readonly mode: 'create';
      readonly workspaceId: string;
      readonly workspaceName: string;
      readonly expectedDate: string;
      readonly startMinute: number;
      readonly endMinute: number;
    }
  | {
      readonly mode: 'edit';
      readonly workspaceId: string;
      readonly workspaceName: string;
      readonly expectedDate: string;
      readonly item: ScheduleItem;
    };

interface ScheduleDialogProps {
  state: ScheduleDialogState;
  onClose: () => void;
  onCreate: (
    title: string,
    kind: ScheduleKind,
    startMinute: number,
    endMinute: number,
  ) => Promise<void>;
  onUpdate: (
    item: ScheduleItem,
    title: string,
    kind: ScheduleKind,
    startMinute: number,
    endMinute: number,
  ) => Promise<void>;
  onArchive: (item: ScheduleItem) => Promise<void>;
}

const KIND_LABELS: Record<ScheduleKind, string> = {
  focus: '专注',
  meeting: '会议',
  review: '回顾',
  personal: '个人',
};

export function ScheduleDialog({
  state,
  onClose,
  onCreate,
  onUpdate,
  onArchive,
}: ScheduleDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState(state.mode === 'edit' ? state.item.title : '');
  const [kind, setKind] = useState<ScheduleKind>(state.mode === 'edit' ? state.item.kind : 'focus');
  const [startTime, setStartTime] = useState(
    formatScheduleInputMinute(state.mode === 'edit' ? state.item.startMinute : state.startMinute),
  );
  const [endTime, setEndTime] = useState(
    formatScheduleInputMinute(state.mode === 'edit' ? state.item.endMinute : state.endMinute),
  );
  const [submitting, setSubmitting] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const normalizedTitle = title.trim();
  const titleLength = Array.from(normalizedTitle).length;
  const startMinute = parseScheduleInputMinute(startTime);
  const endMinute = parseScheduleInputMinute(endTime, true);
  const timeInvalid = startMinute === null || endMinute === null || endMinute <= startMinute;
  const titleInvalid = titleLength < 1 || titleLength > SCHEDULE_TITLE_MAX_LENGTH;
  const busy = submitting || archiving;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    const frame = window.requestAnimationFrame(() => titleRef.current?.focus());
    return () => {
      window.cancelAnimationFrame(frame);
      if (dialog?.open) dialog.close();
    };
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || titleInvalid || timeInvalid || startMinute === null || endMinute === null) return;
    setSubmitting(true);
    setError(null);
    try {
      if (state.mode === 'create') {
        await onCreate(title, kind, startMinute, endMinute);
      } else {
        await onUpdate(state.item, title, kind, startMinute, endMinute);
      }
      onClose();
    } catch (submitError) {
      setError(
        submitError instanceof Error
          ? submitError.message
          : '日程保存失败；如果日期已经变化，请重新打开。',
      );
    } finally {
      setSubmitting(false);
    }
  };

  const archive = async () => {
    if (state.mode !== 'edit' || busy) return;
    if (
      !window.confirm(`归档今天的日程“${state.item.title}”？它会从今天隐藏，但仍保留在本地备份中。`)
    ) {
      return;
    }
    setArchiving(true);
    setError(null);
    try {
      await onArchive(state.item);
      onClose();
    } catch (archiveError) {
      setError(archiveError instanceof Error ? archiveError.message : '日程归档失败，请重试。');
    } finally {
      setArchiving(false);
    }
  };

  return (
    <dialog
      ref={dialogRef}
      className="schedule-dialog"
      aria-labelledby="schedule-dialog-title"
      aria-describedby="schedule-dialog-description"
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
          <span className="schedule-dialog__icon">
            {state.mode === 'create' ? (
              <CalendarClock size={18} aria-hidden="true" />
            ) : (
              <Pencil size={18} aria-hidden="true" />
            )}
          </span>
          <div>
            <h2 id="schedule-dialog-title">
              {state.mode === 'create' ? '添加今日日程' : '编辑日程'}
            </h2>
            <p id="schedule-dialog-description">
              {formatCivilDate(state.expectedDate)} · <strong>{state.workspaceName}</strong>
            </p>
          </div>
          <button type="button" aria-label="关闭" onClick={onClose} disabled={busy}>
            <X size={16} />
          </button>
        </header>

        <div className="schedule-dialog__body">
          <label>
            <span>标题</span>
            <input
              ref={titleRef}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="这段时间要做什么？"
              autoComplete="off"
              disabled={busy}
              aria-invalid={titleInvalid}
              aria-describedby="schedule-title-limit"
              required
            />
            <small id="schedule-title-limit" className={titleInvalid ? 'is-error' : undefined}>
              {titleLength} / {SCHEDULE_TITLE_MAX_LENGTH}
            </small>
          </label>

          <div className="schedule-dialog__times">
            <label>
              <span>开始时间</span>
              <input
                value={startTime}
                onChange={(event) => setStartTime(event.target.value)}
                placeholder="09:00"
                inputMode="numeric"
                pattern="(?:[01]\d|2[0-3]):[0-5]\d"
                disabled={busy}
                aria-invalid={timeInvalid}
                required
              />
            </label>
            <label>
              <span>结束时间</span>
              <input
                value={endTime}
                onChange={(event) => setEndTime(event.target.value)}
                placeholder="10:00"
                inputMode="numeric"
                pattern="(?:(?:[01]\d|2[0-3]):[0-5]\d|24:00)"
                disabled={busy}
                aria-invalid={timeInvalid}
                required
              />
            </label>
          </div>
          {timeInvalid ? (
            <p className="schedule-dialog__time-error" role="alert">
              使用 24 小时制 HH:mm，且结束时间必须晚于开始时间。
            </p>
          ) : null}

          <fieldset>
            <legend>类型</legend>
            <div className="schedule-kind-options">
              {(Object.entries(KIND_LABELS) as Array<[ScheduleKind, string]>).map(
                ([value, label]) => (
                  <label className={kind === value ? 'is-selected' : ''} key={value}>
                    <input
                      type="radio"
                      name="schedule-kind"
                      value={value}
                      checked={kind === value}
                      onChange={() => setKind(value)}
                      disabled={busy}
                    />
                    <i className={`agenda-row__line agenda-row__line--${value}`} />
                    <span>{label}</span>
                  </label>
                ),
              )}
            </div>
          </fieldset>
        </div>

        {error ? (
          <p className="schedule-dialog__error" role="alert">
            {error}
          </p>
        ) : null}

        <footer>
          {state.mode === 'edit' ? (
            <button
              type="button"
              className="schedule-dialog__archive"
              onClick={() => void archive()}
              disabled={busy}
            >
              <Archive size={14} />
              {archiving ? '归档中…' : '归档日程'}
            </button>
          ) : (
            <span />
          )}
          <button
            type="button"
            className="schedule-dialog__cancel"
            onClick={onClose}
            disabled={busy}
          >
            取消
          </button>
          <button
            type="submit"
            className="schedule-dialog__primary"
            disabled={busy || titleInvalid || timeInvalid}
          >
            {submitting ? '保存中…' : state.mode === 'create' ? '添加日程' : '保存更改'}
          </button>
        </footer>
      </form>
    </dialog>
  );
}

function formatCivilDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) return value;
  return `${Number(match[2])}月${Number(match[3])}日`;
}
