import { describe, expect, it, vi } from 'vitest';
import type {
  BackupSchedulerPersistentState,
  BackupSchedulerStore,
} from '../src/main/database/backup-scheduler';
import { BackupScheduler } from '../src/main/database/backup-scheduler';

describe('BackupScheduler', () => {
  it('runs a due backup once, applies retention after success, and records its bucket', async () => {
    let state: BackupSchedulerPersistentState = {
      policy: {
        enabled: true,
        cadence: 'daily',
        localTimeMinute: 120,
        weekday: null,
        retentionCount: 14,
        revision: 1,
        updatedAt: '2026-07-20T12:00:00.000Z',
      },
      lastAttemptAt: null,
      lastSuccessAt: null,
      lastSuccessBucket: null,
      lastErrorCode: null,
      consecutiveFailures: 0,
    };
    const create = vi.fn(async () => ({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      fileName: 'scheduled.sqlite3',
      createdAt: '2026-07-22T12:00:00.000Z',
      sizeBytes: 1,
      reason: 'scheduled' as const,
      schemaVersion: 7,
    }));
    const prune = vi.fn(async () => ({ deleted: 0, retained: 1 }));
    const scheduler = new BackupScheduler({
      store: {
        readState: async () => state,
        recordAttempt: async (timestamp) => {
          state = { ...state, lastAttemptAt: timestamp };
        },
        recordResult: async (result) => {
          state = {
            ...state,
            lastAttemptAt: result.attemptedAt,
            lastSuccessAt: result.successfulBucket ? result.completedAt : state.lastSuccessAt,
            lastSuccessBucket: result.successfulBucket ?? state.lastSuccessBucket,
            lastErrorCode: result.errorCode ?? null,
            consecutiveFailures: result.errorCode ? state.consecutiveFailures + 1 : 0,
          };
        },
      },
      backups: { createScheduledBackup: create, pruneScheduled: prune },
      now: () => new Date('2026-07-22T12:00:00.000Z'),
      timer: { set: () => 1, clear: () => undefined },
    });

    const result = await scheduler.start();
    expect(create).toHaveBeenCalledOnce();
    expect(prune).toHaveBeenCalledWith('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    expect(result.lastSuccessAt).toBe('2026-07-22T12:00:00.000Z');
    expect(result.lastErrorCode).toBeNull();
    await scheduler.stop();
  });

  it('persists an exponential retry delay instead of hammering a failing backup target', async () => {
    let now = new Date('2026-07-22T12:00:00.000Z');
    let state = createDueState();
    const create = vi.fn(async () => {
      throw new Error('disk full');
    });
    const scheduler = new BackupScheduler({
      store: {
        readState: async () => state,
        recordAttempt: async (timestamp) => {
          state = { ...state, lastAttemptAt: timestamp };
        },
        recordResult: async (result) => {
          state = {
            ...state,
            lastAttemptAt: result.attemptedAt,
            lastErrorCode: result.errorCode ?? null,
            consecutiveFailures: result.errorCode ? state.consecutiveFailures + 1 : 0,
          };
        },
      },
      backups: {
        createScheduledBackup: create,
        pruneScheduled: vi.fn(),
      },
      now: () => now,
      timer: { set: vi.fn(() => 1), clear: vi.fn() },
    });

    await expect(scheduler.start()).resolves.toMatchObject({
      lastAttemptAt: '2026-07-22T12:00:00.000Z',
      lastErrorCode: 'backup-failed',
      consecutiveFailures: 1,
      nextRunAt: '2026-07-22T12:05:00.000Z',
    });
    expect(create).toHaveBeenCalledOnce();

    now = new Date('2026-07-22T12:04:59.000Z');
    await scheduler.evaluate();
    expect(create).toHaveBeenCalledOnce();

    now = new Date('2026-07-22T12:05:00.000Z');
    await expect(scheduler.evaluate()).resolves.toMatchObject({
      consecutiveFailures: 2,
      nextRunAt: '2026-07-22T12:15:00.000Z',
    });
    expect(create).toHaveBeenCalledTimes(2);
    await scheduler.stop();
  });

  it('retries retention failure without advancing the successful bucket', async () => {
    let now = new Date('2026-07-22T12:00:00.000Z');
    let state: BackupSchedulerPersistentState = {
      ...createDueState(),
      lastSuccessAt: '2026-07-21T12:00:00.000Z',
      lastSuccessBucket: 'daily:2026-07-21',
    };
    const backupIds = [
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    ];
    let backupIndex = 0;
    const create = vi.fn(async () => {
      const id = backupIds[backupIndex];
      backupIndex += 1;
      if (!id) throw new Error('unexpected backup attempt');
      return {
        id,
        fileName: `${id}.sqlite3`,
        createdAt: now.toISOString(),
        sizeBytes: 1,
        reason: 'scheduled' as const,
        schemaVersion: 7,
      };
    });
    const retentionError = new Error('retention target is busy');
    const prune = vi
      .fn()
      .mockRejectedValueOnce(retentionError)
      .mockResolvedValueOnce({ deleted: 1, retained: 14 });
    const recordResult = vi.fn(
      async (result: Parameters<BackupSchedulerStore['recordResult']>[0]) => {
        state = {
          ...state,
          lastAttemptAt: result.attemptedAt,
          lastSuccessAt: result.successfulBucket ? result.completedAt : state.lastSuccessAt,
          lastSuccessBucket: result.successfulBucket ?? state.lastSuccessBucket,
          lastErrorCode: result.errorCode ?? null,
          consecutiveFailures: result.errorCode ? state.consecutiveFailures + 1 : 0,
        };
      },
    );
    const onError = vi.fn();
    const scheduler = new BackupScheduler({
      store: {
        readState: async () => state,
        recordAttempt: async (timestamp) => {
          state = { ...state, lastAttemptAt: timestamp };
        },
        recordResult,
      },
      backups: {
        createScheduledBackup: create,
        pruneScheduled: prune,
      },
      now: () => now,
      timer: { set: vi.fn(() => 1), clear: vi.fn() },
      onError,
    });

    await expect(scheduler.start()).resolves.toMatchObject({
      lastAttemptAt: '2026-07-22T12:00:00.000Z',
      lastSuccessAt: '2026-07-21T12:00:00.000Z',
      lastErrorCode: 'retention-failed',
      consecutiveFailures: 1,
      nextRunAt: '2026-07-22T12:05:00.000Z',
    });
    expect(state.lastSuccessBucket).toBe('daily:2026-07-21');
    expect(recordResult).toHaveBeenNthCalledWith(1, {
      attemptedAt: '2026-07-22T12:00:00.000Z',
      completedAt: '2026-07-22T12:00:00.000Z',
      errorCode: 'retention-failed',
    });
    expect(onError).toHaveBeenCalledExactlyOnceWith(retentionError);

    now = new Date('2026-07-22T12:04:59.000Z');
    await scheduler.evaluate();
    expect(create).toHaveBeenCalledOnce();
    expect(prune).toHaveBeenCalledOnce();

    now = new Date('2026-07-22T12:05:00.000Z');
    await expect(scheduler.evaluate()).resolves.toMatchObject({
      lastAttemptAt: '2026-07-22T12:05:00.000Z',
      lastSuccessAt: '2026-07-22T12:05:00.000Z',
      lastErrorCode: null,
      consecutiveFailures: 0,
    });
    expect(state.lastSuccessBucket).toBe('daily:2026-07-22');
    expect(create).toHaveBeenCalledTimes(2);
    expect(prune).toHaveBeenNthCalledWith(1, backupIds[0]);
    expect(prune).toHaveBeenNthCalledWith(2, backupIds[1]);
    expect(recordResult).toHaveBeenNthCalledWith(2, {
      attemptedAt: '2026-07-22T12:05:00.000Z',
      completedAt: '2026-07-22T12:05:00.000Z',
      successfulBucket: 'daily:2026-07-22',
    });
    await scheduler.stop();
  });

  it('delegates retention atomically after an in-flight policy update commits', async () => {
    let state = createDueState();
    let releaseBackup: (() => void) | undefined;
    let signalStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseBackup = resolve;
    });
    const prune = vi.fn(async () => {
      expect(state.policy.retentionCount).toBe(30);
      return { deleted: 0, retained: 1 };
    });
    const scheduler = new BackupScheduler({
      store: {
        readState: async () => state,
        recordAttempt: async (timestamp) => {
          state = { ...state, lastAttemptAt: timestamp };
        },
        recordResult: async (result) => {
          state = {
            ...state,
            lastAttemptAt: result.attemptedAt,
            lastSuccessAt: result.completedAt,
            lastSuccessBucket: result.successfulBucket ?? null,
            lastErrorCode: result.errorCode ?? null,
            consecutiveFailures: result.errorCode ? state.consecutiveFailures + 1 : 0,
          };
        },
      },
      backups: {
        createScheduledBackup: async () => {
          signalStarted?.();
          await released;
          return {
            id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            fileName: 'scheduled.sqlite3',
            createdAt: '2026-07-22T12:00:00.000Z',
            sizeBytes: 1,
            reason: 'scheduled',
            schemaVersion: 7,
          };
        },
        pruneScheduled: prune,
      },
      now: () => new Date('2026-07-22T12:00:00.000Z'),
      timer: { set: vi.fn(() => 1), clear: vi.fn() },
    });

    const evaluation = scheduler.start();
    await started;
    state = {
      ...state,
      policy: {
        ...state.policy,
        retentionCount: 30,
        revision: 2,
        updatedAt: '2026-07-22T12:00:00.000Z',
      },
    };
    releaseBackup?.();
    await evaluation;

    expect(prune).toHaveBeenCalledExactlyOnceWith('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    await scheduler.stop();
  });

  it('clamps completion time and protects the new snapshot when the clock moves backwards', async () => {
    let now = new Date('2026-07-22T12:00:00.000Z');
    let state = createDueState();
    const prune = vi.fn(async () => ({ deleted: 1, retained: 1 }));
    const scheduler = new BackupScheduler({
      store: {
        readState: async () => state,
        recordAttempt: async (timestamp) => {
          state = { ...state, lastAttemptAt: timestamp };
        },
        recordResult: async (result) => {
          state = {
            ...state,
            lastAttemptAt: result.attemptedAt,
            lastSuccessAt: result.completedAt,
            lastSuccessBucket: result.successfulBucket ?? null,
            lastErrorCode: result.errorCode ?? null,
            consecutiveFailures: result.errorCode ? state.consecutiveFailures + 1 : 0,
          };
        },
      },
      backups: {
        createScheduledBackup: async () => {
          now = new Date('2026-07-22T11:00:00.000Z');
          return {
            id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            fileName: 'clock-rollback.sqlite3',
            createdAt: '2026-07-22T11:00:00.000Z',
            sizeBytes: 1,
            reason: 'scheduled',
            schemaVersion: 7,
          };
        },
        pruneScheduled: prune,
      },
      now: () => now,
      timer: { set: vi.fn(() => 1), clear: vi.fn() },
    });

    await expect(scheduler.start()).resolves.toMatchObject({
      lastAttemptAt: '2026-07-22T12:00:00.000Z',
      lastSuccessAt: '2026-07-22T12:00:00.000Z',
      lastErrorCode: null,
    });
    expect(prune).toHaveBeenCalledExactlyOnceWith('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    await scheduler.stop();
  });
});

function createDueState(): BackupSchedulerPersistentState {
  return {
    policy: {
      enabled: true,
      cadence: 'daily',
      localTimeMinute: 120,
      weekday: null,
      retentionCount: 14,
      revision: 1,
      updatedAt: '2026-07-20T12:00:00.000Z',
    },
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastSuccessBucket: null,
    lastErrorCode: null,
    consecutiveFailures: 0,
  };
}
