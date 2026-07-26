import { AlertTriangle, X } from 'lucide-react';
import { taskCreateTitleSummary } from '../task-create-navigation';

interface TaskCreateSyncWarningProps {
  title: string;
  message: string;
  onDismiss: () => void;
}

export function TaskCreateSyncWarning({ title, message, onDismiss }: TaskCreateSyncWarningProps) {
  const summary = taskCreateTitleSummary(title);

  return (
    <article className="task-create-toast task-create-sync-warning" role="alert" aria-atomic="true">
      <AlertTriangle size={18} aria-hidden="true" />
      <div>
        <strong>任务已创建，但列表未同步</strong>
        <span title={summary}>{summary}</span>
      </div>
      <button
        type="button"
        className="task-create-toast__close"
        aria-label={`关闭任务同步警告：“${summary}”`}
        onClick={onDismiss}
      >
        <X size={14} aria-hidden="true" />
      </button>
      <p className="task-create-sync-warning__message">{message}</p>
    </article>
  );
}
