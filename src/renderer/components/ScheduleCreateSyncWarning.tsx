import { AlertTriangle, LoaderCircle, RefreshCw, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { scheduleCreateTitleSummary } from '../schedule-create-navigation';
import { formatScheduleInputMinute } from '../schedule-state';

interface ScheduleCreateSyncWarningProps {
  title: string;
  scheduledFor: string;
  startMinute: number;
  endMinute: number;
  message: string;
  blocked: boolean;
  blockedReason: string | null;
  onRefresh: () => Promise<void>;
  onDismiss: () => void;
}

export function ScheduleCreateSyncWarning({
  title,
  scheduledFor,
  startMinute,
  endMinute,
  message,
  blocked,
  blockedReason,
  onRefresh,
  onDismiss,
}: ScheduleCreateSyncWarningProps) {
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const summary = scheduleCreateTitleSummary(title);
  const timing = `${scheduledFor} · ${formatScheduleInputMinute(startMinute)}–${formatScheduleInputMinute(endMinute)}`;
  const blockedReasonId = 'schedule-create-sync-warning-blocked-reason';

  useEffect(() => {
    if (refreshError === null) return;
    const frame = window.requestAnimationFrame(() =>
      errorRef.current?.focus({ preventScroll: true }),
    );
    return () => window.cancelAnimationFrame(frame);
  }, [refreshError]);

  const refresh = async (): Promise<void> => {
    if (blocked || refreshing) return;
    setRefreshing(true);
    setRefreshError(null);
    try {
      await onRefresh();
    } catch (error) {
      setRefreshError(
        error instanceof Error && error.message.trim().length > 0
          ? error.message
          : '日程列表仍无法读取，请稍后重试。',
      );
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <article
      className="task-create-toast task-create-sync-warning schedule-create-sync-warning"
      aria-busy={refreshing}
    >
      <AlertTriangle size={18} aria-hidden="true" />
      <div>
        <strong>日程已创建，但列表未同步</strong>
        <span title={`${summary} · ${timing}`}>
          {summary} · {timing}
        </span>
        <p className="task-create-sync-warning__message schedule-create-sync-warning__message">
          {message}
        </p>
      </div>
      <button
        type="button"
        className="task-create-toast__action schedule-create-sync-warning__action"
        aria-label={`重新读取日程列表并确认：“${summary}”`}
        aria-describedby={blocked && blockedReason ? blockedReasonId : undefined}
        disabled={blocked || refreshing}
        onClick={() => void refresh()}
      >
        {refreshing ? (
          <LoaderCircle className="is-spinning" size={14} aria-hidden="true" />
        ) : (
          <RefreshCw size={14} aria-hidden="true" />
        )}
        {refreshing ? '正在读取…' : '重新读取'}
      </button>
      {blocked && blockedReason ? (
        <span id={blockedReasonId} className="sr-only">
          {blockedReason}
        </span>
      ) : null}
      <button
        type="button"
        className="task-create-toast__close schedule-create-toast__close"
        aria-label={`关闭日程同步警告：“${summary}”`}
        disabled={refreshing}
        onClick={onDismiss}
      >
        <X size={14} aria-hidden="true" />
      </button>
      {refreshError ? (
        <p
          ref={errorRef}
          className="task-create-toast__error schedule-create-sync-warning__error"
          role="alert"
          tabIndex={-1}
        >
          {refreshError}
        </p>
      ) : null}
      <p className="sr-only" role="alert" aria-atomic="true">
        日程已创建，但列表未同步：“{summary}”。{timing}。{message}
      </p>
    </article>
  );
}
