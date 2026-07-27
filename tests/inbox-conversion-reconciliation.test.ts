import { describe, expect, it, vi } from 'vitest';
import {
  createInboxConversionWorkspaceIdentity,
  InboxConversionPublicationGate,
  InboxConversionRequestCoordinator,
  InboxConversionSupersededError,
  reconcileInboxConversionSnapshots,
  type InboxConversionReconciliationInput,
} from '../src/renderer/inbox-conversion-navigation';

interface Output {
  readonly id: string;
  readonly title: string;
}

interface OutputSnapshot {
  readonly valid: boolean;
  readonly output: Output | null;
}

interface InboxSnapshot {
  readonly valid: boolean;
  readonly sourceArchived: boolean;
}

type ReconciliationInput = InboxConversionReconciliationInput<
  Output,
  OutputSnapshot,
  InboxSnapshot
>;

const OUTPUT = Object.freeze({ id: 'output-a', title: '精确输出' });
const VALID_OUTPUT = Object.freeze({ valid: true, output: OUTPUT });
const VALID_INBOX = Object.freeze({ valid: true, sourceArchived: true });

describe('inbox conversion reconciliation', () => {
  it('publishes an already committed pair without an authoritative read', async () => {
    const prepareOutput = vi.fn();
    const prepareInbox = vi.fn();

    await expect(
      reconcileInboxConversionSnapshots(
        reconciliationInput({
          prepareOutputSnapshotRefresh: prepareOutput,
          prepareInboxSnapshotRefresh: prepareInbox,
        }),
      ),
    ).resolves.toEqual({
      output: OUTPUT,
      outputCommitted: true,
      inboxCommitted: true,
      committed: true,
      error: undefined,
    });
    expect(prepareOutput).not.toHaveBeenCalled();
    expect(prepareInbox).not.toHaveBeenCalled();
  });

  it('accepts both exact objects from newer already committed snapshots', async () => {
    const prepareOutput = vi.fn();
    const prepareInbox = vi.fn();

    const result = await reconcileInboxConversionSnapshots(
      reconciliationInput({
        initialOutputCommitted: false,
        initialInboxCommitted: false,
        prepareOutputSnapshotRefresh: prepareOutput,
        prepareInboxSnapshotRefresh: prepareInbox,
      }),
    );

    expect(result.committed).toBe(true);
    expect(result.output).toBe(OUTPUT);
    expect(prepareOutput).not.toHaveBeenCalled();
    expect(prepareInbox).not.toHaveBeenCalled();
  });

  it('recovers the missing output on the second bounded read after one failure', async () => {
    const commit = vi.fn(() => true);
    const prepareOutput = vi
      .fn()
      .mockRejectedValueOnce(new Error('internal path must stay bounded'))
      .mockResolvedValueOnce({ snapshot: VALID_OUTPUT, commit });
    const result = await reconcileInboxConversionSnapshots(
      reconciliationInput({
        initialOutputCommitted: false,
        getCommittedOutput: () => null,
        prepareOutputSnapshotRefresh: prepareOutput,
      }),
    );

    expect(result.output).toBe(OUTPUT);
    expect(result.outputCommitted).toBe(true);
    expect(result.inboxCommitted).toBe(true);
    expect(result.committed).toBe(true);
    expect(prepareOutput).toHaveBeenCalledTimes(2);
    expect(commit).toHaveBeenCalledOnce();
  });

  it('recovers only the missing inbox side after an invalid read and a failed commit', async () => {
    const firstCommit = vi.fn();
    const secondCommit = vi.fn(() => true);
    const prepareInbox = vi
      .fn()
      .mockResolvedValueOnce({
        snapshot: { valid: false, sourceArchived: true },
        commit: firstCommit,
      })
      .mockResolvedValueOnce({ snapshot: VALID_INBOX, commit: secondCommit });

    const result = await reconcileInboxConversionSnapshots(
      reconciliationInput({
        initialInboxCommitted: false,
        getCommittedInbox: () => false,
        prepareInboxSnapshotRefresh: prepareInbox,
      }),
    );

    expect(result.committed).toBe(true);
    expect(result.output).toBe(OUTPUT);
    expect(prepareInbox).toHaveBeenCalledTimes(2);
    expect(firstCommit).not.toHaveBeenCalled();
    expect(secondCommit).toHaveBeenCalledOnce();
  });

  it('reads and commits both missing sides while preserving their independent state', async () => {
    const outputCommit = vi.fn(() => true);
    const inboxCommit = vi.fn(() => true);
    const result = await reconcileInboxConversionSnapshots(
      reconciliationInput({
        initialOutputCommitted: false,
        initialInboxCommitted: false,
        getCommittedOutput: () => null,
        getCommittedInbox: () => false,
        prepareOutputSnapshotRefresh: vi.fn(async () => ({
          snapshot: VALID_OUTPUT,
          commit: outputCommit,
        })),
        prepareInboxSnapshotRefresh: vi.fn(async () => ({
          snapshot: VALID_INBOX,
          commit: inboxCommit,
        })),
      }),
    );

    expect(result).toMatchObject({
      output: OUTPUT,
      outputCommitted: true,
      inboxCommitted: true,
      committed: true,
    });
    expect(outputCommit).toHaveBeenCalledOnce();
    expect(inboxCommit).toHaveBeenCalledOnce();
  });

  it('keeps a committed output but fails closed when the inbox side cannot be confirmed', async () => {
    const commit = vi.fn(() => true);
    const prepareInbox = vi.fn(async () => ({
      snapshot: { valid: true, sourceArchived: false },
      commit,
    }));

    const result = await reconcileInboxConversionSnapshots(
      reconciliationInput({
        initialInboxCommitted: false,
        getCommittedInbox: () => false,
        prepareInboxSnapshotRefresh: prepareInbox,
      }),
    );

    expect(result.output).toBe(OUTPUT);
    expect(result.outputCommitted).toBe(true);
    expect(result.inboxCommitted).toBe(false);
    expect(result.committed).toBe(false);
    expect(prepareInbox).toHaveBeenCalledTimes(2);
    expect(commit).not.toHaveBeenCalled();
  });

  it('never commits missing, duplicate, source-mismatched, or wrong-workspace output reads', async () => {
    const commit = vi.fn(() => true);
    const prepareOutput = vi.fn(async () => ({
      snapshot: { valid: false, output: OUTPUT },
      commit,
    }));

    const result = await reconcileInboxConversionSnapshots(
      reconciliationInput({
        initialOutputCommitted: false,
        getCommittedOutput: () => null,
        prepareOutputSnapshotRefresh: prepareOutput,
      }),
    );

    expect(result.output).toBeNull();
    expect(result.outputCommitted).toBe(false);
    expect(result.committed).toBe(false);
    expect(prepareOutput).toHaveBeenCalledTimes(2);
    expect(commit).not.toHaveBeenCalled();
  });

  it('stops after an awaited read when the originating activation is invalidated', async () => {
    let current = true;
    const commit = vi.fn(() => true);
    const prepareOutput = vi.fn(async () => {
      current = false;
      return { snapshot: VALID_OUTPUT, commit };
    });

    const result = await reconcileInboxConversionSnapshots(
      reconciliationInput({
        initialOutputCommitted: false,
        getCommittedOutput: () => null,
        prepareOutputSnapshotRefresh: prepareOutput,
        isCurrent: () => current,
      }),
    );

    expect(result.committed).toBe(false);
    expect(result.error).toBeInstanceOf(InboxConversionSupersededError);
    expect(commit).not.toHaveBeenCalled();
  });

  it('checks generation again after commit before announcing success', async () => {
    let current = true;
    const commit = vi.fn(() => {
      current = false;
      return true;
    });

    const result = await reconcileInboxConversionSnapshots(
      reconciliationInput({
        initialOutputCommitted: false,
        getCommittedOutput: () => null,
        prepareOutputSnapshotRefresh: async () => ({ snapshot: VALID_OUTPUT, commit }),
        isCurrent: () => current,
      }),
    );

    expect(result.committed).toBe(false);
    expect(result.outputCommitted).toBe(false);
    expect(result.error).toBeInstanceOf(InboxConversionSupersededError);
  });

  it('holds modal publications for only the exact activation and clears stale values', () => {
    const firstA = createInboxConversionWorkspaceIdentity('workspace-a');
    const secondA = createInboxConversionWorkspaceIdentity('workspace-a');
    const gate = new InboxConversionPublicationGate<{ readonly id: string }>();

    gate.stage(firstA, { id: 'first' });
    expect(gate.take(true, firstA)).toBeNull();
    expect(gate.take(false, firstA)).toEqual({ id: 'first' });
    expect(gate.take(false, firstA)).toBeNull();

    gate.stage(firstA, { id: 'stale' });
    expect(gate.take(false, secondA)).toBeNull();
    gate.stage(firstA, { id: 'cleared' });
    gate.clear();
    expect(gate.take(false, firstA)).toBeNull();
  });

  it('keeps a finished request generation valid for deferred publication until invalidated', () => {
    const workspace = createInboxConversionWorkspaceIdentity('workspace-a');
    const coordinator = new InboxConversionRequestCoordinator();
    const intent = coordinator.begin(workspace, 'source-a', 'task')!;

    expect(coordinator.isGenerationCurrent(intent.generation, workspace)).toBe(true);
    coordinator.end(intent);
    expect(coordinator.isGenerationCurrent(intent.generation, workspace)).toBe(true);
    coordinator.invalidate();
    expect(coordinator.isGenerationCurrent(intent.generation, workspace)).toBe(false);
  });
});

function reconciliationInput(overrides: Partial<ReconciliationInput> = {}): ReconciliationInput {
  return {
    initialOutputCommitted: true,
    initialInboxCommitted: true,
    getCommittedOutput: () => OUTPUT,
    getCommittedInbox: () => true,
    prepareOutputSnapshotRefresh: async () => ({
      snapshot: VALID_OUTPUT,
      commit: () => true,
    }),
    prepareInboxSnapshotRefresh: async () => ({
      snapshot: VALID_INBOX,
      commit: () => true,
    }),
    outputFromSnapshot: (snapshot) => (snapshot.valid ? snapshot.output : null),
    inboxSnapshotIsCommitted: (snapshot) => snapshot.valid && snapshot.sourceArchived,
    isCurrent: () => true,
    ...overrides,
  };
}
