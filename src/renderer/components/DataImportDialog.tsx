import { AlertTriangle, Archive, Database, RotateCw, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { DataImportPreview } from '../../shared/contracts';

interface DataImportDialogProps {
  readonly preview: DataImportPreview;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onCancel: () => void | Promise<void>;
  readonly onConfirm: () => void | Promise<void>;
}

export function DataImportDialog({
  preview,
  busy,
  error,
  onCancel,
  onConfirm,
}: DataImportDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const actionInFlightRef = useRef(false);
  const mountedRef = useRef(true);
  const [acknowledgedImportId, setAcknowledgedImportId] = useState<string | null>(null);
  const [localAction, setLocalAction] = useState<'cancel' | 'confirm' | null>(null);
  const effectiveBusy = busy || localAction !== null;
  const acknowledged = acknowledgedImportId === preview.importId;

  useEffect(() => {
    mountedRef.current = true;
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    const frame = window.requestAnimationFrame(() => cancelRef.current?.focus());
    return () => {
      mountedRef.current = false;
      window.cancelAnimationFrame(frame);
      if (dialog?.open) dialog.close();
    };
  }, []);

  const cancel = () => {
    if (effectiveBusy || actionInFlightRef.current) return;
    actionInFlightRef.current = true;
    setLocalAction('cancel');
    void Promise.resolve(onCancel())
      .catch(() => undefined)
      .finally(() => {
        actionInFlightRef.current = false;
        if (mountedRef.current) setLocalAction(null);
      });
  };

  const confirm = () => {
    if (effectiveBusy || actionInFlightRef.current || !acknowledged) return;
    actionInFlightRef.current = true;
    setLocalAction('confirm');
    void Promise.resolve(onConfirm())
      .catch(() => undefined)
      .finally(() => {
        actionInFlightRef.current = false;
        if (mountedRef.current) setLocalAction(null);
      });
  };

  const counts = preview.counts;
  const totalRecords =
    counts.inboxEntries +
    counts.tasks +
    counts.notes +
    counts.scheduleItems +
    counts.browserTabs +
    counts.browserBookmarks;

  return (
    <dialog
      ref={dialogRef}
      className="data-import-dialog"
      aria-labelledby="data-import-title"
      aria-describedby="data-import-description"
      aria-busy={effectiveBusy}
      onCancel={(event) => {
        event.preventDefault();
        cancel();
      }}
    >
      <header>
        <span className="data-import-dialog__warning">
          <AlertTriangle size={20} aria-hidden="true" />
        </span>
        <div>
          <h2 id="data-import-title">确认替换本地数据</h2>
          <p id="data-import-description">
            文件已通过验证。确认后会先创建导入前备份，再原子替换数据库并重启应用。
          </p>
        </div>
        <button type="button" aria-label="取消导入" onClick={cancel} disabled={effectiveBusy}>
          <X size={16} aria-hidden="true" />
        </button>
      </header>

      <div className="data-import-dialog__source">
        <Database size={17} aria-hidden="true" />
        <div>
          <strong>{preview.currentWorkspaceName}</strong>
          <span>
            导出于 {formatDateTime(preview.exportedAt)} · 应用 {preview.sourceAppVersion} · Schema v
            {preview.sourceSchemaVersion}
          </span>
        </div>
      </div>

      <dl className="data-import-dialog__counts">
        <Count
          label="活动工作区"
          value={Math.max(0, counts.workspaces - counts.archivedWorkspaces)}
        />
        <Count label="归档工作区" value={counts.archivedWorkspaces} />
        <Count label="收件箱" value={counts.inboxEntries} />
        <Count label="任务" value={counts.tasks} />
        <Count label="笔记" value={counts.notes} />
        <Count label="日程" value={counts.scheduleItems} />
        <Count label="浏览器标签" value={counts.browserTabs} />
        <Count label="浏览器收藏" value={counts.browserBookmarks} />
      </dl>

      <div className="data-import-dialog__summary">
        <Archive size={15} aria-hidden="true" />
        <div>
          <span>
            共 {totalRecords.toLocaleString()} 条业务记录
            {preview.includesArchivedData ? '，包含归档数据' : ''}
            {preview.includesBrowserData ? '，包含浏览器数据' : ''}
          </span>
          <small>本机终端 Profile、目录授权与 WSL 选择不会从数据包导入。</small>
        </div>
      </div>

      <label className="data-import-dialog__acknowledgement">
        <input
          type="checkbox"
          checked={acknowledged}
          disabled={effectiveBusy}
          onChange={(event) =>
            setAcknowledgedImportId(event.target.checked ? preview.importId : null)
          }
        />
        <span>我了解当前本地数据会被完整替换，并且应用将自动重启。</span>
      </label>

      {error ? (
        <p className="data-import-dialog__error" role="alert">
          {error}
        </p>
      ) : null}

      <footer>
        <span>预览有效至 {formatDateTime(preview.expiresAt)}</span>
        <div>
          <button ref={cancelRef} type="button" onClick={cancel} disabled={effectiveBusy}>
            {localAction === 'cancel' ? '正在取消…' : '取消'}
          </button>
          <button
            type="button"
            className="data-import-dialog__confirm"
            disabled={effectiveBusy || !acknowledged}
            onClick={confirm}
          >
            {localAction === 'confirm' || busy ? (
              <RotateCw className="is-spinning" size={14} aria-hidden="true" />
            ) : null}
            {localAction === 'confirm' || busy ? '正在安全替换…' : '备份、替换并重启'}
          </button>
        </div>
      </footer>
    </dialog>
  );
}

function Count({ label, value }: { readonly label: string; readonly value: number }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value.toLocaleString()}</dd>
    </div>
  );
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '时间未知';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}
