import { ArrowRight, CheckCircle2, LoaderCircle, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  automationCreateFeedbackKey,
  automationCreateNameSummary,
  automationCreateOpenFailed,
  automationCreateOpenFinished,
  automationCreateOpenStarted,
  AutomationCreateOpenGate,
  AutomationCreateSupersededError,
  type AutomationCreateFeedback,
  type AutomationCreateOpenState,
} from '../automation-create-navigation';

interface AutomationCreateToastProps {
  feedback: AutomationCreateFeedback;
  focusBlocked: boolean;
  onOpen: (feedback: AutomationCreateFeedback) => Promise<void>;
  onDismiss: (feedback: AutomationCreateFeedback) => boolean;
  onFocusFallback: () => void;
}

export function AutomationCreateToast({
  feedback,
  focusBlocked,
  onOpen,
  onDismiss,
  onFocusFallback,
}: AutomationCreateToastProps) {
  const [openGate] = useState(() => new AutomationCreateOpenGate());
  const [openState, setOpenState] = useState<AutomationCreateOpenState | null>(null);
  const actionRef = useRef<HTMLButtonElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const feedbackRef = useRef(feedback);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const focusedFeedbackKeyRef = useRef<string | null>(null);
  const focusedErrorKeyRef = useRef<string | null>(null);
  const errorSequenceRef = useRef(0);
  const feedbackKey = automationCreateFeedbackKey(feedback);
  const visibleOpenState = openState?.feedbackKey === feedbackKey ? openState : null;
  const opening = visibleOpenState?.opening ?? false;
  const openError = visibleOpenState?.error ?? null;
  const errorFocusKey = visibleOpenState?.errorFocusKey ?? null;
  const summary = automationCreateNameSummary(feedback.name);
  const enabledLabel = feedback.enabled ? '当前已启用' : '默认停用';

  useLayoutEffect(() => {
    feedbackRef.current = feedback;
  }, [feedback]);

  useEffect(() => {
    if (focusBlocked || focusedFeedbackKeyRef.current === feedbackKey) return;
    const frame = window.requestAnimationFrame(() => {
      if (automationCreateFeedbackKey(feedbackRef.current) !== feedbackKey) return;
      const currentFocus = document.activeElement;
      if (
        returnFocusRef.current === null &&
        currentFocus instanceof HTMLElement &&
        currentFocus !== document.body &&
        !currentFocus.closest('.automation-create-toast')
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

  const openAutomation = async (): Promise<void> => {
    if (!openGate.begin(feedback)) return;
    setOpenState(automationCreateOpenStarted(feedback));
    try {
      await onOpen(feedback);
    } catch (error) {
      if (!(error instanceof AutomationCreateSupersededError)) {
        const message =
          error instanceof Error && error.message.trim().length > 0
            ? error.message
            : '无法打开刚创建的自动化，请重试。';
        errorSequenceRef.current += 1;
        setOpenState((current) =>
          automationCreateOpenFailed(
            current,
            feedback,
            message,
            JSON.stringify([feedbackKey, errorSequenceRef.current, message]),
          ),
        );
      }
    } finally {
      openGate.end(feedback);
      setOpenState((current) => automationCreateOpenFinished(current, feedback));
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
    <article className="task-create-toast automation-create-toast" aria-busy={opening}>
      <CheckCircle2 size={18} aria-hidden="true" />
      <div>
        <strong>已创建自动化</strong>
        <span title={summary}>
          {summary} · {enabledLabel}
        </span>
      </div>
      <button
        ref={actionRef}
        type="button"
        className="task-create-toast__action automation-create-toast__action"
        aria-label="打开刚创建的自动化"
        disabled={opening}
        onClick={() => void openAutomation()}
      >
        {opening ? (
          <LoaderCircle className="is-spinning" size={14} aria-hidden="true" />
        ) : (
          <ArrowRight size={14} aria-hidden="true" />
        )}
        {opening ? '正在打开…' : '打开自动化'}
      </button>
      <button
        type="button"
        className="task-create-toast__close automation-create-toast__close"
        aria-label={`关闭新建自动化成功提示：“${summary}”`}
        onClick={dismiss}
      >
        <X size={14} aria-hidden="true" />
      </button>
      {openError ? (
        <p
          ref={errorRef}
          className="task-create-toast__error automation-create-toast__error"
          role="alert"
          tabIndex={-1}
        >
          {openError}
        </p>
      ) : null}
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        已创建自动化：“{summary}”。{enabledLabel}。
      </p>
    </article>
  );
}
