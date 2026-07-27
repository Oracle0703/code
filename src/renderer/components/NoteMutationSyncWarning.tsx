import { AlertTriangle, LoaderCircle, RefreshCw } from 'lucide-react';
import { useEffect, useRef } from 'react';

export interface NoteMutationSyncWarningProps {
  kind: 'update' | 'archive';
  title: string;
  message: string;
  focusActionOnMount: boolean;
  refreshing: boolean;
  refreshError: string | null;
  onRefresh: () => Promise<void>;
}

export function NoteMutationSyncWarning({
  kind,
  title,
  message,
  focusActionOnMount,
  refreshing,
  refreshError,
  onRefresh,
}: NoteMutationSyncWarningProps) {
  const refreshRequestedRef = useRef(false);
  const previousRefreshErrorRef = useRef(refreshError);
  const actionRef = useRef<HTMLButtonElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const actionFocusedRef = useRef(false);
  const refreshFocusOwnerRef = useRef<Element | null>(null);
  const summary = noteMutationTitleSummary(title);
  const mutationLabel = kind === 'update' ? '保存' : '归档';
  const messageId = `note-${kind}-sync-warning-message`;
  const errorId = `note-${kind}-sync-warning-error`;

  useEffect(() => {
    if (!focusActionOnMount || actionFocusedRef.current) return;
    const focusOwner = document.activeElement;
    const frame = window.requestAnimationFrame(() => {
      const action = actionRef.current;
      if (action === null || document.activeElement !== focusOwner) return;
      action.focus({ preventScroll: true });
      if (document.activeElement === action) actionFocusedRef.current = true;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [focusActionOnMount]);

  useEffect(() => {
    const previousRefreshError = previousRefreshErrorRef.current;
    previousRefreshErrorRef.current = refreshError;
    if (previousRefreshError !== null || refreshError === null) return;
    const focusOwner = refreshFocusOwnerRef.current;
    const frame = window.requestAnimationFrame(() => {
      const error = errorRef.current;
      if (error === null || !noteMutationRefreshOwnsFocus(focusOwner, actionRef.current)) return;
      error.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [refreshError]);

  const refresh = async (): Promise<void> => {
    if (refreshing || refreshRequestedRef.current) return;
    refreshRequestedRef.current = true;
    refreshFocusOwnerRef.current = document.activeElement;
    try {
      await onRefresh();
    } catch {
      // The App owns the durable error so it survives Notes surface unmounts.
    } finally {
      refreshRequestedRef.current = false;
    }
  };

  return (
    <article
      className="task-create-toast task-create-sync-warning note-create-sync-warning note-page__sync-warning"
      role="alert"
      aria-atomic="true"
      aria-busy={refreshing}
    >
      <AlertTriangle size={18} aria-hidden="true" />
      <div>
        <strong>笔记已{mutationLabel}，但列表未同步</strong>
        <span title={summary}>{summary}</span>
        <p
          id={messageId}
          className="task-create-sync-warning__message note-create-sync-warning__message"
        >
          {message}
        </p>
      </div>
      <button
        ref={actionRef}
        type="button"
        className="task-create-toast__action note-create-sync-warning__action"
        aria-label={`重新读取笔记列表并确认已${mutationLabel}：“${summary}”`}
        aria-describedby={refreshError === null ? messageId : `${messageId} ${errorId}`}
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
      {refreshError ? (
        <p
          id={errorId}
          ref={errorRef}
          className="task-create-toast__error note-create-sync-warning__error"
          tabIndex={-1}
        >
          {refreshError}
        </p>
      ) : null}
    </article>
  );
}

function noteMutationTitleSummary(title: string, maxLength = 96): string {
  const normalized = title.trim().replace(/\s+/gu, ' ') || '无标题笔记';
  const characters = Array.from(normalized);
  return characters.length <= maxLength
    ? normalized
    : `${characters.slice(0, maxLength).join('')}…`;
}

function noteMutationRefreshOwnsFocus(
  focusOwner: Element | null,
  action: HTMLButtonElement | null,
): boolean {
  const active = document.activeElement;
  return active === null || active === document.body || active === focusOwner || active === action;
}
