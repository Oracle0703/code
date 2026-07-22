import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Archive, FolderPlus, Pencil, X } from 'lucide-react';
import { WORKSPACE_COLORS, type WorkspaceColor, type WorkspaceInfo } from '../../shared/contracts';

export type WorkspaceDialogState =
  | { mode: 'create'; suggestedColor: WorkspaceColor }
  | { mode: 'rename'; workspace: WorkspaceInfo }
  | { mode: 'archive'; workspace: WorkspaceInfo; switchesWorkspace: boolean };

interface WorkspaceDialogProps {
  state: WorkspaceDialogState;
  onClose: () => void;
  onCreate: (name: string, color: WorkspaceColor) => Promise<void>;
  onRename: (workspaceId: string, name: string) => Promise<void>;
  onArchive: (workspaceId: string) => Promise<void>;
}

export function WorkspaceDialog({
  state,
  onClose,
  onCreate,
  onRename,
  onArchive,
}: WorkspaceDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState(state.mode === 'rename' ? state.workspace.name : '');
  const [color, setColor] = useState<WorkspaceColor>(
    state.mode === 'create' ? state.suggestedColor : WORKSPACE_COLORS[0],
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => {
      if (dialog?.open) dialog.close();
    };
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      if (state.mode === 'create') {
        await onCreate(name, color);
      } else if (state.mode === 'rename') {
        await onRename(state.workspace.id, name);
      } else {
        await onArchive(state.workspace.id);
      }
      onClose();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : '操作失败，请重试。');
    } finally {
      setSubmitting(false);
    }
  };

  const title =
    state.mode === 'create'
      ? '新建工作区'
      : state.mode === 'rename'
        ? '重命名工作区'
        : '归档工作区';
  const Icon = state.mode === 'create' ? FolderPlus : state.mode === 'rename' ? Pencil : Archive;

  return (
    <dialog
      ref={dialogRef}
      className="workspace-dialog"
      aria-labelledby="workspace-dialog-title"
      onCancel={(event) => {
        if (submitting) event.preventDefault();
        else onClose();
      }}
      onClose={() => {
        if (!submitting) onClose();
      }}
    >
      <form onSubmit={(event) => void submit(event)}>
        <header>
          <span className="workspace-dialog__icon">
            <Icon size={18} aria-hidden="true" />
          </span>
          <div>
            <h2 id="workspace-dialog-title">{title}</h2>
            <p>
              {state.mode === 'archive'
                ? '归档会保留 SQLite 数据并从活动列表隐藏；当前版本尚无恢复入口。'
                : '工作区名称和布局只保存在这台设备。'}
            </p>
          </div>
          <button type="button" aria-label="关闭" onClick={onClose} disabled={submitting}>
            <X size={16} />
          </button>
        </header>

        {state.mode === 'archive' ? (
          <div className="workspace-dialog__archive-copy">
            <strong>{state.workspace.name}</strong>
            <p>
              {state.switchesWorkspace
                ? '这是当前工作区。归档后会自动切换到另一个活动工作区。'
                : '归档后当前工作区不会改变。'}
            </p>
          </div>
        ) : (
          <div className="workspace-dialog__fields">
            <label>
              <span>工作区名称</span>
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={80}
                autoFocus
                required
                disabled={submitting}
                onFocus={(event) => {
                  if (state.mode === 'rename') event.currentTarget.select();
                }}
              />
            </label>
            {state.mode === 'create' ? (
              <fieldset>
                <legend>标识颜色</legend>
                <div className="workspace-color-options">
                  {WORKSPACE_COLORS.map((option) => (
                    <label
                      key={option}
                      style={{ '--workspace-color': option } as React.CSSProperties}
                    >
                      <input
                        type="radio"
                        name="workspace-color"
                        value={option}
                        checked={color === option}
                        onChange={() => setColor(option)}
                        disabled={submitting}
                      />
                      <span aria-hidden="true" />
                      <span className="sr-only">颜色 {option}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
            ) : null}
          </div>
        )}

        {error ? (
          <p className="workspace-dialog__error" role="alert">
            {error}
          </p>
        ) : null}

        <footer>
          <button
            type="button"
            className="workspace-dialog__cancel"
            onClick={onClose}
            disabled={submitting}
          >
            取消
          </button>
          <button
            type="submit"
            className={
              state.mode === 'archive' ? 'workspace-dialog__danger' : 'workspace-dialog__primary'
            }
            disabled={submitting || (state.mode !== 'archive' && name.trim().length === 0)}
          >
            {submitting ? '正在保存…' : state.mode === 'archive' ? '确认归档' : '保存'}
          </button>
        </footer>
      </form>
    </dialog>
  );
}
