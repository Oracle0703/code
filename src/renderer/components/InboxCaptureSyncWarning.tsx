import { AlertTriangle, LoaderCircle, RefreshCw, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { inboxCaptureContentSummary } from '../inbox-capture-navigation';

interface InboxCaptureSyncWarningProps {
  content: string;
  message: string;
  focusActionOnMount: boolean;
  focusBlocked: boolean;
  onRefresh: () => Promise<void>;
  onDismiss: () => void;
}

export function InboxCaptureSyncWarning({
  content,
  message,
  focusActionOnMount,
  focusBlocked,
  onRefresh,
  onDismiss,
}: InboxCaptureSyncWarningProps) {
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const refreshingRef = useRef(false);
  const actionRef = useRef<HTMLButtonElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const actionFocusedRef = useRef(false);
  const summary = inboxCaptureContentSummary(content);

  useEffect(() => {
    if (!focusActionOnMount || focusBlocked || actionFocusedRef.current) return;
    const frame = window.requestAnimationFrame(() => {
      const action = actionRef.current;
      action?.focus({ preventScroll: true });
      if (document.activeElement === action) actionFocusedRef.current = true;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [focusActionOnMount, focusBlocked]);

  useEffect(() => {
    if (refreshError === null || focusBlocked) return;
    const frame = window.requestAnimationFrame(() =>
      errorRef.current?.focus({ preventScroll: true }),
    );
    return () => window.cancelAnimationFrame(frame);
  }, [focusBlocked, refreshError]);

  const refresh = async (): Promise<void> => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setRefreshing(true);
    setRefreshError(null);
    try {
      await onRefresh();
    } catch (error) {
      setRefreshError(
        error instanceof Error && error.message.trim().length > 0
          ? error.message
          : '收件箱仍无法读取，请稍后重试。',
      );
    } finally {
      refreshingRef.current = false;
      setRefreshing(false);
    }
  };

  return (
    <article
      className="inbox-capture-toast task-create-sync-warning inbox-capture-sync-warning"
      aria-busy={refreshing}
    >
      <AlertTriangle size={18} aria-hidden="true" />
      <div>
        <strong>记录已创建，但收件箱未同步</strong>
        <span title={summary}>{summary}</span>
      </div>
      <button
        ref={actionRef}
        type="button"
        className="inbox-capture-toast__action inbox-capture-sync-warning__action"
        aria-label={`重新读取收件箱并确认：“${summary}”`}
        disabled={refreshing}
        onClick={() => void refresh()}
      >
        {refreshing ? (
          <LoaderCircle className="is-spinning" size={14} aria-hidden="true" />
        ) : (
          <RefreshCw size={14} aria-hidden="true" />
        )}
        {refreshing ? '正在读取…' : '重新读取'}
      </button>
      <button
        type="button"
        className="inbox-capture-toast__close inbox-capture-sync-warning__close"
        aria-label={`关闭快速记录同步警告：“${summary}”`}
        disabled={refreshing}
        onClick={onDismiss}
      >
        <X size={14} aria-hidden="true" />
      </button>
      <p className="task-create-sync-warning__message inbox-capture-sync-warning__message">
        {message}
      </p>
      {refreshError ? (
        <p
          ref={errorRef}
          className="inbox-capture-toast__error inbox-capture-sync-warning__error"
          role="alert"
          tabIndex={-1}
        >
          {refreshError}
        </p>
      ) : null}
      <p className="sr-only" role="alert" aria-atomic="true">
        记录已创建，但收件箱未同步：“{summary}”。{message}
      </p>
    </article>
  );
}
