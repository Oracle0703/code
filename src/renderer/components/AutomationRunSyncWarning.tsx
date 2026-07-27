import { AlertTriangle, LoaderCircle, RefreshCw } from 'lucide-react';
import { useEffect, useRef } from 'react';
import type { AutomationRunFeedback } from '../automation-state';

interface AutomationRunSyncWarningProps {
  feedback: AutomationRunFeedback;
  focusActionOnMount: boolean;
  focusBlocked: boolean;
  refreshing: boolean;
  refreshError: string | null;
  onRefresh: (restoreOutputActionFocus: boolean) => Promise<void>;
}

export function AutomationRunSyncWarning({
  feedback,
  focusActionOnMount,
  focusBlocked,
  refreshing,
  refreshError,
  onRefresh,
}: AutomationRunSyncWarningProps) {
  const refreshRequestedRef = useRef(false);
  const refreshFocusContextRef = useRef(false);
  const actionRef = useRef<HTMLButtonElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const actionFocusedRef = useRef(false);
  const outputLabel = feedback.outputKind === 'task' ? '任务' : '笔记';
  const outputTitle = automationRunOutputTitleSummary(feedback.outputTitle, outputLabel);

  useEffect(() => {
    if (
      !focusActionOnMount ||
      focusBlocked ||
      refreshing ||
      refreshError !== null ||
      actionFocusedRef.current
    ) {
      return;
    }
    if (!automationRunWarningOwnsFocus(feedback.automationId)) return;
    const frame = window.requestAnimationFrame(() => {
      const action = actionRef.current;
      if (!automationRunWarningOwnsFocus(feedback.automationId)) return;
      action?.focus({ preventScroll: true });
      if (document.activeElement === action) actionFocusedRef.current = true;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [feedback.automationId, focusActionOnMount, focusBlocked, refreshError, refreshing]);

  useEffect(() => {
    if (refreshError === null) return;
    if (focusBlocked) {
      refreshFocusContextRef.current = false;
      return;
    }
    if (!refreshFocusContextRef.current || !automationRunRefreshOwnsFocus(actionRef.current)) {
      refreshFocusContextRef.current = false;
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      if (!automationRunRefreshOwnsFocus(actionRef.current)) {
        refreshFocusContextRef.current = false;
        return;
      }
      errorRef.current?.focus({ preventScroll: true });
      refreshFocusContextRef.current = false;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [focusBlocked, refreshError]);

  const refresh = async (): Promise<void> => {
    if (refreshing || refreshRequestedRef.current) return;
    const restoreOutputActionFocus = document.activeElement === actionRef.current;
    refreshRequestedRef.current = true;
    refreshFocusContextRef.current = restoreOutputActionFocus;
    try {
      await onRefresh(restoreOutputActionFocus);
    } catch {
      // The App owns the durable warning error so it survives page unmounts.
    } finally {
      refreshRequestedRef.current = false;
    }
  };

  return (
    <article className="automation-run-sync-warning" aria-busy={refreshing}>
      <AlertTriangle size={18} aria-hidden="true" />
      <div role="alert" aria-atomic="true">
        <strong>自动化已经运行，但输出未同步</strong>
        <span title={`${outputLabel}：${outputTitle}`}>
          {outputLabel} · {outputTitle}
        </span>
        <p id="automation-run-sync-warning-message">
          请重新读取并确认输出；自动化已经运行，请不要再次运行。
        </p>
      </div>
      <button
        ref={actionRef}
        type="button"
        className="automation-run-sync-warning__action"
        aria-busy={refreshing}
        aria-label={
          refreshing
            ? `正在重新读取并确认自动化输出：${outputLabel}“${outputTitle}”`
            : `重新读取并确认自动化输出：${outputLabel}“${outputTitle}”`
        }
        aria-describedby={
          refreshError === null
            ? 'automation-run-sync-warning-message'
            : 'automation-run-sync-warning-message automation-run-sync-warning-error'
        }
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
          id="automation-run-sync-warning-error"
          ref={errorRef}
          className="automation-run-sync-warning__error"
          tabIndex={-1}
        >
          {refreshError}
        </p>
      ) : null}
    </article>
  );
}

function automationRunOutputTitleSummary(title: string, fallback: string, maxLength = 96): string {
  const normalized = title.trim().replace(/\s+/gu, ' ') || `未命名${fallback}`;
  const characters = Array.from(normalized);
  return characters.length <= maxLength
    ? normalized
    : `${characters.slice(0, maxLength).join('')}…`;
}

function automationRunWarningOwnsFocus(automationId: string): boolean {
  const active = document.activeElement;
  return (
    active === null ||
    active === document.body ||
    (active instanceof HTMLButtonElement &&
      active.disabled &&
      active.dataset.automationRunId === automationId)
  );
}

function automationRunRefreshOwnsFocus(action: HTMLButtonElement | null): boolean {
  const active = document.activeElement;
  return active === null || active === document.body || active === action;
}
