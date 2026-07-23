import { describe, expect, it, vi } from 'vitest';
import { DataManagementController } from '../src/main/data-management';
import type { BackupSchedulerPersistentState } from '../src/main/database/backup-scheduler';
import type { BackupPolicyUpdateInput } from '../src/shared/contracts';

const STATUS = {
  schemaVersion: 7,
  appliedMigrations: 7,
  sqliteVersion: '3.53.1',
  journalMode: 'wal' as const,
  integrityCheck: 'ok' as const,
  backupCount: 0,
};

describe('DataManagementController', () => {
  it('coordinates policy snapshots, stale-safe notifications, and portability operations', async () => {
    let persistent: BackupSchedulerPersistentState = {
      policy: {
        enabled: false,
        cadence: 'daily',
        localTimeMinute: 120,
        weekday: null,
        retentionCount: 14,
        revision: 1,
        updatedAt: '2026-07-23T08:00:00.000Z',
      },
      lastAttemptAt: null,
      lastSuccessAt: null,
      lastSuccessBucket: null,
      lastErrorCode: null,
      consecutiveFailures: 0,
    };
    const database = {
      getStatus: vi.fn(async () => STATUS),
      listBackups: vi.fn(async () => []),
      getBackupSchedulerState: vi.fn(async () => persistent),
      updateBackupPolicy: vi.fn(async (input: BackupPolicyUpdateInput) => {
        persistent = {
          ...persistent,
          policy: {
            ...input,
            revision: input.expectedRevision + 1,
            updatedAt: '2026-07-23T08:05:00.000Z',
          },
        };
        return persistent.policy;
      }),
      recordBackupAttempt: vi.fn(async () => undefined),
      recordBackupResult: vi.fn(async () => undefined),
      createScheduledBackup: vi.fn(),
      pruneScheduledBackups: vi.fn(),
    };
    const portability = {
      exportData: vi.fn(async () => ({ status: 'cancelled' as const })),
      chooseImport: vi.fn(async () => ({ status: 'cancelled' as const })),
      commitImport: vi.fn(async () => ({ restarting: true as const })),
      cancelImport: vi.fn(async () => undefined),
    };
    const onStateChange = vi.fn();
    const controller = new DataManagementController({
      database,
      portability,
      now: () => new Date('2026-07-23T08:10:00.000Z'),
      timer: { set: vi.fn(() => 1), clear: vi.fn() },
      onStateChange,
    });

    await expect(controller.start()).resolves.toMatchObject({
      database: STATUS,
      backups: [],
      schedule: { policy: { enabled: false, revision: 1 }, running: false },
    });
    const updated = await controller.updateBackupPolicy({
      enabled: false,
      cadence: 'weekly',
      localTimeMinute: 180,
      weekday: 4,
      retentionCount: 21,
      expectedRevision: 1,
    });
    expect(updated.schedule.policy).toMatchObject({
      cadence: 'weekly',
      weekday: 4,
      revision: 2,
    });
    await expect(controller.exportData()).resolves.toEqual({ status: 'cancelled' });
    await expect(controller.chooseImport()).resolves.toEqual({ status: 'cancelled' });
    await expect(
      controller.commitImport({
        importId: '11111111-1111-4111-8111-111111111111',
        previewDigest: 'a'.repeat(64),
      }),
    ).resolves.toEqual({ restarting: true });
    await controller.cancelImport({ importId: '11111111-1111-4111-8111-111111111111' });
    expect(onStateChange).toHaveBeenCalled();
    await controller.stop();
  });
});
