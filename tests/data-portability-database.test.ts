import { mkdtemp, readdir, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { BackupPolicy } from '../src/shared/contracts';
import {
  DatabaseImportStagingDriver,
  readPortableDatabaseRecords,
} from '../src/main/data-portability/database-codec';
import {
  DataPackageError,
  parsePortablePackage,
  serializePortablePackage,
  type ParsedPortablePackage,
  type PortableDataRecord,
  type PortableRecordType,
} from '../src/main/data-portability/package-format';
import {
  AtomicImportStager,
  DEFAULT_MAX_IMPORT_STAGING_BYTES,
} from '../src/main/data-portability/staging';
import { BackupPolicyRepository } from '../src/main/database/backup-policy-repository';
import { MetadataRepository } from '../src/main/database/metadata-repository';
import { createNodeSqliteAdapter } from '../src/main/database/sqlite-adapter';

const ACTIVE_WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const ARCHIVED_WORKSPACE_ID = '22222222-2222-4222-8222-222222222222';
const ACTIVE_INBOX_ID = '33333333-3333-4333-8333-333333333333';
const ARCHIVED_INBOX_ID = '44444444-4444-4444-8444-444444444444';
const TASK_ID = '55555555-5555-4555-8555-555555555555';
const NOTE_ID = '66666666-6666-4666-8666-666666666666';
const SCHEDULE_ID = '77777777-7777-4777-8777-777777777777';
const TAB_ID = '88888888-8888-4888-8888-888888888888';
const BOOKMARK_ID = '99999999-9999-4999-8999-999999999999';
const AUTOMATION_ID = '12121212-3434-4567-8abc-121212121212';
const AUTOMATION_OUTPUT_NOTE_ID = '74747474-7474-4474-8474-747474747474';
const PAUSED_FOCUS_ID = '13131313-1313-4131-8131-131313131313';
const COMPLETED_FOCUS_ID = '14141414-1414-4141-8141-141414141414';
const CANCELLED_FOCUS_ID = '15151515-1515-4151-8151-151515151515';
const DATABASE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const EXPORT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ROUND_TRIP_EXPORT_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const BUILD_TIME = '2026-07-23T08:09:00.000Z';

const T0 = '2026-07-23T08:00:00.000Z';
const T1 = '2026-07-23T08:01:00.000Z';
const T2 = '2026-07-23T08:02:00.000Z';
const T3 = '2026-07-23T08:03:00.000Z';
const T4 = '2026-07-23T08:04:00.000Z';
const T5 = '2026-07-23T08:05:00.000Z';
const T6 = '2026-07-23T08:06:00.000Z';

const LOCAL_BACKUP_POLICY: BackupPolicy = Object.freeze({
  enabled: true,
  cadence: 'weekly',
  localTimeMinute: 375,
  weekday: 4,
  retentionCount: 21,
  revision: 9,
  updatedAt: T1,
});

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) =>
        rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }),
      ),
  );
});

describe('portable database codec', () => {
  it('imports v2 automation definitions paused with fresh runtime state', async () => {
    const directory = await createTemporaryDirectory();
    const packageData = createAutomationPackage();
    expect(packageData.manifest).toMatchObject({
      formatVersion: 2,
      sourceSchemaVersion: 9,
      counts: { automations: 1, enabledAutomations: 1 },
    });
    const destinationPath = await stagePackage(
      directory,
      '70000000-0000-4000-8000-000000000001',
      '70000000-0000-4000-8000-000000000002',
      packageData,
      createDriver(),
    );
    const database = createNodeSqliteAdapter(destinationPath);
    database.open();
    expect(
      database.get<Record<string, unknown>>(
        `SELECT name, cadence, local_time_minute, weekday, action_kind,
                action_title, action_body, enabled, effective_at, revision,
                created_at, updated_at, archived_at
         FROM automations
         WHERE id = ?`,
        [AUTOMATION_ID],
      ),
    ).toEqual({
      name: '每日回顾',
      cadence: 'daily',
      local_time_minute: 17 * 60 + 30,
      weekday: null,
      action_kind: 'create-note',
      action_title: '工作回顾',
      action_body: '## 完成\n\n## 下一步',
      enabled: 0,
      effective_at: null,
      revision: 4,
      created_at: T1,
      updated_at: T4,
      archived_at: null,
    });
    expect(
      database.get<Record<string, unknown>>(
        `SELECT last_attempt_at, last_attempt_occurrence, last_success_at,
                last_success_occurrence, last_output_kind, last_error_code,
                consecutive_failures, next_retry_at
         FROM automation_run_state
         WHERE automation_id = ?`,
        [AUTOMATION_ID],
      ),
    ).toEqual({
      last_attempt_at: null,
      last_attempt_occurrence: null,
      last_success_at: null,
      last_success_occurrence: null,
      last_output_kind: null,
      last_error_code: null,
      consecutive_failures: 0,
      next_retry_at: null,
    });
    expect(
      database.get<{ count: number }>('SELECT COUNT(*) AS count FROM automation_occurrences'),
    ).toEqual({ count: 0 });
    const exported = readPortableDatabaseRecords(database);
    expect(exported.find(({ type }) => type === 'automation-definition')).toMatchObject({
      data: { id: AUTOMATION_ID, enabled: false },
    });
    database.run(
      `UPDATE automations
       SET enabled = 1, effective_at = ?, revision = revision + 1, updated_at = ?
       WHERE id = ?`,
      [T5, T5, AUTOMATION_ID],
    );
    database.run(
      `UPDATE automation_run_state
       SET last_attempt_at = ?,
           last_attempt_occurrence = '2026-07-23',
           last_error_code = 'action-failed',
           consecutive_failures = 1,
           next_retry_at = ?,
           updated_at = ?
       WHERE automation_id = ?`,
      [T5, T6, T6, AUTOMATION_ID],
    );
    const activeRecord = readPortableDatabaseRecords(database).find(
      ({ type }) => type === 'automation-definition',
    );
    expect(activeRecord?.data.enabled).toBe(true);
    expect(Object.keys(activeRecord?.data ?? {}).sort()).toEqual([
      'action',
      'archivedAt',
      'createdAt',
      'enabled',
      'id',
      'name',
      'revision',
      'schedule',
      'updatedAt',
      'workspaceId',
    ]);
    database.close();
  });

  it('exports current v3 focus history, pauses a running session, omits cancelled rows, and re-imports safely', async () => {
    const directory = await createTemporaryDirectory();
    const packageData = createFocusPackage();
    expect(packageData.manifest).toMatchObject({
      formatVersion: 3,
      sourceSchemaVersion: 11,
      counts: { focusSessions: 2 },
    });
    const sourcePath = await stagePackage(
      directory,
      '71000000-0000-4000-8000-000000000001',
      '71000000-0000-4000-8000-000000000002',
      packageData,
      createDriver(),
    );
    const source = createNodeSqliteAdapter(sourcePath);
    source.open();
    expect(
      source.all<Record<string, unknown>>(
        `SELECT id, workspace_id, task_id, local_date, state, remaining_seconds,
                deadline_at, revision, completed_at, cancelled_at
         FROM focus_sessions
         ORDER BY id`,
      ),
    ).toEqual([
      {
        id: PAUSED_FOCUS_ID,
        workspace_id: ACTIVE_WORKSPACE_ID,
        task_id: TASK_ID,
        local_date: '2026-07-23',
        state: 'paused',
        remaining_seconds: 900,
        deadline_at: null,
        revision: 2,
        completed_at: null,
        cancelled_at: null,
      },
      {
        id: COMPLETED_FOCUS_ID,
        workspace_id: ARCHIVED_WORKSPACE_ID,
        task_id: null,
        local_date: '2026-07-22',
        state: 'completed',
        remaining_seconds: 0,
        deadline_at: null,
        revision: 3,
        completed_at: T3,
        cancelled_at: null,
      },
    ]);
    source.run(
      `UPDATE focus_sessions
       SET state = 'running', deadline_at = ?, revision = revision + 1, updated_at = ?
       WHERE id = ?`,
      ['2026-07-23T08:20:00.000Z', '2026-07-23T08:07:00.000Z', PAUSED_FOCUS_ID],
    );
    source.run(
      `INSERT INTO focus_sessions (
         id, workspace_id, task_id, local_date, state, remaining_seconds,
         deadline_at, revision, created_at, updated_at, completed_at, cancelled_at
       ) VALUES (?, ?, NULL, '2026-07-23', 'cancelled', 600, NULL, 1, ?, ?, NULL, ?)`,
      [CANCELLED_FOCUS_ID, ACTIVE_WORKSPACE_ID, T1, T6, T6],
    );

    const exportedRecords = readPortableDatabaseRecords(
      source,
      undefined,
      () => new Date('2026-07-23T08:15:00.000Z'),
    );
    const exportedFocus = exportedRecords.filter(({ type }) => type === 'focus-session');
    expect(exportedFocus).toHaveLength(2);
    expect(exportedFocus.find(({ data }) => data.id === PAUSED_FOCUS_ID)).toEqual({
      type: 'focus-session',
      data: {
        id: PAUSED_FOCUS_ID,
        workspaceId: ACTIVE_WORKSPACE_ID,
        taskId: TASK_ID,
        status: 'paused',
        remainingSeconds: 300,
        revision: 3,
        localDate: '2026-07-23',
        createdAt: T1,
        updatedAt: '2026-07-23T08:07:00.000Z',
        completedAt: null,
      },
    });
    expect(
      readPortableDatabaseRecords(
        source,
        undefined,
        () => new Date('2026-07-23T08:21:00.000Z'),
      ).find(({ data }) => data.id === PAUSED_FOCUS_ID),
    ).toEqual({
      type: 'focus-session',
      data: {
        id: PAUSED_FOCUS_ID,
        workspaceId: ACTIVE_WORKSPACE_ID,
        taskId: TASK_ID,
        status: 'completed',
        remainingSeconds: 0,
        revision: 3,
        localDate: '2026-07-23',
        createdAt: T1,
        updatedAt: '2026-07-23T08:21:00.000Z',
        completedAt: '2026-07-23T08:21:00.000Z',
      },
    });
    expect(
      source.get<Record<string, unknown>>(
        `SELECT state, remaining_seconds, deadline_at, revision
         FROM focus_sessions
         WHERE id = ?`,
        [PAUSED_FOCUS_ID],
      ),
    ).toEqual({
      state: 'running',
      remaining_seconds: 900,
      deadline_at: '2026-07-23T08:20:00.000Z',
      revision: 3,
    });
    source.run(
      `UPDATE focus_sessions
       SET state = 'paused', deadline_at = NULL, revision = 4, updated_at = ?
       WHERE id = ?`,
      ['2026-07-23T09:00:00.000Z', PAUSED_FOCUS_ID],
    );
    source.run(
      `UPDATE focus_sessions
       SET state = 'running', deadline_at = ?, revision = 5, updated_at = ?
       WHERE id = ?`,
      ['2026-07-23T08:20:00.000Z', '2026-07-23T09:00:00.000Z', PAUSED_FOCUS_ID],
    );
    expect(
      readPortableDatabaseRecords(
        source,
        undefined,
        () => new Date('2026-07-23T08:21:00.000Z'),
      ).find(({ data }) => data.id === PAUSED_FOCUS_ID),
    ).toMatchObject({
      data: {
        status: 'completed',
        remainingSeconds: 0,
        revision: 5,
        updatedAt: '2026-07-23T09:00:00.000Z',
        completedAt: '2026-07-23T09:00:00.000Z',
      },
    });
    expect(exportedRecords.some(({ data }) => data.id === CANCELLED_FOCUS_ID)).toBe(false);
    source.close();

    const roundTripPackage = parsePortablePackage(
      serializePortablePackage({
        exportId: '71717171-7171-4171-8171-717171717172',
        exportedAt: BUILD_TIME,
        sourceAppVersion: '0.1.0',
        sourceSchemaVersion: 11,
        records: exportedRecords,
      }),
    );
    expect(roundTripPackage.manifest.counts.focusSessions).toBe(2);
    const roundTripPath = await stagePackage(
      directory,
      '71000000-0000-4000-8000-000000000003',
      '71000000-0000-4000-8000-000000000004',
      roundTripPackage,
      createDriver(),
    );
    const roundTrip = createNodeSqliteAdapter(roundTripPath, { readOnly: true });
    roundTrip.open();
    expect(
      roundTrip.get<Record<string, unknown>>(
        `SELECT state, remaining_seconds, deadline_at, cancelled_at
         FROM focus_sessions
         WHERE id = ?`,
        [PAUSED_FOCUS_ID],
      ),
    ).toEqual({
      state: 'paused',
      remaining_seconds: 300,
      deadline_at: null,
      cancelled_at: null,
    });
    expect(
      readPortableDatabaseRecords(roundTrip).filter(({ type }) => type === 'focus-session'),
    ).toEqual(exportedFocus);
    roundTrip.close();
  });

  it.each([10, 11] as const)(
    'accepts a v3 source schema %i package into a current v11 staging database',
    async (sourceSchemaVersion) => {
      const directory = await createTemporaryDirectory();
      const packageData = createFocusPackage(900, TASK_ID, sourceSchemaVersion);
      expect(packageData.manifest).toMatchObject({
        formatVersion: 3,
        sourceSchemaVersion,
      });

      const destinationPath = await stagePackage(
        directory,
        `71111111-1111-4111-8111-${String(sourceSchemaVersion).padStart(12, '0')}`,
        `72222222-2222-4222-8222-${String(sourceSchemaVersion).padStart(12, '0')}`,
        packageData,
        createDriver(),
      );
      const database = createNodeSqliteAdapter(destinationPath, { readOnly: true });
      database.open();
      expect(database.get<{ user_version: number }>('PRAGMA user_version')).toEqual({
        user_version: 11,
      });
      expect(
        database.get<{ count: number }>('SELECT COUNT(*) AS count FROM focus_sessions'),
      ).toEqual({ count: 2 });
      expect(
        database.get<{ count: number }>(
          'SELECT COUNT(*) AS count FROM workspace_recovery_revisions',
        ),
      ).toEqual({ count: 2 });
      database.close();
    },
  );

  it('round-trips archived-workspace history without charging it to the active limit', async () => {
    const directory = await createTemporaryDirectory();
    const archivedDefinitions = Array.from({ length: 100 }, (_, index) =>
      automationDefinitionRecord(index, ARCHIVED_WORKSPACE_ID),
    );
    const activeDefinitions = Array.from({ length: 100 }, (_, index) =>
      automationDefinitionRecord(index + archivedDefinitions.length, ACTIVE_WORKSPACE_ID),
    );
    const packageData = parsePortablePackage(
      serializePortablePackage({
        exportId: '72727272-7272-4272-8272-727272727272',
        exportedAt: BUILD_TIME,
        sourceAppVersion: '0.1.0',
        sourceSchemaVersion: 9,
        records: [...createRecords(), ...archivedDefinitions, ...activeDefinitions],
      }),
    );

    const destinationPath = await stagePackage(
      directory,
      '73000000-0000-4000-8000-000000000001',
      '73000000-0000-4000-8000-000000000002',
      packageData,
      createDriver(),
    );
    const database = createNodeSqliteAdapter(destinationPath);
    database.open();
    expect(
      database.get<{ total: number; active: number }>(
        `SELECT
           COUNT(*) AS total,
           SUM(
             CASE
               WHEN automation.archived_at IS NULL AND workspace.archived_at IS NULL THEN 1
               ELSE 0
             END
           ) AS active
         FROM automations AS automation
         JOIN workspaces AS workspace ON workspace.id = automation.workspace_id`,
      ),
    ).toEqual({ total: 200, active: 100 });
    const exportedRecords = readPortableDatabaseRecords(database);
    expect(exportedRecords.filter(({ type }) => type === 'automation-definition')).toHaveLength(
      200,
    );
    database.close();

    const roundTripPackage = parsePortablePackage(
      serializePortablePackage({
        exportId: '72727272-7272-4272-8272-727272727273',
        exportedAt: BUILD_TIME,
        sourceAppVersion: '0.1.0',
        sourceSchemaVersion: 9,
        records: exportedRecords,
      }),
    );
    const roundTripPath = await stagePackage(
      directory,
      '73000000-0000-4000-8000-000000000003',
      '73000000-0000-4000-8000-000000000004',
      roundTripPackage,
      createDriver(),
    );
    const roundTripDatabase = createNodeSqliteAdapter(roundTripPath);
    roundTripDatabase.open();
    expect(readPortableDatabaseRecords(roundTripDatabase)).toEqual(exportedRecords);
    roundTripDatabase.close();
  });

  it('rejects staged automation run state or occurrence data not supplied by the package', async () => {
    const directory = await createTemporaryDirectory();
    const packageData = createAutomationPackage();

    const runStatePath = join(directory, 'runtime-state.sqlite3');
    const runStateDriver = createDriver();
    await runStateDriver.build(packageData, runStatePath);
    const runStateDatabase = createNodeSqliteAdapter(runStatePath);
    runStateDatabase.open();
    runStateDatabase.run(
      `UPDATE automation_run_state
       SET last_attempt_at = ?,
           last_attempt_occurrence = '2026-07-23',
           last_error_code = 'action-failed',
           consecutive_failures = 1,
           next_retry_at = ?,
           updated_at = ?
       WHERE automation_id = ?`,
      [T5, T6, T6, AUTOMATION_ID],
    );
    runStateDatabase.close();
    await expect(runStateDriver.validate(runStatePath, packageData)).rejects.toThrow(
      /freshly paused/u,
    );

    const occurrencePath = join(directory, 'runtime-occurrence.sqlite3');
    const occurrenceDriver = createDriver();
    await occurrenceDriver.build(packageData, occurrencePath);
    const occurrenceDatabase = createNodeSqliteAdapter(occurrencePath);
    occurrenceDatabase.open();
    occurrenceDatabase.run(
      `INSERT INTO notes (
         id, workspace_id, title, body, revision, source_inbox_entry_id,
         created_at, updated_at, archived_at
       ) VALUES (?, ?, 'Automation output', '', 1, NULL, ?, ?, NULL)`,
      [AUTOMATION_OUTPUT_NOTE_ID, ACTIVE_WORKSPACE_ID, T3, T3],
    );
    occurrenceDatabase.run(
      `INSERT INTO automation_occurrences (
         automation_id, occurrence_date, scheduled_for, definition_revision,
         completed_at, output_kind, task_id, note_id
       ) VALUES (?, '2026-07-23', ?, 4, ?, 'note', NULL, ?)`,
      [AUTOMATION_ID, T5, T6, AUTOMATION_OUTPUT_NOTE_ID],
    );
    occurrenceDatabase.close();
    await expect(occurrenceDriver.validate(occurrencePath, packageData)).rejects.toThrow(
      /freshly paused|latest occurrence/u,
    );
  });

  it.each([
    ['trigger', 'focus_sessions_state_transition_is_valid'],
    ['index', 'focus_sessions_single_open'],
  ] as const)('rejects a staged database with a weakened focus %s', async (type, name) => {
    const directory = await createTemporaryDirectory();
    const packageData = createFocusPackage();
    const stagingPath = join(directory, `weakened-focus-${type}.sqlite3`);
    const driver = createDriver();
    await driver.build(packageData, stagingPath);

    const database = createNodeSqliteAdapter(stagingPath);
    database.open();
    database.exec(`DROP ${type.toUpperCase()} ${name}`);
    database.close();

    await expect(driver.validate(stagingPath, packageData)).rejects.toThrow(
      /focus session schema is invalid/iu,
    );
  });

  it('round-trips every logical record without exporting local database state', async () => {
    const directory = await createTemporaryDirectory();
    const driver = createDriver();
    const sourcePath = await stagePackage(
      directory,
      'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      createPackage(),
      driver,
    );
    expect(await readdir(directory)).toEqual([
      'import-dddddddd-dddd-4ddd-8ddd-dddddddddddd.sqlite3',
    ]);

    const source = createNodeSqliteAdapter(sourcePath);
    source.open();
    source.run(
      `UPDATE workspace_terminal_preferences
       SET preferred_profile_id = 'bash',
           native_cwd_platform = 'linux',
           native_cwd_path = '/tmp/local-only',
           wsl_distribution_name = 'Ubuntu Local',
           revision = 2,
           updated_at = ?
       WHERE workspace_id = ?`,
      [T6, ACTIVE_WORKSPACE_ID],
    );
    const beforeChanges = source.get<{ changes: number }>(
      'SELECT total_changes() AS changes',
    )?.changes;
    const firstRead = readPortableDatabaseRecords(source);
    const secondRead = readPortableDatabaseRecords(source);
    const afterChanges = source.get<{ changes: number }>(
      'SELECT total_changes() AS changes',
    )?.changes;

    expect(firstRead).toEqual(secondRead);
    expect(afterChanges).toBe(beforeChanges);
    expect(firstRead.map(({ type }) => type)).toEqual([
      'app-state',
      'workspace',
      'workspace',
      'workspace-preference',
      'workspace-preference',
      'inbox-entry',
      'inbox-entry',
      'task',
      'note',
      'schedule-item',
      'browser-tab',
      'browser-state',
      'browser-bookmark',
    ]);
    expect(firstRead.some(({ type }) => type.includes('backup'))).toBe(false);
    expect(firstRead.some(({ type }) => type.includes('metadata'))).toBe(false);
    expect(firstRead.some(({ type }) => type.includes('terminal'))).toBe(false);
    expect(
      source.all<Record<string, unknown>>(
        `SELECT workspace_id, preferred_profile_id, native_cwd_platform,
                native_cwd_path, wsl_distribution_name, revision
         FROM workspace_terminal_preferences
         ORDER BY workspace_id`,
      ),
    ).toEqual([
      {
        workspace_id: ACTIVE_WORKSPACE_ID,
        preferred_profile_id: 'bash',
        native_cwd_platform: 'linux',
        native_cwd_path: '/tmp/local-only',
        wsl_distribution_name: 'Ubuntu Local',
        revision: 2,
      },
      {
        workspace_id: ARCHIVED_WORKSPACE_ID,
        preferred_profile_id: 'system-default',
        native_cwd_platform: null,
        native_cwd_path: null,
        wsl_distribution_name: null,
        revision: 1,
      },
    ]);
    expect(new BackupPolicyRepository(source).readPolicy()).toEqual(LOCAL_BACKUP_POLICY);
    expect(new MetadataRepository(source).read().databaseId).toBe(DATABASE_ID);
    expect(
      source.all<{ name: string; archived_at: string | null }>(
        `SELECT name, archived_at
         FROM workspaces
         ORDER BY archived_at IS NOT NULL, id`,
      ),
    ).toEqual([
      { name: '共享工作区', archived_at: null },
      { name: '共享工作区', archived_at: T5 },
    ]);
    expect(
      source.get<{ title: string }>(
        `SELECT notes.title
         FROM notes_search
         JOIN notes ON notes.rowid = notes_search.rowid
         WHERE notes_search MATCH ?`,
        ['"历史笔记"'],
      ),
    ).toEqual({ title: '历史笔记' });
    source.close();

    const roundTripPackage = parsePortablePackage(
      serializePortablePackage({
        exportId: ROUND_TRIP_EXPORT_ID,
        exportedAt: BUILD_TIME,
        sourceAppVersion: '0.1.0',
        sourceSchemaVersion: 8,
        records: firstRead,
      }),
    );
    const roundTripPath = await stagePackage(
      directory,
      'ffffffff-ffff-4fff-8fff-ffffffffffff',
      '12345678-1234-4123-8123-123456789abc',
      roundTripPackage,
      driver,
    );
    const roundTrip = createNodeSqliteAdapter(roundTripPath, { readOnly: true });
    roundTrip.open();
    expect(readPortableDatabaseRecords(roundTrip)).toEqual(firstRead);
    expect(new BackupPolicyRepository(roundTrip).readPolicy()).toEqual(LOCAL_BACKUP_POLICY);
    expect(
      roundTrip.all<Record<string, unknown>>(
        `SELECT workspace_id, preferred_profile_id, native_cwd_platform,
                native_cwd_path, wsl_distribution_name, revision
         FROM workspace_terminal_preferences
         ORDER BY workspace_id`,
      ),
    ).toEqual([
      {
        workspace_id: ACTIVE_WORKSPACE_ID,
        preferred_profile_id: 'system-default',
        native_cwd_platform: null,
        native_cwd_path: null,
        wsl_distribution_name: null,
        revision: 1,
      },
      {
        workspace_id: ARCHIVED_WORKSPACE_ID,
        preferred_profile_id: 'system-default',
        native_cwd_platform: null,
        native_cwd_path: null,
        wsl_distribution_name: null,
        revision: 1,
      },
    ]);
    roundTrip.close();
  });

  it('rejects extra fields, scalar tampering, duplicates, invalid relations, and an archived current workspace', async () => {
    const directory = await createTemporaryDirectory();
    const original = createPackage();
    const duplicateWorkspace = {
      ...original,
      manifest: {
        ...original.manifest,
        recordCount: original.manifest.recordCount + 1,
        counts: {
          ...original.manifest.counts,
          workspaces: original.manifest.counts.workspaces + 1,
        },
      },
      records: [
        ...original.records,
        original.records.find(({ type }) => type === 'workspace') as PortableDataRecord,
      ],
    } satisfies ParsedPortablePackage;
    const invalidPackages: readonly ParsedPortablePackage[] = [
      mutateRecord(original, 'workspace', (data) => ({ ...data, unexpected: true })),
      mutateRecord(original, 'workspace-preference', (data) => ({
        ...data,
        sidebarCollapsed: 0,
      })),
      duplicateWorkspace,
      mutateRecord(original, 'task', (data) => ({
        ...data,
        sourceInboxEntryId: ARCHIVED_INBOX_ID,
      })),
      mutateRecord(original, 'app-state', (data) => ({
        ...data,
        currentWorkspaceId: ARCHIVED_WORKSPACE_ID,
      })),
    ];
    const destinationIds = [
      '10000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000002',
      '10000000-0000-4000-8000-000000000003',
      '10000000-0000-4000-8000-000000000004',
      '10000000-0000-4000-8000-000000000005',
    ];
    const stagingIds = [
      '20000000-0000-4000-8000-000000000001',
      '20000000-0000-4000-8000-000000000002',
      '20000000-0000-4000-8000-000000000003',
      '20000000-0000-4000-8000-000000000004',
      '20000000-0000-4000-8000-000000000005',
    ];

    for (const [index, packageData] of invalidPackages.entries()) {
      await expect(
        stagePackage(
          directory,
          destinationIds[index],
          stagingIds[index],
          packageData,
          createDriver(),
        ),
      ).rejects.toBeInstanceOf(DataPackageError);
    }
    expect(await readdir(directory)).toEqual([]);
  });

  it('rejects reversed workspace timestamps during portable record decoding', async () => {
    const directory = await createTemporaryDirectory();
    const original = createPackage();
    const invalidPackages: readonly ParsedPortablePackage[] = [
      mutateRecord(original, 'workspace', (data) => ({
        ...data,
        createdAt: T2,
        updatedAt: T1,
      })),
      mutateRecord(original, 'workspace', (data) => ({
        ...data,
        updatedAt: T4,
        archivedAt: T5,
      })),
    ];

    for (const [index, packageData] of invalidPackages.entries()) {
      await expect(
        stagePackage(
          directory,
          `11000000-0000-4000-8000-${(index + 1).toString().padStart(12, '0')}`,
          `21000000-0000-4000-8000-${(index + 1).toString().padStart(12, '0')}`,
          packageData,
          createDriver(),
        ),
      ).rejects.toThrow('The data package workspace timestamp ordering is invalid.');
    }
    expect(await readdir(directory)).toEqual([]);
  });

  it('rejects unsafe or relationally invalid focus records before staging', async () => {
    const directory = await createTemporaryDirectory();
    const original = createFocusPackage();
    const invalidPackages: readonly ParsedPortablePackage[] = [
      mutateRecord(original, 'focus-session', (data) => ({
        ...data,
        status: 'running',
      })),
      mutateRecord(original, 'focus-session', (data) => ({
        ...data,
        remainingSeconds: 0,
      })),
      mutateRecord(original, 'focus-session', (data) => ({
        ...data,
        taskId: '16161616-1616-4161-8161-161616161616',
      })),
      mutateRecord(original, 'focus-session', (data) => ({
        ...data,
        workspaceId: ARCHIVED_WORKSPACE_ID,
        taskId: null,
      })),
      mutateRecord(original, 'focus-session', (data) => ({
        ...data,
        localDate: '2026-02-30',
      })),
    ];

    for (const [index, packageData] of invalidPackages.entries()) {
      await expect(
        stagePackage(
          directory,
          `51000000-0000-4000-8000-${(index + 1).toString().padStart(12, '0')}`,
          `52000000-0000-4000-8000-${(index + 1).toString().padStart(12, '0')}`,
          packageData,
          createDriver(),
        ),
      ).rejects.toBeInstanceOf(DataPackageError);
    }
    expect(await readdir(directory)).toEqual([]);
  });

  it('accepts exactly v1 schema 7/8, v2 schema 9, and v3 schema 10/11 packages', async () => {
    const directory = await createTemporaryDirectory();
    const legacyPath = await stagePackage(
      directory,
      '50000000-0000-4000-8000-000000000001',
      '50000000-0000-4000-8000-000000000002',
      createPackage(7),
      createDriver(),
    );
    const legacy = createNodeSqliteAdapter(legacyPath, { readOnly: true });
    legacy.open();
    expect(legacy.get<{ count: number }>('SELECT COUNT(*) AS count FROM automations')).toEqual({
      count: 0,
    });
    expect(legacy.get<{ count: number }>('SELECT COUNT(*) AS count FROM focus_sessions')).toEqual({
      count: 0,
    });
    legacy.close();
    await expect(
      stagePackage(
        directory,
        '50000000-0000-4000-8000-000000000003',
        '50000000-0000-4000-8000-000000000004',
        createPackage(8),
        createDriver(),
      ),
    ).resolves.toContain('import-50000000-0000-4000-8000-000000000003.sqlite3');
    await expect(
      stagePackage(
        directory,
        '50000000-0000-4000-8000-000000000005',
        '50000000-0000-4000-8000-000000000006',
        createPackage(9),
        createDriver(),
      ),
    ).resolves.toContain('import-50000000-0000-4000-8000-000000000005.sqlite3');
    await expect(
      stagePackage(
        directory,
        '50000000-0000-4000-8000-00000000000b',
        '50000000-0000-4000-8000-00000000000c',
        createFocusPackage(),
        createDriver(),
      ),
    ).resolves.toContain('import-50000000-0000-4000-8000-00000000000b.sqlite3');
    const unsupported = createPackage(8);
    await expect(
      stagePackage(
        directory,
        '50000000-0000-4000-8000-000000000007',
        '50000000-0000-4000-8000-000000000008',
        {
          ...unsupported,
          manifest: { ...unsupported.manifest, sourceSchemaVersion: 6 },
        },
        createDriver(),
      ),
    ).rejects.toBeInstanceOf(DataPackageError);
    const forgedLegacyAutomation = createAutomationPackage();
    await expect(
      stagePackage(
        directory,
        '50000000-0000-4000-8000-000000000009',
        '50000000-0000-4000-8000-00000000000a',
        {
          ...forgedLegacyAutomation,
          manifest: {
            ...forgedLegacyAutomation.manifest,
            formatVersion: 1,
            sourceSchemaVersion: 8,
          },
        },
        createDriver(),
      ),
    ).rejects.toThrow(/legacy data package/u);
  });

  it('binds validation to the previewed logical records and verifies FTS content', async () => {
    const directory = await createTemporaryDirectory();
    const expectedPath = join(directory, 'expected.sqlite3');
    const replacementPath = join(directory, 'replacement.sqlite3');
    const expectedDriver = createDriver();
    const replacementDriver = createDriver();
    const expectedPackage = createPackage();
    const replacementPackage = createPackageWithNoteTitle('另一份笔记');
    await expectedDriver.build(expectedPackage, expectedPath);
    await replacementDriver.build(replacementPackage, replacementPath);
    await rm(expectedPath);
    await rename(replacementPath, expectedPath);
    await expect(expectedDriver.validate(expectedPath, expectedPackage)).rejects.toThrow(
      /logical data does not match/u,
    );

    const expectedFocusPath = join(directory, 'expected-focus.sqlite3');
    const replacementFocusPath = join(directory, 'replacement-focus.sqlite3');
    const expectedFocusDriver = createDriver();
    const replacementFocusDriver = createDriver();
    const expectedFocusPackage = createFocusPackage(900);
    const replacementFocusPackage = createFocusPackage(899);
    await expectedFocusDriver.build(expectedFocusPackage, expectedFocusPath);
    await replacementFocusDriver.build(replacementFocusPackage, replacementFocusPath);
    await rm(expectedFocusPath);
    await rename(replacementFocusPath, expectedFocusPath);
    await expect(
      expectedFocusDriver.validate(expectedFocusPath, expectedFocusPackage),
    ).rejects.toThrow(/logical data does not match/u);

    const corruptFtsPath = join(directory, 'corrupt-fts.sqlite3');
    const corruptFtsDriver = createDriver();
    const corruptFtsPackage = createPackage();
    await corruptFtsDriver.build(corruptFtsPackage, corruptFtsPath);
    const database = createNodeSqliteAdapter(corruptFtsPath);
    database.open();
    const note = database.get<{ rowid: number; title: string; body: string }>(
      'SELECT rowid, title, body FROM notes WHERE id = ?',
      [NOTE_ID],
    );
    expect(note).toBeDefined();
    database.run(
      `INSERT INTO notes_search (notes_search, rowid, title, body)
       VALUES ('delete', ?, ?, ?)`,
      [note?.rowid ?? 0, note?.title ?? '', note?.body ?? ''],
    );
    database.close();
    await expect(corruptFtsDriver.validate(corruptFtsPath, corruptFtsPackage)).rejects.toThrow();
    expect(
      (await readdir(directory)).filter((name) => /-(?:wal|shm|journal)$/u.test(name)),
    ).toEqual([]);
  });

  it('caps SQLite page growth while building and rejects oversized configured limits', async () => {
    expect(
      () =>
        new DatabaseImportStagingDriver({
          localBackupPolicy: LOCAL_BACKUP_POLICY,
          maxDatabaseBytes: DEFAULT_MAX_IMPORT_STAGING_BYTES + 1,
        }),
    ).toThrow(TypeError);

    const directory = await createTemporaryDirectory();
    const driver = new DatabaseImportStagingDriver({
      localBackupPolicy: LOCAL_BACKUP_POLICY,
      now: () => new Date(BUILD_TIME),
      idFactory: () => DATABASE_ID,
      maxDatabaseBytes: 16 * 1024,
    });
    await expect(
      stagePackage(
        directory,
        '30000000-0000-4000-8000-000000000001',
        '30000000-0000-4000-8000-000000000002',
        createPackage(),
        driver,
      ),
    ).rejects.toThrow();
    expect(await readdir(directory)).toEqual([]);
  });

  it('atomically rebuilds a claimed stage with the latest local backup policy', async () => {
    const directory = await createTemporaryDirectory();
    const packageData = createPackage();
    const destinationId = '40000000-0000-4000-8000-000000000001';
    const destinationPath = await stagePackage(
      directory,
      destinationId,
      '40000000-0000-4000-8000-000000000002',
      packageData,
      createDriver(),
    );
    const before = createNodeSqliteAdapter(destinationPath, { readOnly: true });
    before.open();
    const expectedRecords = readPortableDatabaseRecords(before);
    before.close();

    const latestPolicy: BackupPolicy = {
      ...LOCAL_BACKUP_POLICY,
      cadence: 'daily',
      weekday: null,
      revision: LOCAL_BACKUP_POLICY.revision + 1,
      updatedAt: T6,
    };
    const replacement = new AtomicImportStager({
      directory,
      idFactory: () => '40000000-0000-4000-8000-000000000003',
      driver: createDriver(latestPolicy),
    });
    await replacement.stage({
      importId: destinationId,
      package: packageData,
      destinationPath,
      replaceExisting: true,
    });

    const refreshed = createNodeSqliteAdapter(destinationPath, { readOnly: true });
    refreshed.open();
    expect(readPortableDatabaseRecords(refreshed)).toEqual(expectedRecords);
    expect(new BackupPolicyRepository(refreshed).readPolicy()).toEqual(latestPolicy);
    refreshed.close();
    expect(await readdir(directory)).toEqual([`import-${destinationId}.sqlite3`]);
  });
});

function createDriver(
  localBackupPolicy: BackupPolicy = LOCAL_BACKUP_POLICY,
): DatabaseImportStagingDriver {
  return new DatabaseImportStagingDriver({
    localBackupPolicy,
    now: () => new Date(BUILD_TIME),
    idFactory: () => DATABASE_ID,
  });
}

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'daily-workbench-portable-database-'));
  temporaryDirectories.push(directory);
  return directory;
}

async function stagePackage(
  directory: string,
  destinationId: string,
  stagingId: string,
  packageData: ParsedPortablePackage,
  driver: DatabaseImportStagingDriver,
): Promise<string> {
  const destinationPath = join(directory, `import-${destinationId}.sqlite3`);
  const stager = new AtomicImportStager({
    directory,
    driver,
    idFactory: () => stagingId,
  });
  await stager.stage({
    importId: destinationId,
    package: packageData,
    destinationPath,
  });
  return destinationPath;
}

function createPackage(sourceSchemaVersion = 7): ParsedPortablePackage {
  return parsePortablePackage(
    serializePortablePackage({
      exportId: EXPORT_ID,
      exportedAt: BUILD_TIME,
      sourceAppVersion: '0.1.0',
      sourceSchemaVersion,
      records: [...createRecords()].reverse(),
    }),
  );
}

function createAutomationPackage(): ParsedPortablePackage {
  return parsePortablePackage(
    serializePortablePackage({
      exportId: '71717171-7171-4171-8171-717171717171',
      exportedAt: BUILD_TIME,
      sourceAppVersion: '0.1.0',
      sourceSchemaVersion: 9,
      records: [
        ...createRecords(),
        {
          type: 'automation-definition',
          data: {
            id: AUTOMATION_ID,
            workspaceId: ACTIVE_WORKSPACE_ID,
            name: '每日回顾',
            enabled: true,
            schedule: {
              cadence: 'daily',
              localTimeMinute: 17 * 60 + 30,
              weekday: null,
            },
            action: {
              kind: 'create-note',
              title: '工作回顾',
              body: '## 完成\n\n## 下一步',
            },
            revision: 4,
            createdAt: T1,
            updatedAt: T4,
            archivedAt: null,
          },
        },
      ],
    }),
  );
}

function createFocusPackage(
  pausedRemainingSeconds = 900,
  pausedTaskId: string | null = TASK_ID,
  sourceSchemaVersion: 10 | 11 = 11,
): ParsedPortablePackage {
  return parsePortablePackage(
    serializePortablePackage({
      exportId: '71717171-7171-4171-8171-717171717173',
      exportedAt: BUILD_TIME,
      sourceAppVersion: '0.1.0',
      sourceSchemaVersion,
      records: [
        ...createRecords(),
        {
          type: 'focus-session',
          data: {
            id: PAUSED_FOCUS_ID,
            workspaceId: ACTIVE_WORKSPACE_ID,
            taskId: pausedTaskId,
            status: 'paused',
            remainingSeconds: pausedRemainingSeconds,
            revision: 2,
            localDate: '2026-07-23',
            createdAt: T1,
            updatedAt: T2,
            completedAt: null,
          },
        },
        {
          type: 'focus-session',
          data: {
            id: COMPLETED_FOCUS_ID,
            workspaceId: ARCHIVED_WORKSPACE_ID,
            taskId: null,
            status: 'completed',
            remainingSeconds: 0,
            revision: 3,
            localDate: '2026-07-22',
            createdAt: T1,
            updatedAt: T4,
            completedAt: T3,
          },
        },
      ],
    }),
  );
}

function automationDefinitionRecord(index: number, workspaceId: string): PortableDataRecord {
  const idPrefix = (index + 1).toString(16).padStart(8, '0');
  return {
    type: 'automation-definition',
    data: {
      id: `${idPrefix}-0000-4000-8000-000000000000`,
      workspaceId,
      name: `历史自动化 ${index + 1}`,
      enabled: false,
      schedule: {
        cadence: 'daily',
        localTimeMinute: 8 * 60 + 30,
        weekday: null,
      },
      action: {
        kind: 'create-today-task',
        title: `历史任务 ${index + 1}`,
      },
      revision: 1,
      createdAt: T1,
      updatedAt: T1,
      archivedAt: null,
    },
  };
}

function createPackageWithNoteTitle(title: string): ParsedPortablePackage {
  const records = createRecords().map((record) =>
    record.type === 'note' ? { ...record, data: { ...record.data, title } } : record,
  );
  return parsePortablePackage(
    serializePortablePackage({
      exportId: 'abababab-abab-4bab-8bab-abababababab',
      exportedAt: BUILD_TIME,
      sourceAppVersion: '0.1.0',
      sourceSchemaVersion: 7,
      records,
    }),
  );
}

function createRecords(): readonly PortableDataRecord[] {
  return [
    {
      type: 'app-state',
      data: { currentWorkspaceId: ACTIVE_WORKSPACE_ID, updatedAt: T0 },
    },
    {
      type: 'workspace',
      data: {
        id: ACTIVE_WORKSPACE_ID,
        name: '共享工作区',
        color: '#7b6ee8',
        createdAt: T0,
        updatedAt: T0,
        archivedAt: null,
      },
    },
    {
      type: 'workspace',
      data: {
        id: ARCHIVED_WORKSPACE_ID,
        name: '共享工作区',
        color: '#348bd4',
        createdAt: T0,
        updatedAt: T5,
        archivedAt: T5,
      },
    },
    workspacePreference(ACTIVE_WORKSPACE_ID, T0, false),
    workspacePreference(ARCHIVED_WORKSPACE_ID, T1, true),
    {
      type: 'inbox-entry',
      data: {
        id: ACTIVE_INBOX_ID,
        workspaceId: ACTIVE_WORKSPACE_ID,
        content: '转换为任务',
        category: 'task',
        createdAt: T1,
        updatedAt: T2,
        archivedAt: T2,
      },
    },
    {
      type: 'inbox-entry',
      data: {
        id: ARCHIVED_INBOX_ID,
        workspaceId: ARCHIVED_WORKSPACE_ID,
        content: '历史收件箱',
        category: 'note',
        createdAt: T1,
        updatedAt: T2,
        archivedAt: T2,
      },
    },
    {
      type: 'task',
      data: {
        id: TASK_ID,
        workspaceId: ACTIVE_WORKSPACE_ID,
        title: '已完成任务',
        status: 'completed',
        plannedFor: '2026-07-23',
        sourceInboxEntryId: ACTIVE_INBOX_ID,
        createdAt: T3,
        updatedAt: T4,
        completedAt: T4,
      },
    },
    {
      type: 'note',
      data: {
        id: NOTE_ID,
        workspaceId: ARCHIVED_WORKSPACE_ID,
        title: '历史笔记',
        body: '归档工作区仍保留正文。',
        revision: 3,
        sourceInboxEntryId: null,
        createdAt: T2,
        updatedAt: T6,
        archivedAt: T6,
      },
    },
    {
      type: 'schedule-item',
      data: {
        id: SCHEDULE_ID,
        workspaceId: ARCHIVED_WORKSPACE_ID,
        title: '历史日程',
        kind: 'review',
        scheduledFor: '2026-07-23',
        startMinute: 600,
        endMinute: 660,
        revision: 2,
        createdAt: T2,
        updatedAt: T6,
        archivedAt: T6,
      },
    },
    {
      type: 'browser-tab',
      data: {
        id: TAB_ID,
        workspaceId: ARCHIVED_WORKSPACE_ID,
        url: 'https://example.com/history',
        title: 'History',
        createdAt: T2,
        updatedAt: T3,
      },
    },
    {
      type: 'browser-state',
      data: {
        workspaceId: ARCHIVED_WORKSPACE_ID,
        activeTabId: TAB_ID,
        revision: 4,
        updatedAt: T5,
      },
    },
    {
      type: 'browser-bookmark',
      data: {
        id: BOOKMARK_ID,
        workspaceId: ARCHIVED_WORKSPACE_ID,
        url: 'https://example.com/bookmark',
        title: 'Bookmark',
        createdAt: T4,
      },
    },
  ];
}

function workspacePreference(
  workspaceId: string,
  updatedAt: string,
  sidebarCollapsed: boolean,
): PortableDataRecord {
  return {
    type: 'workspace-preference',
    data: {
      workspaceId,
      activeView: 'today',
      theme: 'dark',
      sidebarCollapsed,
      browserOpen: true,
      browserWidth: 430,
      terminalOpen: true,
      terminalHeight: 260,
      updatedAt,
    },
  };
}

function mutateRecord(
  source: ParsedPortablePackage,
  type: PortableRecordType,
  mutate: (data: PortableDataRecord['data']) => {
    readonly [key: string]: PortableDataRecord['data'][string];
  },
): ParsedPortablePackage {
  let replaced = false;
  return {
    ...source,
    records: source.records.map((record) => {
      if (record.type !== type || replaced) return record;
      replaced = true;
      return { ...record, data: mutate(record.data) };
    }),
  };
}
