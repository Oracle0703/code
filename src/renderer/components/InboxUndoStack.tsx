import { AlertTriangle, LoaderCircle, RefreshCw, RotateCcw, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import type { InboxUndoNotice } from '../hooks/useInboxController';

interface InboxUndoStackProps {
  readonly children?: ReactNode;
  readonly notices: readonly InboxUndoNotice[];
  readonly pendingTokens: ReadonlySet<string>;
  readonly focusBlocked: boolean;
  readonly blocked: boolean;
  readonly blockedReason?: string | null;
  readonly workspaceLeasePending: boolean;
  readonly workspaceLeaseBlockedReason: string;
  readonly workspaceRecoveryPending: boolean;
  readonly workspaceRecoveryBlockedReason: string;
  readonly onUndo: (notice: InboxUndoNotice) => Promise<void>;
  readonly onRefresh: (notice: InboxUndoNotice) => Promise<void>;
  readonly onDismiss: (undoToken: string) => void;
  readonly onFocusFallback: (notice: InboxUndoNotice) => void;
}

export function InboxUndoStack({
  children,
  notices,
  pendingTokens,
  focusBlocked,
  blocked,
  blockedReason = null,
  workspaceLeasePending,
  workspaceLeaseBlockedReason,
  workspaceRecoveryPending,
  workspaceRecoveryBlockedReason,
  onUndo,
  onRefresh,
  onDismiss,
  onFocusFallback,
}: InboxUndoStackProps) {
  return (
    <section className="inbox-undo-stack" aria-label="操作通知">
      {children}
      {notices.map((notice) => {
        const pending = pendingTokens.has(notice.undoToken);
        const blockedByOtherLease = workspaceLeasePending && !pending && !notice.refreshing;
        const blockedByRecovery = workspaceRecoveryPending && notice.phase === 'archived';
        return (
          <InboxUndoNoticeCard
            notice={notice}
            pending={pending}
            focusBlocked={focusBlocked}
            blocked={blocked || blockedByOtherLease || blockedByRecovery}
            blockedReason={
              blocked
                ? blockedReason
                : blockedByOtherLease
                  ? workspaceLeaseBlockedReason
                  : blockedByRecovery
                    ? workspaceRecoveryBlockedReason
                    : null
            }
            onUndo={onUndo}
            onRefresh={onRefresh}
            onDismiss={onDismiss}
            onFocusFallback={onFocusFallback}
            key={notice.undoToken}
          />
        );
      })}
    </section>
  );
}

interface InboxUndoNoticeCardProps {
  readonly notice: InboxUndoNotice;
  readonly pending: boolean;
  readonly focusBlocked: boolean;
  readonly blocked: boolean;
  readonly blockedReason: string | null;
  readonly onUndo: (notice: InboxUndoNotice) => Promise<void>;
  readonly onRefresh: (notice: InboxUndoNotice) => Promise<void>;
  readonly onDismiss: (undoToken: string) => void;
  readonly onFocusFallback: (notice: InboxUndoNotice) => void;
}

function InboxUndoNoticeCard({
  notice,
  pending,
  focusBlocked,
  blocked,
  blockedReason,
  onUndo,
  onRefresh,
  onDismiss,
  onFocusFallback,
}: InboxUndoNoticeCardProps) {
  const actionRequestedRef = useRef(false);
  const refreshFocusContextRef = useRef(false);
  const previousRefreshErrorRef = useRef(notice.refreshError);
  const noticeElementRef = useRef<HTMLElement>(null);
  const undoActionRef = useRef<HTMLButtonElement>(null);
  const refreshActionRef = useRef<HTMLButtonElement>(null);
  const closeActionRef = useRef<HTMLButtonElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const focusedActionKeyRef = useRef<string | null>(null);
  const noticeOwnedFocusRef = useRef(false);
  const focusBlockedRef = useRef(focusBlocked);
  const latestNoticeRef = useRef(notice);
  const focusFallbackRef = useRef(onFocusFallback);
  const recovery = notice.phase !== 'archived';
  const busy = pending || notice.refreshing;
  const actionsDisabled = blocked || busy;
  const summary = inboxUndoContentSummary(notice.entry.content);
  const identity = `${notice.undoToken}:${notice.phase}:${notice.undoAvailable ? 'undo' : 'expired'}`;
  const messageId = `inbox-undo-${notice.undoToken}-message`;
  const reasonId = `inbox-undo-${notice.undoToken}-disabled-reason`;
  const errorId = `inbox-undo-${notice.undoToken}-refresh-error`;
  const disabledReason = inboxUndoDisabledReason(
    notice.phase,
    pending,
    notice.refreshing,
    blocked,
    blockedReason,
  );
  const describedBy = [
    recovery ? messageId : null,
    disabledReason === null ? null : reasonId,
    notice.refreshError === null ? null : errorId,
  ]
    .filter((value): value is string => value !== null)
    .join(' ');

  useLayoutEffect(() => {
    focusBlockedRef.current = focusBlocked;
    latestNoticeRef.current = notice;
    focusFallbackRef.current = onFocusFallback;
  }, [focusBlocked, notice, onFocusFallback]);

  useEffect(() => {
    if (
      !notice.focusActionOnMount ||
      focusBlocked ||
      actionsDisabled ||
      notice.refreshError !== null ||
      focusedActionKeyRef.current === identity ||
      !inboxUndoNoticeOwnsFocus(
        document.activeElement,
        document.body,
        noticeElementRef.current,
        notice.entry.id,
      )
    ) {
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      const action = inboxUndoPrimaryAction(
        notice.phase,
        notice.undoAvailable,
        undoActionRef.current,
        refreshActionRef.current,
        closeActionRef.current,
      );
      if (
        action === null ||
        action.disabled ||
        !inboxUndoNoticeOwnsFocus(
          document.activeElement,
          document.body,
          noticeElementRef.current,
          notice.entry.id,
        )
      ) {
        return;
      }
      action.focus({ preventScroll: true });
      if (document.activeElement === action) {
        focusedActionKeyRef.current = identity;
        noticeOwnedFocusRef.current = true;
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [
    actionsDisabled,
    focusBlocked,
    identity,
    notice.entry.id,
    notice.focusActionOnMount,
    notice.phase,
    notice.refreshError,
    notice.undoAvailable,
  ]);

  useEffect(() => {
    const previousRefreshError = previousRefreshErrorRef.current;
    previousRefreshErrorRef.current = notice.refreshError;
    if (previousRefreshError !== null || notice.refreshError === null) return;
    if (
      focusBlocked ||
      !refreshFocusContextRef.current ||
      !inboxUndoNoticeOwnsFocus(document.activeElement, document.body, noticeElementRef.current)
    ) {
      refreshFocusContextRef.current = false;
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      const error = errorRef.current;
      if (
        error !== null &&
        inboxUndoNoticeOwnsFocus(document.activeElement, document.body, noticeElementRef.current)
      ) {
        error.focus({ preventScroll: true });
        if (document.activeElement === error) noticeOwnedFocusRef.current = true;
      }
      refreshFocusContextRef.current = false;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [focusBlocked, notice.refreshError]);

  useLayoutEffect(
    () => () => {
      const noticeElement = noticeElementRef.current;
      const activeElement = document.activeElement;
      const ownsFocus =
        noticeOwnedFocusRef.current ||
        refreshFocusContextRef.current ||
        (activeElement !== null && noticeElement?.contains(activeElement) === true);
      if (focusBlockedRef.current || !ownsFocus) return;
      window.requestAnimationFrame(() => focusFallbackRef.current(latestNoticeRef.current));
    },
    [notice.undoToken],
  );

  const runAction = async (action: (current: InboxUndoNotice) => Promise<void>): Promise<void> => {
    if (blocked || pending || notice.refreshing || actionRequestedRef.current) return;
    actionRequestedRef.current = true;
    refreshFocusContextRef.current =
      document.activeElement !== null &&
      noticeElementRef.current?.contains(document.activeElement) === true;
    try {
      await action(notice);
    } catch {
      // The controller owns the visible failure or post-commit recovery state.
    } finally {
      actionRequestedRef.current = false;
    }
  };

  const heading =
    notice.phase === 'archived'
      ? '已归档'
      : notice.phase === 'archive-recovery'
        ? '记录已归档，但列表未同步'
        : '归档已撤销，但列表未同步';
  const recoveryMessage =
    notice.phase === 'archive-recovery'
      ? '归档已经提交，请不要重复归档。请重新读取并确认收件箱；撤销窗口未结束时仍可撤销。'
      : notice.phase === 'undo-recovery'
        ? '撤销已经提交，请不要重复撤销。请重新读取并确认收件箱。'
        : null;

  return (
    <article
      ref={noticeElementRef}
      className={`inbox-undo-toast${recovery ? ' inbox-undo-toast--recovery' : ''}`}
      role={recovery ? 'alert' : 'status'}
      aria-live={recovery ? undefined : 'polite'}
      aria-atomic="true"
      aria-busy={busy}
      onFocusCapture={() => {
        noticeOwnedFocusRef.current = true;
      }}
      onBlurCapture={(event) => {
        noticeOwnedFocusRef.current = false;
        if (
          event.relatedTarget instanceof Node &&
          !noticeElementRef.current?.contains(event.relatedTarget)
        ) {
          refreshFocusContextRef.current = false;
        }
      }}
    >
      {recovery ? <AlertTriangle size={18} aria-hidden="true" /> : null}
      <div className="inbox-undo-toast__content">
        <strong>{heading}</strong>
        <span title={summary}>{summary}</span>
        {recoveryMessage ? (
          <p id={messageId} className="inbox-undo-toast__message">
            {recoveryMessage}
          </p>
        ) : null}
        {notice.phase === 'archive-recovery' && !notice.undoAvailable ? (
          <p className="inbox-undo-toast__message">本次撤销窗口已结束；请重新读取确认归档结果。</p>
        ) : null}
        {disabledReason ? (
          <p id={reasonId} className="inbox-undo-toast__message inbox-undo-toast__disabled-reason">
            {disabledReason}
          </p>
        ) : null}
        {notice.refreshError ? (
          <p id={errorId} ref={errorRef} className="inbox-undo-toast__error" tabIndex={-1}>
            {notice.refreshError}
          </p>
        ) : null}
      </div>
      <div className="inbox-undo-toast__actions">
        {recovery ? (
          <button
            ref={refreshActionRef}
            type="button"
            className="inbox-undo-toast__action inbox-undo-toast__refresh"
            aria-label={`重新读取收件箱并确认：“${summary}”`}
            aria-describedby={describedBy || undefined}
            aria-busy={notice.refreshing}
            disabled={actionsDisabled}
            onClick={() => void runAction(onRefresh)}
          >
            {notice.refreshing ? (
              <LoaderCircle className="is-spinning" size={14} aria-hidden="true" />
            ) : (
              <RefreshCw size={14} aria-hidden="true" />
            )}
            {notice.refreshing ? '正在读取…' : '重新读取'}
          </button>
        ) : null}
        {notice.undoAvailable && notice.phase !== 'undo-recovery' ? (
          <button
            ref={undoActionRef}
            type="button"
            className="inbox-undo-toast__action"
            aria-label={`撤销归档：“${summary}”`}
            aria-describedby={describedBy || undefined}
            disabled={actionsDisabled}
            onClick={() => void runAction(onUndo)}
          >
            <RotateCcw size={14} aria-hidden="true" />
            {pending ? '撤销中…' : '撤销'}
          </button>
        ) : null}
      </div>
      {!recovery ? (
        <button
          ref={closeActionRef}
          type="button"
          className="inbox-undo-toast__close"
          aria-label={`关闭归档通知：“${summary}”`}
          aria-describedby={disabledReason === null ? undefined : reasonId}
          disabled={actionsDisabled}
          onClick={() => onDismiss(notice.undoToken)}
        >
          <X size={14} aria-hidden="true" />
        </button>
      ) : null}
      {notice.undoAvailable ? (
        <time className="sr-only" dateTime={notice.undoExpiresAt}>
          撤销截止时间 {notice.undoExpiresAt}
        </time>
      ) : null}
    </article>
  );
}

function inboxUndoDisabledReason(
  phase: InboxUndoNotice['phase'],
  pending: boolean,
  refreshing: boolean,
  blocked: boolean,
  blockedReason: string | null,
): string | null {
  if (blocked) return blockedReason ?? '当前数据操作完成后，才能继续处理这条归档通知。';
  if (refreshing) return '正在重新读取收件箱，请稍候。';
  if (!pending) return null;
  return phase === 'undo-recovery'
    ? '正在确认已提交的撤销，请稍候。'
    : '正在处理或确认这次归档撤销，请稍候。';
}

function inboxUndoPrimaryAction(
  phase: InboxUndoNotice['phase'],
  undoAvailable: boolean,
  undoAction: HTMLButtonElement | null,
  refreshAction: HTMLButtonElement | null,
  closeAction: HTMLButtonElement | null,
): HTMLButtonElement | null {
  if (phase !== 'archived') return refreshAction ?? (undoAvailable ? undoAction : null);
  return undoAvailable ? undoAction : closeAction;
}

function inboxUndoContentSummary(content: string, maxLength = 96): string {
  const normalized = content.trim().replace(/\s+/gu, ' ') || '未命名收件箱记录';
  const characters = Array.from(normalized);
  return characters.length <= maxLength
    ? normalized
    : `${characters.slice(0, maxLength).join('')}…`;
}

// Exported for deterministic focus ownership tests without mounting a browser DOM.
// eslint-disable-next-line react-refresh/only-export-components
export function inboxUndoNoticeOwnsFocus(
  activeElement: Element | null,
  body: HTMLElement | null,
  notice: HTMLElement | null,
  archiveEntryId?: string,
): boolean {
  return (
    activeElement === null ||
    activeElement === body ||
    (activeElement !== null && notice?.contains(activeElement) === true) ||
    (archiveEntryId !== undefined &&
      activeElement instanceof HTMLElement &&
      activeElement.dataset.inboxArchiveId === archiveEntryId)
  );
}
