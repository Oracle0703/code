import { AlertTriangle, LoaderCircle, RefreshCw } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef } from 'react';
import type { DatabaseBackupInfo } from '../../shared/contracts';
import { backupReasonLabel, formatBackupBytes, formatBackupDateTime } from '../data-state';

export interface BackupCreateSyncWarningProps {
  readonly backup: DatabaseBackupInfo;
  readonly focusActionOnMount: boolean;
  readonly focusBlocked: boolean;
  readonly blocked: boolean;
  readonly refreshing: boolean;
  readonly refreshError: string | null;
  readonly onRefresh: () => void | Promise<void>;
  readonly onFocusFallback: () => void;
}

export function BackupCreateSyncWarning({
  backup,
  focusActionOnMount,
  focusBlocked,
  blocked,
  refreshing,
  refreshError,
  onRefresh,
  onFocusFallback,
}: BackupCreateSyncWarningProps) {
  const refreshRequestedRef = useRef(false);
  const refreshFocusContextRef = useRef(false);
  const previousRefreshErrorRef = useRef(refreshError);
  const actionRef = useRef<HTMLButtonElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const warningRef = useRef<HTMLElement>(null);
  const actionFocusedRef = useRef(false);
  const warningOwnedFocusRef = useRef(false);
  const focusBlockedRef = useRef(focusBlocked);
  const createdAt = formatBackupDateTime(backup.createdAt);
  const size = formatBackupBytes(backup.sizeBytes);
  const summary = `${createdAt} · ${size} · ${backupReasonLabel(backup.reason)} · Schema v${backup.schemaVersion.toLocaleString()}`;
  const messageId = 'backup-create-sync-warning-message';
  const errorId = 'backup-create-sync-warning-error';

  useLayoutEffect(() => {
    focusBlockedRef.current = focusBlocked;
  }, [focusBlocked]);

  useEffect(() => {
    if (
      !focusActionOnMount ||
      focusBlocked ||
      blocked ||
      refreshing ||
      refreshError !== null ||
      actionFocusedRef.current ||
      !backupCreateSyncWarningOwnsFocus(document.activeElement, document.body, actionRef.current)
    ) {
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      const action = actionRef.current;
      if (
        action === null ||
        !backupCreateSyncWarningOwnsFocus(document.activeElement, document.body, action)
      ) {
        return;
      }
      action.focus({ preventScroll: true });
      if (document.activeElement === action) actionFocusedRef.current = true;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [backup.id, blocked, focusActionOnMount, focusBlocked, refreshError, refreshing]);

  useEffect(() => {
    const previousRefreshError = previousRefreshErrorRef.current;
    previousRefreshErrorRef.current = refreshError;
    if (previousRefreshError !== null || refreshError === null) return;
    if (
      focusBlocked ||
      !refreshFocusContextRef.current ||
      !backupCreateSyncWarningOwnsFocus(document.activeElement, document.body, actionRef.current)
    ) {
      refreshFocusContextRef.current = false;
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      const error = errorRef.current;
      if (
        error !== null &&
        backupCreateSyncWarningOwnsFocus(document.activeElement, document.body, actionRef.current)
      ) {
        error.focus({ preventScroll: true });
      }
      refreshFocusContextRef.current = false;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [focusBlocked, refreshError]);

  useLayoutEffect(
    () => () => {
      if (
        focusBlockedRef.current ||
        (!warningOwnedFocusRef.current && !refreshFocusContextRef.current)
      ) {
        return;
      }
      window.requestAnimationFrame(onFocusFallback);
    },
    [onFocusFallback],
  );

  const refresh = async (): Promise<void> => {
    if (blocked || refreshing || refreshRequestedRef.current) return;
    refreshRequestedRef.current = true;
    refreshFocusContextRef.current = document.activeElement === actionRef.current;
    try {
      await onRefresh();
    } catch {
      // The App owns the durable warning error so it survives surface changes.
    } finally {
      refreshRequestedRef.current = false;
    }
  };

  return (
    <article
      ref={warningRef}
      className="task-create-toast task-create-sync-warning backup-create-sync-warning"
      role="alert"
      aria-atomic="true"
      aria-busy={refreshing}
      onFocusCapture={() => {
        warningOwnedFocusRef.current = true;
      }}
      onBlurCapture={(event) => {
        warningOwnedFocusRef.current = false;
        if (
          event.relatedTarget instanceof Node &&
          !warningRef.current?.contains(event.relatedTarget)
        ) {
          refreshFocusContextRef.current = false;
        }
      }}
    >
      <AlertTriangle size={18} aria-hidden="true" />
      <div>
        <strong>备份已创建，但列表未同步</strong>
        <span title={summary}>
          <time dateTime={backup.createdAt}>{createdAt}</time> · {size} ·{' '}
          {backupReasonLabel(backup.reason)} · Schema v{backup.schemaVersion.toLocaleString()}
        </span>
        <p id={messageId} className="task-create-sync-warning__message">
          请重新读取并确认备份列表；备份已经创建，请勿重复创建。
        </p>
      </div>
      <button
        ref={actionRef}
        type="button"
        className="task-create-toast__action backup-create-sync-warning__action"
        aria-label={`重新读取备份列表并确认：${summary}`}
        aria-describedby={refreshError === null ? messageId : `${messageId} ${errorId}`}
        aria-busy={refreshing}
        disabled={blocked || refreshing}
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
          className="task-create-toast__error backup-create-sync-warning__error"
          tabIndex={-1}
        >
          {refreshError}
        </p>
      ) : null}
    </article>
  );
}

// Exported for deterministic focus ownership tests without mounting a browser DOM.
// eslint-disable-next-line react-refresh/only-export-components
export function backupCreateSyncWarningOwnsFocus(
  activeElement: Element | null,
  body: HTMLElement | null,
  action: HTMLButtonElement | null,
): boolean {
  return (
    activeElement === null ||
    activeElement === body ||
    activeElement === action ||
    (activeElement.getAttribute('data-backup-create-action') === 'manual' &&
      activeElement.getAttribute('disabled') !== null)
  );
}
