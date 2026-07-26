import { ArrowRight, CheckCircle2, LoaderCircle, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ScheduleKind } from '../../shared/contracts';
import {
  scheduleCreateFeedbackKey,
  scheduleCreateOpenFailed,
  scheduleCreateOpenFinished,
  scheduleCreateOpenStarted,
  scheduleCreateTitleSummary,
  ScheduleCreateOpenGate,
  ScheduleCreateSupersededError,
  type ScheduleCreateFeedback,
  type ScheduleCreateOpenState,
} from '../schedule-create-navigation';
import { formatScheduleInputMinute } from '../schedule-state';

interface ScheduleCreateToastProps {
  feedback: ScheduleCreateFeedback;
  focusBlocked: boolean;
  onOpen: (feedback: ScheduleCreateFeedback) => Promise<void>;
  onDismiss: (feedback: ScheduleCreateFeedback) => boolean;
  onFocusFallback: () => void;
}

export function ScheduleCreateToast({
  feedback,
  focusBlocked,
  onOpen,
  onDismiss,
  onFocusFallback,
}: ScheduleCreateToastProps) {
  const [openGate] = useState(() => new ScheduleCreateOpenGate());
  const [openState, setOpenState] = useState<ScheduleCreateOpenState | null>(null);
  const actionRef = useRef<HTMLButtonElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const feedbackRef = useRef(feedback);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const focusedFeedbackKeyRef = useRef<string | null>(null);
  const focusedErrorKeyRef = useRef<string | null>(null);
  const errorSequenceRef = useRef(0);
  const feedbackKey = scheduleCreateFeedbackKey(feedback);
  const visibleOpenState = openState?.feedbackKey === feedbackKey ? openState : null;
  const opening = visibleOpenState?.opening ?? false;
  const openError = visibleOpenState?.error ?? null;
  const errorFocusKey = visibleOpenState?.errorFocusKey ?? null;
  const summary = scheduleCreateTitleSummary(feedback.title);
  const detail = scheduleCreateDetail(
    feedback.scheduledFor,
    feedback.startMinute,
    feedback.endMinute,
    feedback.kind,
  );

  useLayoutEffect(() => {
    feedbackRef.current = feedback;
  }, [feedback]);

  useEffect(() => {
    if (focusBlocked || focusedFeedbackKeyRef.current === feedbackKey) return;
    const frame = window.requestAnimationFrame(() => {
      if (scheduleCreateFeedbackKey(feedbackRef.current) !== feedbackKey) return;
      const currentFocus = document.activeElement;
      if (
        returnFocusRef.current === null &&
        currentFocus instanceof HTMLElement &&
        currentFocus !== document.body &&
        !currentFocus.closest('.schedule-create-toast')
      ) {
        returnFocusRef.current = currentFocus;
      }
      const action = actionRef.current;
      action?.focus({ preventScroll: true });
      if (document.activeElement === action) focusedFeedbackKeyRef.current = feedbackKey;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [feedbackKey, focusBlocked]);

  useEffect(() => {
    if (errorFocusKey === null || focusBlocked || focusedErrorKeyRef.current === errorFocusKey) {
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      const error = errorRef.current;
      error?.focus({ preventScroll: true });
      if (document.activeElement === error) focusedErrorKeyRef.current = errorFocusKey;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [errorFocusKey, focusBlocked]);

  const openSchedule = async (): Promise<void> => {
    if (!openGate.begin(feedback)) return;
    setOpenState(scheduleCreateOpenStarted(feedback));
    try {
      await onOpen(feedback);
    } catch (error) {
      if (!(error instanceof ScheduleCreateSupersededError)) {
        const message =
          error instanceof Error && error.message.trim().length > 0
            ? error.message
            : '无法打开刚创建的日程，请重试。';
        errorSequenceRef.current += 1;
        setOpenState((current) =>
          scheduleCreateOpenFailed(
            current,
            feedback,
            message,
            JSON.stringify([feedbackKey, errorSequenceRef.current, message]),
          ),
        );
      }
    } finally {
      openGate.end(feedback);
      setOpenState((current) => scheduleCreateOpenFinished(current, feedback));
    }
  };

  const dismiss = (): void => {
    const returnTarget = returnFocusRef.current;
    if (!onDismiss(feedback)) return;
    window.requestAnimationFrame(() => {
      if (returnTarget?.isConnected && !returnTarget.matches(':disabled, [aria-disabled="true"]')) {
        returnTarget.focus({ preventScroll: true });
        if (document.activeElement === returnTarget) return;
      }
      onFocusFallback();
    });
  };

  return (
    <article className="task-create-toast schedule-create-toast" aria-busy={opening}>
      <CheckCircle2 size={18} aria-hidden="true" />
      <div>
        <strong>已创建日程</strong>
        <span title={`${summary} · ${detail}`}>
          {summary} · {detail}
        </span>
      </div>
      <button
        ref={actionRef}
        type="button"
        className="task-create-toast__action schedule-create-toast__action"
        aria-label="编辑刚创建的日程"
        disabled={opening}
        onClick={() => void openSchedule()}
      >
        {opening ? (
          <LoaderCircle className="is-spinning" size={14} aria-hidden="true" />
        ) : (
          <ArrowRight size={14} aria-hidden="true" />
        )}
        {opening ? '正在打开…' : '编辑日程'}
      </button>
      <button
        type="button"
        className="task-create-toast__close schedule-create-toast__close"
        aria-label={`关闭新建日程成功提示：“${summary}”`}
        onClick={dismiss}
      >
        <X size={14} aria-hidden="true" />
      </button>
      {openError ? (
        <p
          ref={errorRef}
          className="task-create-toast__error schedule-create-toast__error"
          role="alert"
          tabIndex={-1}
        >
          {openError}
        </p>
      ) : null}
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        已创建日程：“{summary}”。{detail}。
      </p>
    </article>
  );
}

function scheduleCreateDetail(
  scheduledFor: string,
  startMinute: number,
  endMinute: number,
  kind: ScheduleKind,
): string {
  return `${scheduledFor} · ${formatScheduleInputMinute(startMinute)}–${formatScheduleInputMinute(endMinute)} · ${scheduleKindLabel(kind)}`;
}

function scheduleKindLabel(kind: ScheduleKind): string {
  switch (kind) {
    case 'focus':
      return '专注';
    case 'meeting':
      return '会议';
    case 'review':
      return '回顾';
    case 'personal':
      return '个人';
  }
}
