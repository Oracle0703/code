import { RotateCcw, X } from 'lucide-react';
import type { InboxUndoNotice } from '../hooks/useInboxController';

interface InboxUndoStackProps {
  notices: readonly InboxUndoNotice[];
  pendingTokens: ReadonlySet<string>;
  onUndo: (notice: InboxUndoNotice) => Promise<void>;
  onDismiss: (undoToken: string) => void;
}

export function InboxUndoStack({ notices, pendingTokens, onUndo, onDismiss }: InboxUndoStackProps) {
  return (
    <section className="inbox-undo-stack" aria-label="收件箱操作通知" aria-live="polite">
      {notices.map((notice) => (
        <div className="inbox-undo-toast" key={notice.undoToken}>
          <div>
            <strong>已归档</strong>
            <span>{notice.content}</span>
          </div>
          <button
            type="button"
            className="inbox-undo-toast__action"
            disabled={pendingTokens.has(notice.undoToken)}
            onClick={() => void onUndo(notice).catch(() => undefined)}
          >
            <RotateCcw size={14} />
            {pendingTokens.has(notice.undoToken) ? '撤销中…' : '撤销'}
          </button>
          <button
            type="button"
            className="inbox-undo-toast__close"
            aria-label="关闭通知"
            onClick={() => onDismiss(notice.undoToken)}
          >
            <X size={14} />
          </button>
        </div>
      ))}
    </section>
  );
}
