import {
  AlertTriangle,
  Archive,
  Database,
  History,
  LoaderCircle,
  RotateCcw,
  ShieldCheck,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type {
  DatabaseBackupInfo,
  DatabaseBackupRestoreInput,
  DatabaseBackupRestoreResult,
} from '../../shared/contracts';
import {
  backupReasonLabel,
  createDatabaseBackupRestoreInput,
  formatBackupBytes,
  formatBackupDateTime,
  orderDatabaseBackups,
} from '../data-state';

interface BackupHistoryDialogProps {
  readonly backups: readonly DatabaseBackupInfo[];
  readonly busy: boolean;
  readonly onClose: () => void;
  readonly onRestore: (backup: DatabaseBackupInfo) => void;
}

export function BackupHistoryDialog({
  backups,
  busy,
  onClose,
  onRestore,
}: BackupHistoryDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const orderedBackups = orderDatabaseBackups(backups);

  useEffect(() => {
    const dialog = dialogRef.current;
    const returnTarget =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (dialog && !dialog.open) dialog.showModal();
    const frame = window.requestAnimationFrame(() => closeRef.current?.focus());
    return () => {
      window.cancelAnimationFrame(frame);
      if (dialog?.open) dialog.close();
      if (returnTarget?.isConnected) {
        window.requestAnimationFrame(() => returnTarget.focus());
      }
    };
  }, []);

  return (
    <dialog
      ref={dialogRef}
      className="backup-history-dialog"
      aria-labelledby="backup-history-dialog-title"
      aria-describedby="backup-history-dialog-description"
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
        <span className="backup-history-dialog__icon">
          <History size={19} aria-hidden="true" />
        </span>
        <div>
          <h2 id="backup-history-dialog-title">全部备份</h2>
          <p id="backup-history-dialog-description">
            仅列出 Daily Workbench 在应用私有目录中创建并识别的完整 SQLite 备份。
          </p>
        </div>
        <button
          ref={closeRef}
          type="button"
          aria-label="关闭全部备份"
          onClick={onClose}
          disabled={busy}
        >
          <X size={17} aria-hidden="true" />
        </button>
      </header>

      <div className="backup-history-dialog__notice">
        <ShieldCheck size={16} aria-hidden="true" />
        <p>
          恢复前会再次核对所选备份，并为当前数据库创建安全副本；页面不能选择路径或外部 SQLite 文件。
        </p>
      </div>

      <div className="backup-history-dialog__body">
        {orderedBackups.length === 0 ? (
          <div className="backup-history-dialog__empty" role="status">
            <Archive size={22} aria-hidden="true" />
            <p>暂无可恢复备份。</p>
          </div>
        ) : (
          <ol className="backup-history-list" aria-label="全部可恢复备份">
            {orderedBackups.map((backup) => (
              <li key={backup.id}>
                <span className="backup-history-list__icon">
                  <Archive size={15} aria-hidden="true" />
                </span>
                <div>
                  <strong id={`backup-history-title-${backup.id}`}>
                    {formatBackupDateTime(backup.createdAt)}
                  </strong>
                  <small>
                    {backupReasonLabel(backup.reason)} · Schema v{backup.schemaVersion} ·{' '}
                    {formatBackupBytes(backup.sizeBytes)}
                  </small>
                </div>
                <button
                  type="button"
                  aria-labelledby={`backup-history-restore-${backup.id} backup-history-title-${backup.id}`}
                  id={`backup-history-restore-${backup.id}`}
                  disabled={busy}
                  onClick={() => onRestore(Object.freeze({ ...backup }))}
                >
                  <RotateCcw size={14} aria-hidden="true" />
                  恢复
                </button>
              </li>
            ))}
          </ol>
        )}
      </div>

      <footer>
        <span>{orderedBackups.length.toLocaleString()} 份可用备份</span>
        <button type="button" onClick={onClose} disabled={busy}>
          关闭
        </button>
      </footer>
    </dialog>
  );
}

interface BackupRestoreDialogProps {
  readonly backup: DatabaseBackupInfo;
  readonly busy: boolean;
  readonly onClose: () => void;
  readonly onConfirm: (
    input: DatabaseBackupRestoreInput,
  ) => Promise<DatabaseBackupRestoreResult | null>;
}

export function BackupRestoreDialog({
  backup,
  busy,
  onClose,
  onConfirm,
}: BackupRestoreDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const actionInFlightRef = useRef(false);
  const mountedRef = useRef(true);
  const [target] = useState<DatabaseBackupInfo>(() => Object.freeze({ ...backup }));
  const [acknowledged, setAcknowledged] = useState(false);
  const [localAction, setLocalAction] = useState<'confirm' | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [restarting, setRestarting] = useState(false);
  const effectiveBusy = busy || localAction !== null || restarting;

  useEffect(() => {
    mountedRef.current = true;
    const dialog = dialogRef.current;
    const returnTarget =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (dialog && !dialog.open) dialog.showModal();
    const frame = window.requestAnimationFrame(() => cancelRef.current?.focus());
    return () => {
      mountedRef.current = false;
      window.cancelAnimationFrame(frame);
      if (dialog?.open) dialog.close();
      if (returnTarget?.isConnected) {
        window.requestAnimationFrame(() => returnTarget.focus());
      }
    };
  }, []);

  const confirm = () => {
    if (effectiveBusy || actionInFlightRef.current || !acknowledged) return;
    actionInFlightRef.current = true;
    setLocalAction('confirm');
    setLocalError(null);
    const lockedInput = createDatabaseBackupRestoreInput(target);
    void onConfirm(lockedInput)
      .then((result) => {
        if (!mountedRef.current || result === null) return;
        if (result.status === 'restarting') {
          setRestarting(true);
        } else {
          onClose();
        }
      })
      .catch((error: unknown) => {
        if (!mountedRef.current) return;
        setLocalError(
          error instanceof Error && error.message.trim()
            ? error.message
            : '备份恢复失败；当前数据与所选备份均已保留。',
        );
      })
      .finally(() => {
        actionInFlightRef.current = false;
        if (mountedRef.current) setLocalAction(null);
      });
  };

  return (
    <dialog
      ref={dialogRef}
      className="backup-restore-dialog"
      aria-labelledby="backup-restore-dialog-title"
      aria-describedby="backup-restore-dialog-description"
      aria-busy={effectiveBusy}
      onCancel={(event) => {
        if (effectiveBusy) event.preventDefault();
        else onClose();
      }}
      onClose={() => {
        if (!effectiveBusy) onClose();
      }}
    >
      <header>
        <span className="backup-restore-dialog__warning">
          <AlertTriangle size={20} aria-hidden="true" />
        </span>
        <div>
          <h2 id="backup-restore-dialog-title">确认恢复此备份</h2>
          <p id="backup-restore-dialog-description">
            恢复目标已经锁定。确认后会先备份当前数据库，再安全替换并重启应用。
          </p>
        </div>
        <button type="button" aria-label="取消备份恢复" onClick={onClose} disabled={effectiveBusy}>
          <X size={16} aria-hidden="true" />
        </button>
      </header>

      <div className="backup-restore-dialog__target">
        <Database size={18} aria-hidden="true" />
        <div>
          <strong>{formatBackupDateTime(target.createdAt)}</strong>
          <span>
            {backupReasonLabel(target.reason)} · Schema v{target.schemaVersion} ·{' '}
            {formatBackupBytes(target.sizeBytes)}
          </span>
          <small>备份标识 {target.id.slice(0, 8)}</small>
        </div>
      </div>

      <div className="backup-restore-dialog__semantics">
        <h3>恢复边界</h3>
        <ul>
          <li>当前 SQLite 业务数据会完整回到所选时间点，未包含在备份中的后续更改会消失。</li>
          <li>未结束的专注、自动化运行、浏览器页面和终端会话不会复活。</li>
          <li>本机 API key、浏览器 Cookie 与登录态、下载记录和文件不会回滚。</li>
          <li>现有备份目录不会回滚；当前数据库还会留下新的替换前安全备份。</li>
        </ul>
      </div>

      <label className="backup-restore-dialog__acknowledgement">
        <input
          type="checkbox"
          checked={acknowledged}
          disabled={effectiveBusy}
          onChange={(event) => setAcknowledged(event.target.checked)}
        />
        <span>我了解恢复会完整替换当前数据库，并且应用将自动重启。</span>
      </label>

      {localError ? (
        <p className="backup-restore-dialog__error" role="alert">
          {localError}
        </p>
      ) : null}
      {restarting ? (
        <p className="backup-restore-dialog__restarting" role="status" aria-live="polite">
          <LoaderCircle className="is-spinning" size={15} aria-hidden="true" />
          恢复已安全提交，正在重启 Daily Workbench…
        </p>
      ) : null}

      <footer>
        <span>目标在本次确认期间不会随备份列表刷新而改变。</span>
        <div>
          <button ref={cancelRef} type="button" onClick={onClose} disabled={effectiveBusy}>
            取消
          </button>
          <button
            type="button"
            className="backup-restore-dialog__confirm"
            disabled={effectiveBusy || !acknowledged}
            onClick={confirm}
          >
            {localAction === 'confirm' || busy || restarting ? (
              <LoaderCircle className="is-spinning" size={14} aria-hidden="true" />
            ) : (
              <RotateCcw size={14} aria-hidden="true" />
            )}
            {restarting
              ? '正在重启…'
              : localAction === 'confirm' || busy
                ? '正在安全恢复…'
                : '备份、恢复并重启'}
          </button>
        </div>
      </footer>
    </dialog>
  );
}
