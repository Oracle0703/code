import type { Note, NoteSnapshot, Task, TaskSnapshot } from '../shared/contracts';
import type { AutomationRunFeedback, AutomationWorkspaceIdentity } from './automation-state';

export type AutomationRunOutputIdentity = Pick<
  AutomationRunFeedback,
  'workspaceId' | 'outputKind' | 'outputId'
>;

export interface AutomationRunSnapshotRefresh<Snapshot> {
  readonly snapshot: Snapshot;
  readonly commit: () => boolean;
}

export interface AutomationRunReconciliationInput {
  readonly feedback: Readonly<AutomationRunOutputIdentity>;
  readonly getCommittedTaskSnapshot: () => TaskSnapshot | null;
  readonly getCommittedNoteSnapshot: () => NoteSnapshot | null;
  readonly prepareTaskSnapshotRefresh: () => Promise<AutomationRunSnapshotRefresh<TaskSnapshot>>;
  readonly prepareNoteSnapshotRefresh: () => Promise<AutomationRunSnapshotRefresh<NoteSnapshot>>;
  readonly isCurrent: () => boolean;
}

export type AutomationRunReconciledOutput =
  | {
      readonly kind: 'task';
      readonly workspaceId: string;
      readonly task: Task;
    }
  | {
      readonly kind: 'note';
      readonly workspaceId: string;
      readonly note: Note;
    };

export interface AutomationRunReconciliation {
  readonly output: AutomationRunReconciledOutput | null;
  readonly committed: boolean;
  readonly error: unknown;
}

export interface AutomationRunReconciliationIntent {
  readonly generation: number;
  readonly workspace: AutomationWorkspaceIdentity;
  readonly workspaceId: string;
  readonly key: string;
}

export class AutomationRunReconciliationSupersededError extends Error {
  constructor() {
    super('The automation run reconciliation is no longer current.');
    this.name = 'AutomationRunReconciliationSupersededError';
  }
}

export class AutomationRunOutputUnavailableError extends Error {
  constructor(outputKind: AutomationRunOutputIdentity['outputKind']) {
    super(`The exact ${outputKind} output was not returned by the authoritative snapshot.`);
    this.name = 'AutomationRunOutputUnavailableError';
  }
}

export class AutomationRunSnapshotCommitError extends Error {
  constructor(outputKind: AutomationRunOutputIdentity['outputKind']) {
    super(`The authoritative ${outputKind} snapshot could not be committed.`);
    this.name = 'AutomationRunSnapshotCommitError';
  }
}

/**
 * Keeps both an immediate run and any later recovery single-flight per workspace.
 * Activation object identity is part of currency, so leaving and re-entering the
 * same workspace does not revive an intent created by the earlier activation.
 */
export class AutomationRunReconciliationCoordinator {
  #generation = 0;
  readonly #pending = new Map<string, AutomationRunReconciliationIntent>();

  begin(
    workspace: AutomationWorkspaceIdentity,
    key: string,
  ): AutomationRunReconciliationIntent | null {
    const workspaceId = workspace.workspaceId;
    if (workspaceId === null || key.length === 0 || this.#pending.has(workspaceId)) return null;
    const intent = Object.freeze({
      generation: ++this.#generation,
      workspace,
      workspaceId,
      key,
    });
    this.#pending.set(workspaceId, intent);
    return intent;
  }

  isCurrent(
    intent: AutomationRunReconciliationIntent,
    currentWorkspace: AutomationWorkspaceIdentity,
  ): boolean {
    return (
      intent.workspace === currentWorkspace &&
      currentWorkspace.workspaceId === intent.workspaceId &&
      this.isActive(intent)
    );
  }

  isActive(intent: AutomationRunReconciliationIntent): boolean {
    return this.#pending.get(intent.workspaceId) === intent;
  }

  isPending(workspaceId: string | null): boolean {
    return workspaceId !== null && this.#pending.has(workspaceId);
  }

  end(intent: AutomationRunReconciliationIntent): void {
    if (this.#pending.get(intent.workspaceId) === intent) {
      this.#pending.delete(intent.workspaceId);
    }
  }

  invalidate(workspaceId: string): void {
    this.#pending.delete(workspaceId);
  }

  invalidateAll(): void {
    this.#pending.clear();
  }
}

const AUTOMATION_RUN_RECONCILIATION_ATTEMPTS = 2;

/**
 * Confirms that Main's opaque run output is present in a Renderer snapshot.
 * Only the snapshot kind named by the feedback is read, and a refresh counts
 * as synchronized only after its exact unique output is committed while the
 * originating intent remains current.
 */
export async function reconcileAutomationRunOutput(
  input: AutomationRunReconciliationInput,
): Promise<AutomationRunReconciliation> {
  let output: AutomationRunReconciledOutput | null = null;
  let error: unknown;
  const getCommittedSnapshot = (): TaskSnapshot | NoteSnapshot | null =>
    input.feedback.outputKind === 'task'
      ? input.getCommittedTaskSnapshot()
      : input.getCommittedNoteSnapshot();
  const getCommittedOutput = (): AutomationRunReconciledOutput | null => {
    const snapshot = getCommittedSnapshot();
    return snapshot === null ? null : outputFromSnapshot(input.feedback, snapshot);
  };

  const markSuperseded = (): AutomationRunReconciliation => ({
    output,
    committed: false,
    error: new AutomationRunReconciliationSupersededError(),
  });

  if (!input.isCurrent()) return markSuperseded();

  try {
    const committedSnapshot = getCommittedSnapshot();
    if (!input.isCurrent()) return markSuperseded();
    if (committedSnapshot !== null) {
      output = outputFromSnapshot(input.feedback, committedSnapshot);
      if (output !== null) {
        return input.isCurrent() ? { output, committed: true, error: undefined } : markSuperseded();
      }
      error = new AutomationRunOutputUnavailableError(input.feedback.outputKind);
    }
  } catch (caughtError) {
    error = caughtError;
  }

  for (let attempt = 0; attempt < AUTOMATION_RUN_RECONCILIATION_ATTEMPTS; attempt += 1) {
    if (!input.isCurrent()) return markSuperseded();
    try {
      const refresh =
        input.feedback.outputKind === 'task'
          ? await input.prepareTaskSnapshotRefresh()
          : await input.prepareNoteSnapshotRefresh();
      if (!input.isCurrent()) return markSuperseded();

      output = outputFromSnapshot(input.feedback, refresh.snapshot);
      if (output === null) {
        error = new AutomationRunOutputUnavailableError(input.feedback.outputKind);
        continue;
      }
      if (!input.isCurrent()) return markSuperseded();

      const committed = refresh.commit();
      if (!input.isCurrent()) return markSuperseded();
      if (committed) return { output, committed: true, error };
      error = new AutomationRunSnapshotCommitError(input.feedback.outputKind);
      const committedOutput = getCommittedOutput();
      if (!input.isCurrent()) return markSuperseded();
      if (committedOutput !== null) {
        output = committedOutput;
        return { output, committed: true, error };
      }
    } catch (caughtError) {
      error = caughtError;
    }
  }

  if (!input.isCurrent()) return markSuperseded();
  try {
    const committedOutput = getCommittedOutput();
    if (!input.isCurrent()) return markSuperseded();
    if (committedOutput !== null) {
      return { output: committedOutput, committed: true, error };
    }
  } catch (caughtError) {
    error = caughtError;
  }
  return {
    output,
    committed: false,
    error: error ?? new AutomationRunOutputUnavailableError(input.feedback.outputKind),
  };
}

function outputFromSnapshot(
  feedback: Readonly<AutomationRunOutputIdentity>,
  snapshot: TaskSnapshot | NoteSnapshot,
): AutomationRunReconciledOutput | null {
  if (snapshot.workspaceId !== feedback.workspaceId) return null;

  if (feedback.outputKind === 'task' && 'tasks' in snapshot) {
    const matches = snapshot.tasks.filter(({ id }) => id === feedback.outputId);
    return matches.length === 1
      ? {
          kind: 'task',
          workspaceId: feedback.workspaceId,
          task: matches[0]!,
        }
      : null;
  }

  if (feedback.outputKind === 'note' && 'notes' in snapshot) {
    const matches = snapshot.notes.filter(({ id }) => id === feedback.outputId);
    return matches.length === 1
      ? {
          kind: 'note',
          workspaceId: feedback.workspaceId,
          note: matches[0]!,
        }
      : null;
  }

  return null;
}
