import { AlertTriangle, LoaderCircle, RefreshCw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

interface NoteCreateSyncWarningProps {
  title: string;
  message: string;
  focusActionOnMount: boolean;
  onRefresh: () => Promise<void>;
}

export function NoteCreateSyncWarning({
  title,
  message,
  focusActionOnMount,
  onRefresh,
}: NoteCreateSyncWarningProps) {
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const refreshingRef = useRef(false);
  const actionRef = useRef<HTMLButtonElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const actionFocusedRef = useRef(false);
  const summary = noteTitleSummary(title);

  useEffect(() => {
    if (!focusActionOnMount || actionFocusedRef.current) return;
    const frame = window.requestAnimationFrame(() => {
      const action = actionRef.current;
      action?.focus({ preventScroll: true });
      if (document.activeElement === action) actionFocusedRef.current = true;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [focusActionOnMount]);

  useEffect(() => {
    if (refreshError === null) return;
    const frame = window.requestAnimationFrame(() =>
      errorRef.current?.focus({ preventScroll: true }),
    );
    return () => window.cancelAnimationFrame(frame);
  }, [refreshError]);

  const refresh = async (): Promise<void> => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setRefreshing(true);
    setRefreshError(null);
    try {
      await onRefresh();
    } catch {
      setRefreshError(
        '重新读取后仍无法确认刚创建的笔记。请稍后再试；笔记可能已经创建，请不要重复创建。',
      );
    } finally {
      refreshingRef.current = false;
      setRefreshing(false);
    }
  };

  return (
    <article
      className="task-create-toast task-create-sync-warning note-create-sync-warning note-page__sync-warning"
      aria-busy={refreshing}
    >
      <AlertTriangle size={18} aria-hidden="true" />
      <div>
        <strong>笔记已创建，但列表未同步</strong>
        <span title={summary}>{summary}</span>
        <p
          id="note-create-sync-warning-message"
          className="task-create-sync-warning__message note-create-sync-warning__message"
        >
          {message}
        </p>
      </div>
      <button
        ref={actionRef}
        type="button"
        className="task-create-toast__action note-create-sync-warning__action"
        aria-label={`重新读取笔记列表并确认：“${summary}”`}
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
          ref={errorRef}
          className="task-create-toast__error note-create-sync-warning__error"
          role="alert"
          tabIndex={-1}
        >
          {refreshError}
        </p>
      ) : null}
      <p className="sr-only" role="alert" aria-atomic="true">
        笔记已创建，但列表未同步：“{summary}”。{message}
      </p>
    </article>
  );
}

function noteTitleSummary(title: string, maxLength = 96): string {
  const normalized = title.trim().replace(/\s+/gu, ' ') || '无标题笔记';
  const characters = Array.from(normalized);
  return characters.length <= maxLength
    ? normalized
    : `${characters.slice(0, maxLength).join('')}…`;
}
