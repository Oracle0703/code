import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BackupPolicyRepository } from '../src/main/database/backup-policy-repository';
import { DatabaseStateError } from '../src/main/database/errors';
import { createNodeSqliteAdapter } from '../src/main/database/sqlite-adapter';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe('BackupPolicyRepository', () => {
  it('initializes, updates with revision protection, and records outcomes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'workbench-backup-policy-'));
    directories.push(directory);
    const database = createNodeSqliteAdapter(join(directory, 'policy.sqlite3'));
    database.open();
    database.exec(`
      CREATE TABLE backup_policy (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        enabled INTEGER NOT NULL,
        cadence TEXT NOT NULL,
        local_time_minute INTEGER NOT NULL,
        weekday INTEGER,
        retention_count INTEGER NOT NULL,
        revision INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TRIGGER backup_policy_revision_must_advance
      BEFORE UPDATE ON backup_policy
      WHEN NEW.revision <> OLD.revision + 1
      BEGIN SELECT RAISE(ABORT, 'revision'); END;
      CREATE TABLE backup_run_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        last_attempt_at TEXT,
        last_success_at TEXT,
        last_success_bucket TEXT,
        last_error_code TEXT,
        consecutive_failures INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
    `);
    const repository = new BackupPolicyRepository(database);
    const initializedAt = '2026-07-22T01:00:00.000Z';
    database.exec('BEGIN IMMEDIATE');
    repository.initializeWithinTransaction(initializedAt);
    database.exec('COMMIT');
    expect(repository.readPolicy()).toMatchObject({
      enabled: false,
      cadence: 'daily',
      localTimeMinute: 120,
      retentionCount: 14,
      revision: 1,
    });

    const updated = repository.updatePolicy(
      {
        enabled: true,
        cadence: 'weekly',
        localTimeMinute: 540,
        weekday: 1,
        retentionCount: 8,
        expectedRevision: 1,
      },
      '2026-07-22T02:00:00.000Z',
    );
    expect(updated).toMatchObject({ enabled: true, cadence: 'weekly', weekday: 1, revision: 2 });
    expect(() =>
      repository.updatePolicy(
        {
          enabled: false,
          cadence: 'daily',
          localTimeMinute: 120,
          weekday: null,
          retentionCount: 14,
          expectedRevision: 1,
        },
        '2026-07-22T03:00:00.000Z',
      ),
    ).toThrow(DatabaseStateError);

    repository.recordAttempt('2026-07-22T04:00:00.000Z');
    repository.recordResult({
      attemptedAt: '2026-07-22T04:00:00.000Z',
      completedAt: '2026-07-22T04:00:01.000Z',
      successfulBucket: 'weekly:2026-07-20',
    });
    expect(repository.readRunState()).toMatchObject({
      lastSuccessBucket: 'weekly:2026-07-20',
      lastSuccessAt: '2026-07-22T04:00:01.000Z',
      lastErrorCode: null,
      consecutiveFailures: 0,
    });

    expect(() =>
      repository.recordResult({
        attemptedAt: '2026-07-22T04:05:00.000Z',
        completedAt: '2026-07-22T04:05:01.000Z',
        successfulBucket: 'weekly:2026-07-20',
        errorCode: 'retention-failed',
      }),
    ).toThrow(TypeError);
    expect(() =>
      repository.recordResult({
        attemptedAt: '2026-07-22T04:05:00.000Z',
        completedAt: '2026-07-22T04:05:01.000Z',
      }),
    ).toThrow(TypeError);

    repository.recordAttempt('2026-07-22T04:05:00.000Z');
    repository.recordResult({
      attemptedAt: '2026-07-22T04:05:00.000Z',
      completedAt: '2026-07-22T04:05:01.000Z',
      errorCode: 'retention-failed',
    });
    expect(repository.readRunState()).toMatchObject({
      lastAttemptAt: '2026-07-22T04:05:00.000Z',
      lastSuccessAt: '2026-07-22T04:00:01.000Z',
      lastSuccessBucket: 'weekly:2026-07-20',
      lastErrorCode: 'retention-failed',
      consecutiveFailures: 1,
    });
    repository.recordResult({
      attemptedAt: '2026-07-29T04:00:00.000Z',
      completedAt: '2026-07-29T04:00:01.000Z',
      successfulBucket: 'weekly:2026-07-27',
    });
    expect(repository.readRunState()).toMatchObject({
      lastSuccessBucket: 'weekly:2026-07-27',
      lastErrorCode: null,
      consecutiveFailures: 0,
    });
    database.close();
  });
});
