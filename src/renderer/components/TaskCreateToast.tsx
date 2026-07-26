import { ArrowRight, CheckCircle2, LoaderCircle, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  taskCreateFeedbackKey,
  taskCreateOpenFailed,
  taskCreateOpenFinished,
  taskCreateOpenStarted,
  taskCreateTitleSummary,
  TaskCreateOpenGate,
  TaskCreateSupersededError,
  type TaskCreateFeedback,
  type TaskCreateOpenState,
} from '../task-create-navigation';

interface TaskCreateToastProps {
  feedback: TaskCreateFeedback;
  focusBlocked: boolean;
  onOpen: (feedback: TaskCreateFeedback) => Promise<void>;
  onDismiss: (feedback: TaskCreateFeedback) => boolean;
  onFocusFallback: () => void;
}

export function TaskCreateToast({
  feedback,
  focusBlocked,
  onOpen,
  onDismiss,
  onFocusFallback,
}: TaskCreateToastProps) {
  const [openGate] = useState(() => new TaskCreateOpenGate());
  const [openState, setOpenState] = useState<TaskCreateOpenState | null>(null);
  const actionRef = useRef<HTMLButtonElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const feedbackRef = useRef(feedback);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const focusedFeedbackKeyRef = useRef<string | null>(null);
  const focusedErrorKeyRef = useRef<string | null>(null);
  const errorSequenceRef = useRef(0);
  const feedbackKey = taskCreateFeedbackKey(feedback);
  const visibleOpenState = openState?.feedbackKey === feedbackKey ? openState : null;
  const opening = visibleOpenState?.opening ?? false;
  const openError = visibleOpenState?.error ?? null;
  const errorFocusKey = visibleOpenState?.errorFocusKey ?? null;
  const summary = taskCreateTitleSummary(feedback.title);

  useLayoutEffect(() => {
    feedbackRef.current = feedback;
  }, [feedback]);

  useEffect(() => {
    if (focusBlocked || focusedFeedbackKeyRef.current === feedbackKey) return;
    const frame = window.requestAnimationFrame(() => {
      if (taskCreateFeedbackKey(feedbackRef.current) !== feedbackKey) return;
      const currentFocus = document.activeElement;
      if (
        returnFocusRef.current === null &&
        currentFocus instanceof HTMLElement &&
        currentFocus !== document.body &&
        !currentFocus.closest('.task-create-toast')
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

  const openTask = async (): Promise<void> => {
    if (!openGate.begin(feedback)) return;
    setOpenState(taskCreateOpenStarted(feedback));
    try {
      await onOpen(feedback);
    } catch (error) {
      if (!(error instanceof TaskCreateSupersededError)) {
        const message =
          error instanceof Error && error.message.trim().length > 0
            ? error.message
            : '无法打开刚创建的任务，请重试。';
        errorSequenceRef.current += 1;
        setOpenState((current) =>
          taskCreateOpenFailed(
            current,
            feedback,
            message,
            JSON.stringify([feedbackKey, errorSequenceRef.current, message]),
          ),
        );
      }
    } finally {
      openGate.end(feedback);
      setOpenState((current) => taskCreateOpenFinished(current, feedback));
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
    <article className="task-create-toast" aria-busy={opening}>
      <CheckCircle2 size={18} aria-hidden="true" />
      <div>
        <strong>已创建任务</strong>
        <span title={summary}>{summary}</span>
      </div>
      <button
        ref={actionRef}
        type="button"
        className="task-create-toast__action"
        aria-label="打开刚创建的任务"
        disabled={opening}
        onClick={() => void openTask()}
      >
        {opening ? (
          <LoaderCircle className="is-spinning" size={14} aria-hidden="true" />
        ) : (
          <ArrowRight size={14} aria-hidden="true" />
        )}
        {opening ? '正在打开…' : '打开任务'}
      </button>
      <button
        type="button"
        className="task-create-toast__close"
        aria-label={`关闭新建任务成功提示：“${summary}”`}
        onClick={dismiss}
      >
        <X size={14} aria-hidden="true" />
      </button>
      {openError ? (
        <p ref={errorRef} className="task-create-toast__error" role="alert" tabIndex={-1}>
          {openError}
        </p>
      ) : null}
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        已创建任务：“{summary}”。
      </p>
    </article>
  );
}
