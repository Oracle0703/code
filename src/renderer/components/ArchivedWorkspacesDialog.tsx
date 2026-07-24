import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArchiveRestore, LoaderCircle, RotateCcw, X } from 'lucide-react';
import type { ArchivedWorkspaceInfo } from '../../shared/contracts';
import { createWorkspaceMark } from '../../shared/workspace-domain';
import type { WorkspaceArchiveStatus } from '../workspace-archive-state';

interface ArchivedWorkspacesDialogProps {
  status: WorkspaceArchiveStatus;
  workspaces: readonly ArchivedWorkspaceInfo[];
  loadError: string | null;
  pendingWorkspaceId: string | null;
  onClose: () => void;
  onRetry: () => void;
  onRestore: (workspaceId: string, expectedRevision: number, name: string) => Promise<void>;
}

export function ArchivedWorkspacesDialog({
  status,
  workspaces,
  loadError,
  pendingWorkspaceId,
  onClose,
  onRetry,
  onRestore,
}: ArchivedWorkspacesDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [draftNames, setDraftNames] = useState<Record<string, string>>({});
  const [restoreErrors, setRestoreErrors] = useState<Record<string, string>>({});
  const [feedback, setFeedback] = useState<string | null>(null);
  const busy = pendingWorkspaceId !== null;

  useEffect(() => {
    const dialog = dialogRef.current;
    const returnTarget =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (dialog && !dialog.open) dialog.showModal();
    return () => {
      if (dialog?.open) dialog.close();
      if (returnTarget?.isConnected) returnTarget.focus();
    };
  }, []);

  const restoreWorkspace = async (
    event: FormEvent,
    workspace: ArchivedWorkspaceInfo,
  ): Promise<void> => {
    event.preventDefault();
    if (busy) return;
    const name = (draftNames[workspace.id] ?? workspace.name).trim();
    if (!name) return;
    setFeedback(null);
    setRestoreErrors((current) => ({ ...current, [workspace.id]: '' }));
    try {
      await onRestore(workspace.id, workspace.revision, name);
      setFeedback(`“${name}”已恢复到活动列表；当前工作区没有切换。`);
    } catch (error) {
      setRestoreErrors((current) => ({
        ...current,
        [workspace.id]:
          error instanceof Error && error.message.trim()
            ? error.message
            : '恢复失败；归档数据没有被更改。',
      }));
    }
  };

  return (
    <dialog
      ref={dialogRef}
      className="archived-workspaces-dialog"
      aria-labelledby="archived-workspaces-dialog-title"
      aria-describedby="archived-workspaces-dialog-description"
      aria-busy={busy}
      onCancel={(event) => {
        if (busy) event.preventDefault();
        else onClose();
      }}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <header>
        <span className="archived-workspaces-dialog__icon">
          <ArchiveRestore size={19} aria-hidden="true" />
        </span>
        <div>
          <h2 id="archived-workspaces-dialog-title">管理归档工作区</h2>
          <p id="archived-workspaces-dialog-description">
            恢复会保留原有内容和布局，但不会自动切换当前工作区。
          </p>
        </div>
        <button type="button" aria-label="关闭归档工作区管理" onClick={onClose} disabled={busy}>
          <X size={17} aria-hidden="true" />
        </button>
      </header>

      <div className="archived-workspaces-dialog__notice">
        <strong>恢复后的运行状态</strong>
        <p>归档时停用的自动化不会自动启用；已取消的专注会话不会恢复，可在恢复后重新开始。</p>
      </div>

      <div className="archived-workspaces-dialog__body">
        {status === 'loading' ? (
          <div className="archived-workspaces-dialog__state" role="status" aria-live="polite">
            <LoaderCircle className="is-spinning" size={20} aria-hidden="true" />
            <p>正在读取归档工作区…</p>
          </div>
        ) : status === 'error' ? (
          <div className="archived-workspaces-dialog__state" role="alert">
            <p>{loadError ?? '无法读取归档工作区，请重试。'}</p>
            <button type="button" onClick={onRetry}>
              <RotateCcw size={14} aria-hidden="true" />
              重新加载
            </button>
          </div>
        ) : status === 'ready' && workspaces.length === 0 ? (
          <div className="archived-workspaces-dialog__state" role="status">
            <ArchiveRestore size={22} aria-hidden="true" />
            <p>暂无归档工作区。</p>
          </div>
        ) : (
          <div className="archived-workspaces-list" aria-label="归档工作区列表">
            {workspaces.map((workspace) => {
              const inputId = `restore-workspace-name-${workspace.id}`;
              const errorId = `restore-workspace-error-${workspace.id}`;
              const restoring = pendingWorkspaceId === workspace.id;
              const restoreError = restoreErrors[workspace.id];
              const draftName = draftNames[workspace.id] ?? workspace.name;
              return (
                <form
                  className="archived-workspace-card"
                  key={workspace.id}
                  aria-labelledby={`archived-workspace-title-${workspace.id}`}
                  onSubmit={(event) => void restoreWorkspace(event, workspace)}
                >
                  <div
                    className="archived-workspace-card__mark"
                    style={{ backgroundColor: workspace.color }}
                    aria-hidden="true"
                  >
                    {createWorkspaceMark(workspace.name)}
                  </div>
                  <div className="archived-workspace-card__content">
                    <div className="archived-workspace-card__heading">
                      <strong id={`archived-workspace-title-${workspace.id}`}>
                        {workspace.name}
                      </strong>
                      <time dateTime={workspace.archivedAt}>
                        {formatArchiveTimestamp(workspace.archivedAt)}
                      </time>
                    </div>
                    <label htmlFor={inputId}>恢复后的名称</label>
                    <div className="archived-workspace-card__action">
                      <input
                        id={inputId}
                        value={draftName}
                        maxLength={80}
                        required
                        disabled={busy}
                        aria-invalid={restoreError ? 'true' : undefined}
                        aria-describedby={restoreError ? errorId : undefined}
                        onChange={(event) => {
                          const name = event.target.value;
                          setDraftNames((current) => ({ ...current, [workspace.id]: name }));
                          if (restoreError) {
                            setRestoreErrors((current) => ({ ...current, [workspace.id]: '' }));
                          }
                        }}
                      />
                      <button type="submit" disabled={busy || draftName.trim().length === 0}>
                        <ArchiveRestore size={14} aria-hidden="true" />
                        {restoring ? '恢复中…' : '恢复'}
                      </button>
                    </div>
                    {restoreError ? (
                      <p id={errorId} className="archived-workspace-card__error" role="alert">
                        {restoreError}
                      </p>
                    ) : null}
                  </div>
                </form>
              );
            })}
          </div>
        )}
      </div>

      <footer>
        <p role="status" aria-live="polite">
          {feedback}
        </p>
        <button type="button" onClick={onClose} disabled={busy}>
          关闭
        </button>
      </footer>
    </dialog>
  );
}

function formatArchiveTimestamp(value: string): string {
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime())) return '归档时间未知';
  return `归档于 ${new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(timestamp)}`;
}
