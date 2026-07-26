import { ArrowRight, CheckCircle2, LoaderCircle, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  inboxCaptureContentSummary,
  inboxCaptureFeedbackKey,
  inboxCaptureOpenFailed,
  inboxCaptureOpenFinished,
  inboxCaptureOpenStarted,
  InboxCaptureOpenGate,
  InboxCaptureSupersededError,
  type InboxCaptureFeedback,
  type InboxCaptureOpenState,
} from '../inbox-capture-navigation';

interface InboxCaptureToastProps {
  feedback: InboxCaptureFeedback;
  focusBlocked: boolean;
  onOpen: (feedback: InboxCaptureFeedback) => Promise<void>;
  onDismiss: (feedback: InboxCaptureFeedback) => boolean;
  onFocusFallback: () => void;
}

export function InboxCaptureToast({
  feedback,
  focusBlocked,
  onOpen,
  onDismiss,
  onFocusFallback,
}: InboxCaptureToastProps) {
  const [openGate] = useState(() => new InboxCaptureOpenGate());
  const [openState, setOpenState] = useState<InboxCaptureOpenState | null>(null);
  const actionRef = useRef<HTMLButtonElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const feedbackRef = useRef(feedback);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const focusedFeedbackKeyRef = useRef<string | null>(null);
  const focusedErrorKeyRef = useRef<string | null>(null);
  const errorSequenceRef = useRef(0);
  const feedbackKey = inboxCaptureFeedbackKey(feedback);
  const visibleOpenState = openState?.feedbackKey === feedbackKey ? openState : null;
  const opening = visibleOpenState?.opening ?? false;
  const openError = visibleOpenState?.error ?? null;
  const errorFocusKey = visibleOpenState?.errorFocusKey ?? null;
  const summary = inboxCaptureContentSummary(feedback.content);

  useLayoutEffect(() => {
    feedbackRef.current = feedback;
  }, [feedback]);

  useEffect(() => {
    if (focusBlocked || focusedFeedbackKeyRef.current === feedbackKey) return;
    const frame = window.requestAnimationFrame(() => {
      if (inboxCaptureFeedbackKey(feedbackRef.current) !== feedbackKey) return;
      const currentFocus = document.activeElement;
      if (
        returnFocusRef.current === null &&
        currentFocus instanceof HTMLElement &&
        currentFocus !== document.body &&
        !currentFocus.closest('.inbox-capture-toast')
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

  const openCapture = async (): Promise<void> => {
    if (!openGate.begin(feedback)) return;
    setOpenState(inboxCaptureOpenStarted(feedback));
    try {
      await onOpen(feedback);
    } catch (error) {
      if (!(error instanceof InboxCaptureSupersededError)) {
        const message =
          error instanceof Error && error.message.trim().length > 0
            ? error.message
            : '无法打开刚创建的收件箱记录，请重试。';
        errorSequenceRef.current += 1;
        setOpenState((current) =>
          inboxCaptureOpenFailed(
            current,
            feedback,
            message,
            JSON.stringify([feedbackKey, errorSequenceRef.current, message]),
          ),
        );
      }
    } finally {
      openGate.end(feedback);
      setOpenState((current) => inboxCaptureOpenFinished(current, feedback));
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
    <article className="inbox-capture-toast" aria-busy={opening}>
      <CheckCircle2 size={18} aria-hidden="true" />
      <div>
        <strong>已加入收件箱</strong>
        <span title={summary}>{summary}</span>
      </div>
      <button
        ref={actionRef}
        type="button"
        className="inbox-capture-toast__action"
        aria-label="打开刚加入收件箱的记录"
        disabled={opening}
        onClick={() => void openCapture()}
      >
        {opening ? (
          <LoaderCircle className="is-spinning" size={14} aria-hidden="true" />
        ) : (
          <ArrowRight size={14} aria-hidden="true" />
        )}
        {opening ? '正在打开…' : '打开记录'}
      </button>
      <button
        type="button"
        className="inbox-capture-toast__close"
        aria-label={`关闭快速记录成功提示：“${summary}”`}
        onClick={dismiss}
      >
        <X size={14} aria-hidden="true" />
      </button>
      {openError ? (
        <p ref={errorRef} className="inbox-capture-toast__error" tabIndex={-1}>
          {openError}
        </p>
      ) : null}
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        已加入收件箱：“{summary}”。
      </p>
    </article>
  );
}
