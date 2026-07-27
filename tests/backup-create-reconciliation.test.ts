import { describe, expect, it, vi } from 'vitest';
import type { DataManagementSnapshot, DatabaseBackupInfo } from '../src/shared/contracts';
import {
  ManualBackupCreateSupersededError,
  ManualBackupCreateUnavailableError,
  ManualBackupSnapshotCommitError,
  createManualBackupIdentity,
  createManualBackupSyncWarning,
  exactManualBackupFromSnapshot,
  reconcileDataManagementSnapshot,
  reconcileManualBackupCreation,
  type ManualBackupCreateReconciliationInput,
  type ManualBackupSnapshotRefresh,
} from '../src/renderer/data-state';

describe('manual backup creation identity', () => {
  it('freezes every exact manual-backup field and rejects another backup reason', () => {
    const created = backup();
    const identity = createManualBackupIdentity(created);

    expect(identity).toEqual(created);
    expect(Object.isFrozen(identity)).toBe(true);
    expect(createManualBackupIdentity(backup({ reason: 'scheduled' }))).toBeNull();
  });

  it('creates an immutable recovery warning without retaining the mutable response object', () => {
    const created = backup();
    const warning = createManualBackupSyncWarning(created, '已创建，请重新读取。');
    created.fileName = 'changed.sqlite3';

    expect(warning).toEqual({
      backup: backup(),
      identity: backup(),
      message: '已创建，请重新读取。',
      refreshing: false,
      refreshError: null,
      focusActionOnMount: true,
    });
    expect(Object.isFrozen(warning)).toBe(true);
    expect(Object.isFrozen(warning.backup)).toBe(true);
    expect(Object.isFrozen(warning.identity)).toBe(true);
  });

  it('selects one exact id and rejects missing or duplicate candidates', () => {
    const identity = createManualBackupIdentity(backup())!;

    expect(exactManualBackupFromSnapshot(identity, snapshot([backup()]))).toEqual(backup());
    expect(exactManualBackupFromSnapshot(identity, snapshot([]))).toBeNull();
    expect(exactManualBackupFromSnapshot(identity, snapshot([backup(), backup()]))).toBeNull();
  });

  it.each([
    ['fileName', { fileName: 'wrong.sqlite3' }],
    ['createdAt', { createdAt: '2026-07-27T10:01:00.000Z' }],
    ['sizeBytes', { sizeBytes: 4_097 }],
    ['reason', { reason: 'scheduled' as const }],
    ['schemaVersion', { schemaVersion: 8 }],
  ])('rejects the same id with wrong %s metadata', (_field, overrides) => {
    const identity = createManualBackupIdentity(backup())!;

    expect(exactManualBackupFromSnapshot(identity, snapshot([backup(overrides)]))).toBeNull();
  });
});

describe('manual backup creation reconciliation', () => {
  it('accepts an exact backup from the already committed snapshot without a fresh read', async () => {
    const created = backup();
    const prepareSnapshotRefresh = vi.fn();

    await expect(
      reconcileManualBackupCreation(
        reconciliationInput({
          backup: created,
          getCommittedSnapshot: () => snapshot([created]),
          prepareSnapshotRefresh,
        }),
      ),
    ).resolves.toMatchObject({
      backup: created,
      identity: created,
      committed: true,
      error: undefined,
    });
    expect(prepareSnapshotRefresh).not.toHaveBeenCalled();
  });

  it('commits an exact backup from the first authoritative read', async () => {
    const commit = vi.fn(() => true);
    const prepareSnapshotRefresh = vi.fn(async () => refresh(snapshot([backup()]), commit));

    await expect(
      reconcileManualBackupCreation(reconciliationInput({ prepareSnapshotRefresh })),
    ).resolves.toMatchObject({ committed: true, error: undefined });
    expect(prepareSnapshotRefresh).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledOnce();
  });

  it('uses the bounded second read after the first snapshot misses the exact backup', async () => {
    const missingCommit = vi.fn(() => true);
    const exactCommit = vi.fn(() => true);
    const prepareSnapshotRefresh = vi
      .fn<() => Promise<ManualBackupSnapshotRefresh>>()
      .mockResolvedValueOnce(refresh(snapshot([]), missingCommit))
      .mockResolvedValueOnce(refresh(snapshot([backup()]), exactCommit));

    const result = await reconcileManualBackupCreation(
      reconciliationInput({ prepareSnapshotRefresh }),
    );

    expect(result.committed).toBe(true);
    expect(result.error).toBeInstanceOf(ManualBackupCreateUnavailableError);
    expect(prepareSnapshotRefresh).toHaveBeenCalledTimes(2);
    expect(missingCommit).not.toHaveBeenCalled();
    expect(exactCommit).toHaveBeenCalledOnce();
  });

  it('recovers from a thrown first read and preserves that diagnostic after the second succeeds', async () => {
    const firstFailure = new Error('first read failed');
    const prepareSnapshotRefresh = vi
      .fn<() => Promise<ManualBackupSnapshotRefresh>>()
      .mockRejectedValueOnce(firstFailure)
      .mockResolvedValueOnce(refresh(snapshot([backup()]), () => true));

    const result = await reconcileManualBackupCreation(
      reconciliationInput({ prepareSnapshotRefresh }),
    );

    expect(result.committed).toBe(true);
    expect(result.error).toBe(firstFailure);
    expect(prepareSnapshotRefresh).toHaveBeenCalledTimes(2);
  });

  it('fails closed when both exact snapshots cannot be committed', async () => {
    const commit = vi.fn(() => false);
    const prepareSnapshotRefresh = vi.fn(async () => refresh(snapshot([backup()]), commit));

    const result = await reconcileManualBackupCreation(
      reconciliationInput({ prepareSnapshotRefresh }),
    );

    expect(result.committed).toBe(false);
    expect(result.error).toBeInstanceOf(ManualBackupSnapshotCommitError);
    expect(prepareSnapshotRefresh).toHaveBeenCalledTimes(2);
    expect(commit).toHaveBeenCalledTimes(2);
  });

  it('uses the final ref-backed snapshot after two uncommitted reads', async () => {
    let committedReads = 0;
    const result = await reconcileManualBackupCreation(
      reconciliationInput({
        getCommittedSnapshot: () => {
          committedReads += 1;
          return committedReads === 2 ? snapshot([backup()]) : null;
        },
        prepareSnapshotRefresh: async () => refresh(snapshot([backup()]), () => false),
      }),
    );

    expect(result.committed).toBe(true);
    expect(result.error).toBeInstanceOf(ManualBackupSnapshotCommitError);
    expect(committedReads).toBe(2);
  });

  it('fails closed for a non-manual response without reading or committing snapshots', async () => {
    const getCommittedSnapshot = vi.fn();
    const prepareSnapshotRefresh = vi.fn();

    const result = await reconcileManualBackupCreation(
      reconciliationInput({
        backup: backup({ reason: 'pre-import' }),
        getCommittedSnapshot,
        prepareSnapshotRefresh,
      }),
    );

    expect(result.backup.reason).toBe('pre-import');
    expect(result.identity).toBeNull();
    expect(result.committed).toBe(false);
    expect(result.error).toMatchObject({ name: 'ManualBackupCreateIdentityError' });
    expect(getCommittedSnapshot).not.toHaveBeenCalled();
    expect(prepareSnapshotRefresh).not.toHaveBeenCalled();
  });

  it('does not commit a missing, duplicate, wrong-metadata, or wrong-reason refresh', async () => {
    const cases = [
      snapshot([]),
      snapshot([backup(), backup()]),
      snapshot([backup({ sizeBytes: 999 })]),
      snapshot([backup({ reason: 'scheduled' })]),
    ];

    for (const candidate of cases) {
      const commit = vi.fn(() => true);
      const result = await reconcileManualBackupCreation(
        reconciliationInput({
          prepareSnapshotRefresh: async () => refresh(candidate, commit),
        }),
      );
      expect(result.committed).toBe(false);
      expect(result.error).toBeInstanceOf(ManualBackupCreateUnavailableError);
      expect(commit).not.toHaveBeenCalled();
    }
  });

  it('checks currency before starting and again after an awaited read', async () => {
    const neverRead = vi.fn();
    const initiallySuperseded = await reconcileManualBackupCreation(
      reconciliationInput({
        isCurrent: () => false,
        prepareSnapshotRefresh: neverRead,
      }),
    );
    expect(initiallySuperseded.committed).toBe(false);
    expect(initiallySuperseded.error).toBeInstanceOf(ManualBackupCreateSupersededError);
    expect(neverRead).not.toHaveBeenCalled();

    let current = true;
    const commit = vi.fn(() => true);
    const supersededDuringRead = await reconcileManualBackupCreation(
      reconciliationInput({
        prepareSnapshotRefresh: async () => {
          current = false;
          return refresh(snapshot([backup()]), commit);
        },
        isCurrent: () => current,
      }),
    );
    expect(supersededDuringRead.committed).toBe(false);
    expect(supersededDuringRead.error).toBeInstanceOf(ManualBackupCreateSupersededError);
    expect(commit).not.toHaveBeenCalled();
  });

  it('checks currency again after reading the final committed ref', async () => {
    let current = true;
    let committedReads = 0;
    const result = await reconcileManualBackupCreation(
      reconciliationInput({
        getCommittedSnapshot: () => {
          committedReads += 1;
          if (committedReads === 2) current = false;
          return committedReads === 2 ? snapshot([backup()]) : null;
        },
        prepareSnapshotRefresh: async () => {
          throw new Error('refresh failed');
        },
        isCurrent: () => current,
      }),
    );

    expect(result.committed).toBe(false);
    expect(result.error).toBeInstanceOf(ManualBackupCreateSupersededError);
  });
});

describe('manual backup snapshot monotonicity', () => {
  it('protects only the confirmed exact manual backup from a late snapshot', () => {
    const created = backup();
    const identity = createManualBackupIdentity(created)!;
    const current = snapshot([created], 2);
    const incomingScheduled = backup({
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      fileName: 'scheduled.sqlite3',
      createdAt: '2026-07-27T11:00:00.000Z',
      reason: 'scheduled',
    });
    const incoming = snapshot([incomingScheduled], 2);

    const reconciled = reconcileDataManagementSnapshot(current, incoming, identity);

    expect(reconciled).not.toBe(current);
    expect(reconciled.backups).toEqual([incomingScheduled, created]);
    expect(reconciled.database.backupCount).toBe(2);
    expect(exactManualBackupFromSnapshot(identity, reconciled)).toEqual(created);
  });

  it('does not globally preserve a backup after its protection is cleared for data replacement', () => {
    const created = backup();
    const current = snapshot([created], 2);
    const replacement = snapshot([], 2);

    expect(reconcileDataManagementSnapshot(current, replacement).backups).toEqual([]);
    expect(
      reconcileDataManagementSnapshot(current, replacement, createManualBackupIdentity(created))
        .backups,
    ).toEqual([created]);
  });

  it('keeps every manual backup confirmed in this Renderer session across one late event', () => {
    const first = backup();
    const second = backup({
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      fileName: 'manual-2.sqlite3',
      createdAt: '2026-07-27T11:00:00.000Z',
    });
    const current = snapshot([second, first], 2);
    const late = snapshot([], 2);

    const reconciled = reconcileDataManagementSnapshot(
      current,
      late,
      [first, second].map((item) => createManualBackupIdentity(item)!),
    );

    expect(reconciled.backups).toEqual([second, first]);
    expect(reconciled.database.backupCount).toBe(2);
  });
});

function reconciliationInput(
  overrides: Partial<ManualBackupCreateReconciliationInput> = {},
): ManualBackupCreateReconciliationInput {
  return {
    backup: backup(),
    getCommittedSnapshot: () => null,
    prepareSnapshotRefresh: async () => refresh(snapshot([]), () => true),
    isCurrent: () => true,
    ...overrides,
  };
}

function refresh(
  value: DataManagementSnapshot,
  commit: () => boolean,
): ManualBackupSnapshotRefresh {
  return { snapshot: value, commit };
}

function snapshot(
  backups: readonly DatabaseBackupInfo[],
  policyRevision = 1,
): DataManagementSnapshot {
  return {
    database: {
      schemaVersion: 7,
      appliedMigrations: 7,
      sqliteVersion: '3.53.1',
      journalMode: 'wal',
      integrityCheck: 'ok',
      backupCount: backups.length,
    },
    backups,
    schedule: {
      policy: {
        enabled: true,
        cadence: 'daily',
        localTimeMinute: 120,
        weekday: null,
        retentionCount: 7,
        revision: policyRevision,
        updatedAt: '2026-07-27T10:00:00.000Z',
      },
      lastAttemptAt: null,
      lastSuccessAt: null,
      lastErrorCode: null,
      consecutiveFailures: 0,
      nextRunAt: '2026-07-28T02:00:00.000Z',
      running: false,
    },
  };
}

function backup(overrides: Partial<DatabaseBackupInfo> = {}): DatabaseBackupInfo {
  return {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    fileName: 'manual.sqlite3',
    createdAt: '2026-07-27T10:00:00.000Z',
    sizeBytes: 4_096,
    reason: 'manual',
    schemaVersion: 7,
    ...overrides,
  };
}
