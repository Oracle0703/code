import { AlertTriangle, LoaderCircle, RefreshCw } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef } from 'react';
import { scheduleCreateTitleSummary } from '../schedule-create-navigation';
import { formatScheduleInputMinute } from '../schedule-state';

export interface ScheduleMutationSyncWarningProps {
  readonly kind: 'update' | 'archive';
  readonly title: string;
  readonly scheduledFor: string;
  readonly startMinute: number;
  readonly endMinute: number;
  readonly message: string;
  readonly focusActionOnMount: boolean;
  readonly focusBlocked: boolean;
  readonly blocked?: boolean;
  readonly blockedReason?: string | null;
  readonly refreshing: boolean;
  readonly refreshError: string | null;
  readonly onRefresh: () => void | Promise<void>;
  readonly onFocusFallback: () => void;
}

export function ScheduleMutationSyncWarning({
  kind,
  title,
  scheduledFor,
  startMinute,
  endMinute,
  message,
  focusActionOnMount,
  focusBlocked,
  blocked = false,
  blockedReason = null,
  refreshing,
  refreshError,
  onRefresh,
  onFocusFallback,
}: ScheduleMutationSyncWarningProps) {
  const refreshRequestedRef = useRef(false);
  const refreshFocusContextRef = useRef(false);
  const previousRefreshErrorRef = useRef(refreshError);
  const actionRef = useRef<HTMLButtonElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const warningRef = useRef<HTMLElement>(null);
  const actionFocusedRef = useRef(false);
  const warningOwnedFocusRef = useRef(false);
  const focusBlockedRef = useRef(focusBlocked);
  const summary = scheduleCreateTitleSummary(title);
  const timing = `${scheduledFor} · ${formatScheduleInputMinute(startMinute)}–${formatScheduleInputMinute(endMinute)}`;
  const mutationLabel = kind === 'update' ? '保存' : '归档';
  const messageId = `schedule-${kind}-sync-warning-message`;
  const errorId = `schedule-${kind}-sync-warning-error`;
  const blockedReasonId = `schedule-${kind}-sync-warning-blocked-reason`;
  const describedBy = [
    messageId,
    blocked && blockedReason !== null ? blockedReasonId : null,
    refreshError === null ? null : errorId,
  ]
    .filter((value): value is string => value !== null)
    .join(' ');

  useLayoutEffect(() => {
    focusBlockedRef.current = focusBlocked;
  }, [focusBlocked]);

  useEffect(() => {
    if (
      !focusActionOnMount ||
      focusBlocked ||
      blocked ||
      refreshing ||
      refreshError !== null ||
      actionFocusedRef.current ||
      !scheduleMutationSyncWarningOwnsFocus(
        document.activeElement,
        document.body,
        warningRef.current,
        actionRef.current,
      )
    ) {
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      const action = actionRef.current;
      if (
        action === null ||
        !scheduleMutationSyncWarningOwnsFocus(
          document.activeElement,
          document.body,
          warningRef.current,
          action,
        )
      ) {
        return;
      }
      action.focus({ preventScroll: true });
      if (document.activeElement === action) {
        actionFocusedRef.current = true;
        warningOwnedFocusRef.current = true;
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [blocked, focusActionOnMount, focusBlocked, kind, refreshError, refreshing, scheduledFor]);

  useEffect(() => {
    const previousRefreshError = previousRefreshErrorRef.current;
    previousRefreshErrorRef.current = refreshError;
    if (previousRefreshError !== null || refreshError === null) return;
    if (
      focusBlocked ||
      !refreshFocusContextRef.current ||
      !scheduleMutationSyncWarningOwnsFocus(
        document.activeElement,
        document.body,
        warningRef.current,
        actionRef.current,
      )
    ) {
      refreshFocusContextRef.current = false;
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      const error = errorRef.current;
      if (
        error !== null &&
        scheduleMutationSyncWarningOwnsFocus(
          document.activeElement,
          document.body,
          warningRef.current,
          actionRef.current,
        )
      ) {
        error.focus({ preventScroll: true });
        if (document.activeElement === error) warningOwnedFocusRef.current = true;
      }
      refreshFocusContextRef.current = false;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [focusBlocked, refreshError]);

  useLayoutEffect(
    () => () => {
      if (
        focusBlockedRef.current ||
        (!warningOwnedFocusRef.current && !refreshFocusContextRef.current)
      ) {
        return;
      }
      window.requestAnimationFrame(onFocusFallback);
    },
    [onFocusFallback],
  );

  const refresh = async (): Promise<void> => {
    if (blocked || refreshing || refreshRequestedRef.current) return;
    refreshRequestedRef.current = true;
    refreshFocusContextRef.current =
      document.activeElement === actionRef.current ||
      (document.activeElement !== null &&
        warningRef.current?.contains(document.activeElement) === true);
    try {
      await onRefresh();
    } catch {
      // The App owns the durable warning error so it survives surface changes.
    } finally {
      refreshRequestedRef.current = false;
    }
  };

  return (
    <article
      ref={warningRef}
      className="task-create-toast task-create-sync-warning schedule-mutation-sync-warning"
      role="alert"
      aria-atomic="true"
      aria-busy={refreshing}
      onFocusCapture={() => {
        warningOwnedFocusRef.current = true;
      }}
      onBlurCapture={(event) => {
        warningOwnedFocusRef.current = false;
        if (
          event.relatedTarget instanceof Node &&
          !warningRef.current?.contains(event.relatedTarget)
        ) {
          refreshFocusContextRef.current = false;
        }
      }}
    >
      <AlertTriangle size={18} aria-hidden="true" />
      <div>
        <strong>日程已{mutationLabel}，但列表未同步</strong>
        <span title={`${summary} · ${timing}`}>
          {summary} · <time dateTime={scheduledFor}>{scheduledFor}</time> ·{' '}
          {formatScheduleInputMinute(startMinute)}–{formatScheduleInputMinute(endMinute)}
        </span>
        <p id={messageId} className="task-create-sync-warning__message">
          {message}
        </p>
        {blocked && blockedReason !== null ? (
          <p
            id={blockedReasonId}
            className="task-create-sync-warning__message schedule-mutation-sync-warning__blocked-reason"
          >
            {blockedReason}
          </p>
        ) : null}
      </div>
      <button
        ref={actionRef}
        type="button"
        className="task-create-toast__action schedule-mutation-sync-warning__action"
        aria-label={`重新读取日程列表并确认已${mutationLabel}：“${summary}”`}
        aria-describedby={describedBy}
        aria-busy={refreshing}
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
      {refreshError ? (
        <p
          id={errorId}
          ref={errorRef}
          className="task-create-toast__error schedule-mutation-sync-warning__error"
          tabIndex={-1}
        >
          {refreshError}
        </p>
      ) : null}
    </article>
  );
}

// Exported for deterministic focus ownership tests without mounting a browser DOM.
// eslint-disable-next-line react-refresh/only-export-components
export function scheduleMutationSyncWarningOwnsFocus(
  activeElement: Element | null,
  body: HTMLElement | null,
  warning: HTMLElement | null,
  action: HTMLButtonElement | null,
): boolean {
  return (
    activeElement === null ||
    activeElement === body ||
    activeElement === action ||
    (activeElement !== null && warning?.contains(activeElement) === true)
  );
}
