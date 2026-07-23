import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Inbox, X } from 'lucide-react';
import type { InboxCategory } from '../../shared/contracts';
import { INBOX_CONTENT_MAX_LENGTH } from '../../shared/inbox-domain';
import { isQuickCaptureShortcut } from '../../shared/quick-capture-shortcut';

export interface QuickCaptureTarget {
  readonly workspaceId: string;
  readonly workspaceName: string;
}

interface QuickCaptureDialogProps {
  target: QuickCaptureTarget;
  onClose: () => void;
  onSubmit: (workspaceId: string, content: string, category: InboxCategory) => Promise<void>;
}

export function QuickCaptureDialog({ target, onClose, onSubmit }: QuickCaptureDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [content, setContent] = useState('');
  const [category, setCategory] = useState<InboxCategory>('uncategorized');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const contentLength = Array.from(content.trim()).length;
  const contentTooLong = contentLength > INBOX_CONTENT_MAX_LENGTH;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => {
      window.cancelAnimationFrame(frame);
      if (dialog?.open) dialog.close();
    };
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (submitting || content.trim().length === 0 || contentTooLong) return;
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit(target.workspaceId, content, category);
      onClose();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : '快速记录失败，请重试。');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <dialog
      ref={dialogRef}
      className="quick-capture-dialog"
      aria-labelledby="quick-capture-dialog-title"
      aria-describedby="quick-capture-dialog-description"
      onCancel={(event) => {
        if (submitting) event.preventDefault();
        else onClose();
      }}
      onClose={() => {
        if (!submitting) onClose();
      }}
      onKeyDown={(event) => {
        if (
          isQuickCaptureShortcut({
            type: 'keyDown',
            key: event.key,
            control: event.ctrlKey,
            meta: event.metaKey,
            alt: event.altKey,
            shift: event.shiftKey,
            repeat: event.repeat,
            composing: event.nativeEvent.isComposing,
          })
        ) {
          event.preventDefault();
          inputRef.current?.focus();
        }
      }}
    >
      <form onSubmit={(event) => void submit(event)}>
        <header>
          <span className="quick-capture-dialog__icon">
            <Inbox size={18} aria-hidden="true" />
          </span>
          <div>
            <h2 id="quick-capture-dialog-title">快速记录</h2>
            <p id="quick-capture-dialog-description">
              保存到 <strong>{target.workspaceName}</strong> 的收件箱
            </p>
          </div>
          <button type="button" aria-label="关闭" onClick={onClose} disabled={submitting}>
            <X size={16} />
          </button>
        </header>

        <div className="quick-capture-dialog__fields">
          <label>
            <span>记录内容</span>
            <input
              ref={inputRef}
              value={content}
              onChange={(event) => setContent(event.target.value)}
              placeholder="写下待办、想法或链接…"
              autoComplete="off"
              disabled={submitting}
              aria-invalid={contentTooLong}
              aria-describedby="quick-capture-content-limit"
              required
            />
          </label>
          <label>
            <span>处理方向</span>
            <select
              value={category}
              onChange={(event) => setCategory(event.target.value as InboxCategory)}
              disabled={submitting}
            >
              <option value="uncategorized">暂不分类</option>
              <option value="task">任务线索</option>
              <option value="note">笔记</option>
              <option value="link">链接</option>
            </select>
          </label>
        </div>

        <div className="quick-capture-dialog__hint">
          <span
            id="quick-capture-content-limit"
            className={contentTooLong ? 'is-error' : undefined}
          >
            {contentTooLong
              ? `内容最多 ${INBOX_CONTENT_MAX_LENGTH} 个字符，当前 ${contentLength} 个`
              : `${contentLength} / ${INBOX_CONTENT_MAX_LENGTH}`}
          </span>
          <span>分类不会直接创建任务或笔记</span>
        </div>

        {error ? (
          <p className="quick-capture-dialog__error" role="alert">
            {error}
          </p>
        ) : null}

        <footer>
          <span>
            <kbd>Enter</kbd> 保存 · <kbd>Esc</kbd> 取消
          </span>
          <button
            type="submit"
            className="quick-capture-dialog__primary"
            disabled={submitting || content.trim().length === 0 || contentTooLong}
          >
            {submitting ? '正在保存…' : '加入收件箱'}
          </button>
        </footer>
      </form>
    </dialog>
  );
}
