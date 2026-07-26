import { AlertTriangle, LoaderCircle, RefreshCw, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { automationCreateNameSummary } from '../automation-create-navigation';

interface AutomationCreateSyncWarningProps {
  name: string;
  enabled: boolean;
  message: string;
  onRefresh: () => Promise<void>;
  onDismiss: () => void;
}

export function AutomationCreateSyncWarning({
  name,
  enabled,
  message,
  onRefresh,
  onDismiss,
}: AutomationCreateSyncWarningProps) {
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const summary = automationCreateNameSummary(name);
  const enabledLabel = enabled ? '当前已启用' : '默认停用';

  useEffect(() => {
    if (refreshError === null) return;
    const frame = window.requestAnimationFrame(() =>
      errorRef.current?.focus({ preventScroll: true }),
    );
    return () => window.cancelAnimationFrame(frame);
  }, [refreshError]);

  const refresh = async (): Promise<void> => {
    if (refreshing) return;
    setRefreshing(true);
    setRefreshError(null);
    try {
      await onRefresh();
    } catch (error) {
      setRefreshError(
        error instanceof Error && error.message.trim().length > 0
          ? error.message
          : '自动化列表仍无法读取，请稍后重试。',
      );
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <article
      className="task-create-toast task-create-sync-warning automation-create-sync-warning"
      aria-busy={refreshing}
    >
      <AlertTriangle size={18} aria-hidden="true" />
      <div>
        <strong>自动化已创建，但列表未同步</strong>
        <span title={summary}>
          {summary} · {enabledLabel}
        </span>
        <p className="task-create-sync-warning__message automation-create-sync-warning__message">
          {message}
        </p>
      </div>
      <button
        type="button"
        className="task-create-toast__action automation-create-sync-warning__action"
        aria-label={`重新读取自动化列表并确认：“${summary}”`}
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
        className="task-create-toast__close automation-create-toast__close"
        aria-label={`关闭自动化同步警告：“${summary}”`}
        disabled={refreshing}
        onClick={onDismiss}
      >
        <X size={14} aria-hidden="true" />
      </button>
      {refreshError ? (
        <p
          ref={errorRef}
          className="task-create-toast__error automation-create-sync-warning__error"
          role="alert"
          tabIndex={-1}
        >
          {refreshError}
        </p>
      ) : null}
      <p className="sr-only" role="alert" aria-atomic="true">
        自动化已创建，但列表未同步：“{summary}”。{enabledLabel}。{message}
      </p>
    </article>
  );
}
