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

    const source = createNodeSqliteAdapter(sourcePath, { readOnly: true });
    source.open();
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
        sourceSchemaVersion: 7,
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

function createPackage(): ParsedPortablePackage {
  return parsePortablePackage(
    serializePortablePackage({
      exportId: EXPORT_ID,
      exportedAt: BUILD_TIME,
      sourceAppVersion: '0.1.0',
      sourceSchemaVersion: 7,
      records: [...createRecords()].reverse(),
    }),
  );
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
        createdAt: T1,
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
