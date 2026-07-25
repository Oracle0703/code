import type { FocusTaskSelection } from './focus-state';

export interface FocusDialogSubmissionGate {
  mounted: boolean;
  submitting: boolean;
}

interface FocusDialogSubmissionCallbacks {
  readonly onStart: (taskId?: string) => Promise<void>;
  readonly onSubmittingChange: (submitting: boolean) => void;
  readonly onError: (error: string | null) => void;
  readonly onSucceeded: () => void;
}

export function unavailableFocusTaskMessage(taskLabel: string): string {
  return `“${taskLabel || '原任务'}”已完成、改期或不再可用。请选择另一项今日任务，或显式选择自由专注（不关联任务）。`;
}

export async function submitFocusDialogSelection(
  gate: FocusDialogSubmissionGate,
  selection: FocusTaskSelection,
  startBlockedReason: string | null,
  taskLabel: string,
  callbacks: FocusDialogSubmissionCallbacks,
): Promise<void> {
  if (!gate.mounted || gate.submitting) return;
  if (startBlockedReason !== null) {
    callbacks.onError(startBlockedReason);
    return;
  }
  if (selection.invalid) {
    callbacks.onError(unavailableFocusTaskMessage(taskLabel));
    return;
  }

  gate.submitting = true;
  callbacks.onSubmittingChange(true);
  callbacks.onError(null);
  try {
    await callbacks.onStart(selection.taskId);
    if (gate.mounted) callbacks.onSucceeded();
  } catch (submitError) {
    if (!gate.mounted) return;
    callbacks.onError(
      submitError instanceof Error && submitError.message.trim()
        ? submitError.message
        : '无法开始专注，请重试。',
    );
  } finally {
    gate.submitting = false;
    if (gate.mounted) callbacks.onSubmittingChange(false);
  }
}
