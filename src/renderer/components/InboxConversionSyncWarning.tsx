import { AlertTriangle, LoaderCircle, RefreshCw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

export interface InboxConversionSyncWarningProps {
  outputKind: 'task' | 'note';
  outputTitle: string;
  message: string;
  focusActionOnMount: boolean;
  focusBlocked: boolean;
  onRefresh: () => Promise<void>;
}

export function InboxConversionSyncWarning({
  outputKind,
  outputTitle,
  message,
  focusActionOnMount,
  focusBlocked,
  onRefresh,
}: InboxConversionSyncWarningProps) {
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const refreshingRef = useRef(false);
  const actionRef = useRef<HTMLButtonElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const actionFocusedRef = useRef(false);
  const outputLabel = outputKind === 'task' ? '任务' : '笔记';
  const summary = conversionOutputTitleSummary(outputTitle, outputLabel);

  useEffect(() => {
    if (focusBlocked || actionFocusedRef.current) return;
    const focusWasLost =
      document.activeElement === null || document.activeElement === document.body;
    if (!focusActionOnMount && !focusWasLost) return;
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
    } catch {
      setRefreshError(
        outputKind === 'task'
          ? '重新读取后仍无法确认已转换的任务。请稍后再试；记录已经转换，请不要重复操作。'
          : '重新读取后仍无法确认已转换的笔记。请稍后再试；记录已经转换，请不要重复操作。',
      );
    } finally {
      refreshingRef.current = false;
      setRefreshing(false);
    }
  };

  return (
    <article
      className="inbox-conversion-feedback inbox-conversion-sync-warning"
      role="alert"
      aria-atomic="true"
      aria-busy={refreshing}
    >
      <AlertTriangle size={18} aria-hidden="true" />
      <div>
        <strong>记录已转为{outputLabel}，但列表未同步</strong>
        <span title={summary}>{summary}</span>
      </div>
      <button
        ref={actionRef}
        type="button"
        className="inbox-conversion-feedback__open inbox-conversion-sync-warning__action"
        aria-label={`重新读取收件箱和${outputLabel}列表并确认：“${summary}”`}
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
      <p className="inbox-conversion-sync-warning__message">
        {message} 记录已经转换，请不要重复操作。
      </p>
      {refreshError ? (
        <p
          ref={errorRef}
          className="inbox-conversion-navigation-error inbox-conversion-sync-warning__error"
          tabIndex={-1}
        >
          {refreshError}
        </p>
      ) : null}
    </article>
  );
}

function conversionOutputTitleSummary(title: string, fallback: string, maxLength = 96): string {
  const normalized = title.trim().replace(/\s+/gu, ' ') || `未命名${fallback}`;
  const characters = Array.from(normalized);
  return characters.length <= maxLength
    ? normalized
    : `${characters.slice(0, maxLength).join('')}…`;
}
