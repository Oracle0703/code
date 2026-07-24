import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ReplacementMarkerStore,
  parsePortablePackage,
  type PortableDataRecord,
} from '../src/main/data-portability';
import { DataPortabilityController } from '../src/main/data-management';
import type { ReplacementMarkerPersistence } from '../src/main/data-portability';

const temporaryDirectories: string[] = [];
const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const IMPORT_ID = '22222222-2222-4222-8222-222222222222';
const BACKUP_ID = '33333333-3333-4333-8333-333333333333';
const EXPORT_ID = '44444444-4444-4444-8444-444444444444';
const TEMPORARY_ID = '55555555-5555-4555-8555-555555555555';
const RESTORE_ID = '66666666-6666-4666-8666-666666666666';
const RESTORE_BACKUP_ID = '77777777-7777-4777-8777-777777777777';
const NOW = '2026-07-23T12:34:56.000Z';

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('DataPortabilityController', () => {
  it('writes a canonical logical export without exposing its path', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'daily-workbench-export-'));
    temporaryDirectories.push(directory);
    const destination = join(directory, 'workspace-export.dwbx');
    const controller = new DataPortabilityController({
      database: createDatabase(),
      dialogs: {
        chooseExportPath: async () => destination,
        chooseImportPath: async () => undefined,
      },
      quarantine: createQuarantine(),
      markerStore: new ReplacementMarkerStore(new MemoryMarkerPersistence()),
      appVersion: '0.1.0',
      requestDestructiveConfirmation: async () => true,
      requestReplacementApproval: async () => true,
      prepareReplacement: async () => undefined,
      scheduleRestart: async () => undefined,
      now: () => new Date(NOW),
      idFactory: sequentialIds(EXPORT_ID, TEMPORARY_ID),
    });

    await expect(controller.exportData()).resolves.toEqual({
      status: 'exported',
      fileName: 'workspace-export.dwbx',
      exportedAt: NOW,
      sizeBytes: expect.any(Number),
      recordCount: 2,
    });
    const parsed = parsePortablePackage(await readFile(destination));
    expect(parsed.manifest).toMatchObject({
      exportId: EXPORT_ID,
      exportedAt: NOW,
      sourceAppVersion: '0.1.0',
      sourceSchemaVersion: 7,
      recordCount: 2,
    });
  });

  it('exports schema 10 records as v3 with exact focus-session counts', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'daily-workbench-focus-export-'));
    temporaryDirectories.push(directory);
    const destination = join(directory, 'focus-export.dwbx');
    const database = createDatabase();
    const records = await database.readPortableRecords();
    database.getStatus.mockResolvedValue({
      schemaVersion: 10,
      appliedMigrations: 10,
      sqliteVersion: '3.53.1',
      journalMode: 'wal',
      integrityCheck: 'ok',
      backupCount: 0,
    });
    database.readPortableRecords.mockResolvedValue([
      ...records,
      {
        type: 'focus-session',
        data: {
          id: '66666666-6666-4666-8666-666666666666',
          workspaceId: WORKSPACE_ID,
          taskId: null,
          status: 'paused',
          remainingSeconds: 900,
          revision: 2,
          localDate: '2026-07-23',
          createdAt: NOW,
          updatedAt: NOW,
          completedAt: null,
        },
      },
    ]);
    const controller = new DataPortabilityController({
      database,
      dialogs: {
        chooseExportPath: async () => destination,
        chooseImportPath: async () => undefined,
      },
      quarantine: createQuarantine(),
      markerStore: new ReplacementMarkerStore(new MemoryMarkerPersistence()),
      appVersion: '0.1.0',
      requestDestructiveConfirmation: async () => true,
      requestReplacementApproval: async () => true,
      prepareReplacement: async () => undefined,
      scheduleRestart: async () => undefined,
      now: () => new Date(NOW),
      idFactory: sequentialIds(EXPORT_ID, TEMPORARY_ID),
    });

    await expect(controller.exportData()).resolves.toMatchObject({
      status: 'exported',
      recordCount: 3,
    });
    expect(parsePortablePackage(await readFile(destination)).manifest).toMatchObject({
      formatVersion: 3,
      sourceSchemaVersion: 10,
      recordCount: 3,
      counts: { focusSessions: 1 },
    });
  });

  it('reports export durability failure without deleting an already published file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'daily-workbench-export-durability-'));
    temporaryDirectories.push(directory);
    const destination = join(directory, 'durability-export.dwbx');
    const syncDirectory = vi.fn(async () => {
      throw new Error('export directory sync failed');
    });
    const controller = new DataPortabilityController({
      database: createDatabase(),
      dialogs: {
        chooseExportPath: async () => destination,
        chooseImportPath: async () => undefined,
      },
      quarantine: createQuarantine(),
      markerStore: new ReplacementMarkerStore(new MemoryMarkerPersistence()),
      appVersion: '0.1.0',
      requestDestructiveConfirmation: async () => true,
      requestReplacementApproval: async () => true,
      prepareReplacement: async () => undefined,
      scheduleRestart: async () => undefined,
      now: () => new Date(NOW),
      idFactory: sequentialIds(EXPORT_ID, TEMPORARY_ID),
      exportDurability: { syncDirectory },
    });

    await expect(controller.exportData()).rejects.toThrow(/directory sync failed/u);
    expect(syncDirectory).toHaveBeenCalledExactlyOnceWith(directory);
    expect(parsePortablePackage(await readFile(destination)).manifest.exportId).toBe(EXPORT_ID);
  });

  it('does not overwrite a destination created while export records are being read', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'daily-workbench-export-created-'));
    temporaryDirectories.push(directory);
    const destination = join(directory, 'created-during-export.dwbx');
    const database = createDatabase();
    const records = await database.readPortableRecords();
    let releaseRead: (() => void) | undefined;
    let signalReadStarted: (() => void) | undefined;
    const readStarted = new Promise<void>((resolve) => {
      signalReadStarted = resolve;
    });
    const readReleased = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    database.readPortableRecords.mockImplementation(async () => {
      signalReadStarted?.();
      await readReleased;
      return records;
    });
    const controller = new DataPortabilityController({
      database,
      dialogs: {
        chooseExportPath: async () => destination,
        chooseImportPath: async () => undefined,
      },
      quarantine: createQuarantine(),
      markerStore: new ReplacementMarkerStore(new MemoryMarkerPersistence()),
      appVersion: '0.1.0',
      requestDestructiveConfirmation: async () => true,
      requestReplacementApproval: async () => true,
      prepareReplacement: async () => undefined,
      scheduleRestart: async () => undefined,
      now: () => new Date(NOW),
      idFactory: sequentialIds(EXPORT_ID, TEMPORARY_ID),
    });

    const exporting = controller.exportData();
    await readStarted;
    await writeFile(destination, 'created without overwrite approval');
    releaseRead?.();

    await expect(exporting).rejects.toThrow(/created after overwrite approval/u);
    await expect(readFile(destination, 'utf8')).resolves.toBe('created without overwrite approval');
  });

  it('does not overwrite an approved destination replaced during export preparation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'daily-workbench-export-replaced-'));
    temporaryDirectories.push(directory);
    const destination = join(directory, 'approved-export.dwbx');
    const originalDestination = join(directory, 'approved-export.original.dwbx');
    await writeFile(destination, 'approved original file');
    const database = createDatabase();
    const records = await database.readPortableRecords();
    let releaseRead: (() => void) | undefined;
    let signalReadStarted: (() => void) | undefined;
    const readStarted = new Promise<void>((resolve) => {
      signalReadStarted = resolve;
    });
    const readReleased = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    database.readPortableRecords.mockImplementation(async () => {
      signalReadStarted?.();
      await readReleased;
      return records;
    });
    const controller = new DataPortabilityController({
      database,
      dialogs: {
        chooseExportPath: async () => destination,
        chooseImportPath: async () => undefined,
      },
      quarantine: createQuarantine(),
      markerStore: new ReplacementMarkerStore(new MemoryMarkerPersistence()),
      appVersion: '0.1.0',
      requestDestructiveConfirmation: async () => true,
      requestReplacementApproval: async () => true,
      prepareReplacement: async () => undefined,
      scheduleRestart: async () => undefined,
      now: () => new Date(NOW),
      idFactory: sequentialIds(EXPORT_ID, TEMPORARY_ID),
    });

    const exporting = controller.exportData();
    await readStarted;
    await rename(destination, originalDestination);
    await writeFile(destination, 'replacement without overwrite approval');
    releaseRead?.();

    await expect(exporting).rejects.toThrow(/changed after overwrite approval/u);
    await expect(readFile(destination, 'utf8')).resolves.toBe(
      'replacement without overwrite approval',
    );
    await expect(readFile(originalDestination, 'utf8')).resolves.toBe('approved original file');
  });

  it('never appends an extension that bypasses the save dialog overwrite target', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'daily-workbench-export-target-'));
    temporaryDirectories.push(directory);
    const selectedPath = join(directory, 'existing-export');
    const unapprovedTarget = `${selectedPath}.dwbx`;
    await writeFile(unapprovedTarget, 'keep existing data');
    const controller = new DataPortabilityController({
      database: createDatabase(),
      dialogs: {
        chooseExportPath: async () => selectedPath,
        chooseImportPath: async () => undefined,
      },
      quarantine: createQuarantine(),
      markerStore: new ReplacementMarkerStore(new MemoryMarkerPersistence()),
      appVersion: '0.1.0',
      requestDestructiveConfirmation: async () => true,
      requestReplacementApproval: async () => true,
      prepareReplacement: async () => undefined,
      scheduleRestart: async () => undefined,
    });

    await expect(controller.exportData()).rejects.toThrow(/\.dwbx extension/u);
    await expect(readFile(unapprovedTarget, 'utf8')).resolves.toBe('keep existing data');
  });

  it('creates an approved replacement marker before deferring restart', async () => {
    const persistence = new MemoryMarkerPersistence();
    const quarantine = createQuarantine();
    const deferredTasks: Array<() => void> = [];
    const scheduleRestart = vi.fn(async () => undefined);
    const operationOrder: string[] = [];
    quarantine.refreshClaimed.mockImplementation(async () => {
      operationOrder.push('refresh-staging');
      return createPreparedImport();
    });
    const controller = new DataPortabilityController({
      database: {
        ...createDatabase(),
        createPreImportBackup: vi.fn(async () => {
          operationOrder.push('backup');
          return {
            id: BACKUP_ID,
            fileName: 'backup.sqlite3',
            createdAt: NOW,
            sizeBytes: 100,
            reason: 'pre-import' as const,
            schemaVersion: 7,
          };
        }),
        validateExistingBackup: vi.fn(async () => {
          operationOrder.push('validate-backup');
          return {
            id: BACKUP_ID,
            fileName: 'backup.sqlite3',
            createdAt: NOW,
            sizeBytes: 100,
            reason: 'pre-import' as const,
            schemaVersion: 7,
          };
        }),
      },
      dialogs: {
        chooseExportPath: async () => undefined,
        chooseImportPath: async () => undefined,
      },
      quarantine,
      markerStore: new ReplacementMarkerStore(persistence),
      appVersion: '0.1.0',
      requestDestructiveConfirmation: async () => {
        operationOrder.push('destructive-confirmation');
        return true;
      },
      requestReplacementApproval: async () => {
        operationOrder.push('close-approval');
        return true;
      },
      prepareReplacement: async () => {
        operationOrder.push('freeze-writers');
      },
      scheduleRestart,
      now: () => new Date(NOW),
      defer: (task) => deferredTasks.push(task),
    });

    await expect(
      controller.commitImport({ importId: IMPORT_ID, previewDigest: 'a'.repeat(64) }),
    ).resolves.toEqual({ restarting: true });
    expect(quarantine.detachClaimed).toHaveBeenCalledExactlyOnceWith({ importId: IMPORT_ID });
    expect(operationOrder).toEqual([
      'destructive-confirmation',
      'close-approval',
      'freeze-writers',
      'refresh-staging',
      'backup',
      'validate-backup',
    ]);
    expect(scheduleRestart).not.toHaveBeenCalled();
    await expect(new ReplacementMarkerStore(persistence).read()).resolves.toMatchObject({
      phase: 'ready',
      replacementId: IMPORT_ID,
      preImportBackupId: BACKUP_ID,
    });

    deferredTasks[0]?.();
    await vi.waitFor(() => expect(scheduleRestart).toHaveBeenCalledTimes(1));
  });

  it('discards a claimed staging set when close approval is denied', async () => {
    const persistence = new MemoryMarkerPersistence();
    const quarantine = createQuarantine();
    const scheduleRestart = vi.fn(async () => undefined);
    const controller = new DataPortabilityController({
      database: createDatabase(),
      dialogs: {
        chooseExportPath: async () => undefined,
        chooseImportPath: async () => undefined,
      },
      quarantine,
      markerStore: new ReplacementMarkerStore(persistence),
      appVersion: '0.1.0',
      requestDestructiveConfirmation: async () => true,
      requestReplacementApproval: async () => false,
      prepareReplacement: async () => undefined,
      scheduleRestart,
    });

    await expect(
      controller.commitImport({ importId: IMPORT_ID, previewDigest: 'a'.repeat(64) }),
    ).rejects.toThrow(/cancelled/u);
    expect(quarantine.discardClaimed).toHaveBeenCalledExactlyOnceWith({ importId: IMPORT_ID });
    await expect(new ReplacementMarkerStore(persistence).read()).resolves.toBeUndefined();
    expect(scheduleRestart).not.toHaveBeenCalled();
  });

  it('requires Main-owned destructive confirmation for the exact preview token', async () => {
    const quarantine = createQuarantine();
    const database = createDatabase();
    const requestDestructiveConfirmation = vi.fn(async () => false);
    const requestReplacementApproval = vi.fn(async () => true);
    const prepareReplacement = vi.fn(async () => undefined);
    const scheduleRestart = vi.fn(async () => undefined);
    const controller = new DataPortabilityController({
      database,
      dialogs: {
        chooseExportPath: async () => undefined,
        chooseImportPath: async () => undefined,
      },
      quarantine,
      markerStore: new ReplacementMarkerStore(new MemoryMarkerPersistence()),
      appVersion: '0.1.0',
      requestDestructiveConfirmation,
      requestReplacementApproval,
      prepareReplacement,
      scheduleRestart,
    });
    const input = { importId: IMPORT_ID, previewDigest: 'a'.repeat(64) };

    await expect(controller.commitImport(input)).rejects.toThrow(/cancelled/u);
    expect(requestDestructiveConfirmation).toHaveBeenCalledExactlyOnceWith(input);
    expect(requestReplacementApproval).not.toHaveBeenCalled();
    expect(prepareReplacement).not.toHaveBeenCalled();
    expect(database.createPreImportBackup).not.toHaveBeenCalled();
    expect(quarantine.discardClaimed).toHaveBeenCalledExactlyOnceWith({
      importId: IMPORT_ID,
    });
    expect(scheduleRestart).not.toHaveBeenCalled();
  });

  it('forces an original-database restart when writer freeze fails after close approval', async () => {
    const quarantine = createQuarantine();
    const database = createDatabase();
    const deferredTasks: Array<() => void> = [];
    const scheduleRestart = vi.fn(async () => undefined);
    const controller = new DataPortabilityController({
      database,
      dialogs: {
        chooseExportPath: async () => undefined,
        chooseImportPath: async () => undefined,
      },
      quarantine,
      markerStore: new ReplacementMarkerStore(new MemoryMarkerPersistence()),
      appVersion: '0.1.0',
      requestDestructiveConfirmation: async () => true,
      requestReplacementApproval: async () => true,
      prepareReplacement: async () => {
        throw new Error('browser shutdown failed');
      },
      scheduleRestart,
      defer: (task) => deferredTasks.push(task),
    });

    await expect(
      controller.commitImport({ importId: IMPORT_ID, previewDigest: 'a'.repeat(64) }),
    ).rejects.toThrow(/browser shutdown failed/u);
    expect(database.createPreImportBackup).not.toHaveBeenCalled();
    expect(quarantine.discardClaimed).toHaveBeenCalledExactlyOnceWith({
      importId: IMPORT_ID,
    });
    expect(scheduleRestart).not.toHaveBeenCalled();
    deferredTasks[0]?.();
    await vi.waitFor(() => expect(scheduleRestart).toHaveBeenCalledTimes(1));
  });

  it('does not publish a replacement marker when the pre-import backup cannot be revalidated', async () => {
    const quarantine = createQuarantine();
    const deferredTasks: Array<() => void> = [];
    const scheduleRestart = vi.fn(async () => undefined);
    const markerStore = new ReplacementMarkerStore(new MemoryMarkerPersistence());
    const controller = new DataPortabilityController({
      database: {
        ...createDatabase(),
        validateExistingBackup: vi.fn(async () => {
          throw new Error('backup validation failed');
        }),
      },
      dialogs: {
        chooseExportPath: async () => undefined,
        chooseImportPath: async () => undefined,
      },
      quarantine,
      markerStore,
      appVersion: '0.1.0',
      requestDestructiveConfirmation: async () => true,
      requestReplacementApproval: async () => true,
      prepareReplacement: async () => undefined,
      scheduleRestart,
      defer: (task) => deferredTasks.push(task),
    });

    await expect(
      controller.commitImport({ importId: IMPORT_ID, previewDigest: 'a'.repeat(64) }),
    ).rejects.toThrow(/backup validation failed/u);
    expect(quarantine.discardClaimed).toHaveBeenCalledExactlyOnceWith({
      importId: IMPORT_ID,
    });
    await expect(markerStore.read()).resolves.toBeUndefined();
    deferredTasks[0]?.();
    await vi.waitFor(() => expect(scheduleRestart).toHaveBeenCalledTimes(1));
  });

  it('preserves claimed artifacts when a marker write commits before reporting failure', async () => {
    const persistence = new CommittedThenRejectedPersistence();
    const quarantine = createQuarantine();
    const deferredTasks: Array<() => void> = [];
    const scheduleRestart = vi.fn(async () => undefined);
    const controller = new DataPortabilityController({
      database: createDatabase(),
      dialogs: {
        chooseExportPath: async () => undefined,
        chooseImportPath: async () => undefined,
      },
      quarantine,
      markerStore: new ReplacementMarkerStore(persistence),
      appVersion: '0.1.0',
      requestDestructiveConfirmation: async () => true,
      requestReplacementApproval: async () => true,
      prepareReplacement: async () => undefined,
      scheduleRestart,
      now: () => new Date(NOW),
      defer: (task) => deferredTasks.push(task),
    });

    await expect(
      controller.commitImport({ importId: IMPORT_ID, previewDigest: 'a'.repeat(64) }),
    ).rejects.toThrow(/directory sync failed/u);
    expect(quarantine.discardClaimed).not.toHaveBeenCalled();
    expect(quarantine.detachClaimed).toHaveBeenCalledExactlyOnceWith({
      importId: IMPORT_ID,
    });
    await expect(new ReplacementMarkerStore(persistence).read()).resolves.toMatchObject({
      replacementId: IMPORT_ID,
      phase: 'ready',
      stagingSha256: 'c'.repeat(64),
    });
    deferredTasks[0]?.();
    await vi.waitFor(() => expect(scheduleRestart).toHaveBeenCalledTimes(1));
  });

  it('stages an exact backup token before confirmation and publishes the refreshed restore', async () => {
    const persistence = new MemoryMarkerPersistence();
    const database = createDatabase();
    const deferredTasks: Array<() => void> = [];
    const scheduleRestart = vi.fn(async () => undefined);
    const operationOrder: string[] = [];
    database.prepareBackupRestore.mockImplementation(async () => {
      operationOrder.push('prepare-staging');
      return createPreparedBackupRestore();
    });
    database.refreshBackupRestore.mockImplementation(async () => {
      operationOrder.push('refresh-staging');
      return {
        ...createPreparedBackupRestore(),
        stagingDigest: 'e'.repeat(64),
      };
    });
    database.createPreImportBackup.mockImplementation(async () => {
      operationOrder.push('safety-backup');
      return {
        id: BACKUP_ID,
        fileName: 'backup.sqlite3',
        createdAt: NOW,
        sizeBytes: 100,
        reason: 'pre-import',
        schemaVersion: 11,
      };
    });
    database.validateExistingBackup.mockImplementation(async () => {
      operationOrder.push('validate-safety-backup');
      return {
        id: BACKUP_ID,
        fileName: 'backup.sqlite3',
        createdAt: NOW,
        sizeBytes: 100,
        reason: 'pre-import',
        schemaVersion: 11,
      };
    });
    const requestBackupRestoreConfirmation = vi.fn(async () => {
      operationOrder.push('native-confirmation');
      return true;
    });
    const controller = new DataPortabilityController({
      database,
      dialogs: {
        chooseExportPath: async () => undefined,
        chooseImportPath: async () => undefined,
      },
      quarantine: createQuarantine(),
      markerStore: new ReplacementMarkerStore(persistence),
      appVersion: '0.1.0',
      requestDestructiveConfirmation: async () => true,
      requestBackupRestoreConfirmation,
      requestReplacementApproval: async () => {
        operationOrder.push('close-approval');
        return true;
      },
      prepareReplacement: async () => {
        operationOrder.push('freeze-writers');
      },
      scheduleRestart,
      now: () => new Date(NOW),
      idFactory: () => RESTORE_ID,
      defer: (task) => deferredTasks.push(task),
    });
    const input = createBackupRestoreInput();

    await expect(controller.restoreBackup(input)).resolves.toEqual({ status: 'restarting' });
    expect(database.prepareBackupRestore).toHaveBeenCalledExactlyOnceWith(input, RESTORE_ID);
    expect(requestBackupRestoreConfirmation).toHaveBeenCalledExactlyOnceWith(
      createPreparedBackupRestore(),
    );
    expect(operationOrder).toEqual([
      'prepare-staging',
      'native-confirmation',
      'close-approval',
      'freeze-writers',
      'refresh-staging',
      'safety-backup',
      'validate-safety-backup',
    ]);
    expect(database.discardBackupRestore).not.toHaveBeenCalled();
    await expect(new ReplacementMarkerStore(persistence).read()).resolves.toMatchObject({
      phase: 'ready',
      replacementId: RESTORE_ID,
      stagingFileName: `import-${RESTORE_ID}.sqlite3`,
      stagingSha256: 'e'.repeat(64),
      preImportBackupId: BACKUP_ID,
    });
    expect(scheduleRestart).not.toHaveBeenCalled();
    deferredTasks[0]?.();
    await vi.waitFor(() => expect(scheduleRestart).toHaveBeenCalledTimes(1));
  });

  it('discards the staged restore when Main confirmation is cancelled', async () => {
    const database = createDatabase();
    const requestReplacementApproval = vi.fn(async () => true);
    const prepareReplacement = vi.fn(async () => undefined);
    const scheduleRestart = vi.fn(async () => undefined);
    const controller = new DataPortabilityController({
      database,
      dialogs: {
        chooseExportPath: async () => undefined,
        chooseImportPath: async () => undefined,
      },
      quarantine: createQuarantine(),
      markerStore: new ReplacementMarkerStore(new MemoryMarkerPersistence()),
      appVersion: '0.1.0',
      requestDestructiveConfirmation: async () => true,
      requestBackupRestoreConfirmation: async () => false,
      requestReplacementApproval,
      prepareReplacement,
      scheduleRestart,
      idFactory: () => RESTORE_ID,
    });

    await expect(controller.restoreBackup(createBackupRestoreInput())).resolves.toEqual({
      status: 'cancelled',
    });
    expect(database.discardBackupRestore).toHaveBeenCalledExactlyOnceWith(
      createPreparedBackupRestore(),
    );
    expect(requestReplacementApproval).not.toHaveBeenCalled();
    expect(prepareReplacement).not.toHaveBeenCalled();
    expect(database.createPreImportBackup).not.toHaveBeenCalled();
    expect(scheduleRestart).not.toHaveBeenCalled();
  });

  it('rejects backup restore while an import preview owns quarantine state', async () => {
    const database = createDatabase();
    const quarantine = {
      ...createQuarantine(),
      hasActiveSession: vi.fn(() => true),
    };
    const controller = new DataPortabilityController({
      database,
      dialogs: {
        chooseExportPath: async () => undefined,
        chooseImportPath: async () => undefined,
      },
      quarantine,
      markerStore: new ReplacementMarkerStore(new MemoryMarkerPersistence()),
      appVersion: '0.1.0',
      requestDestructiveConfirmation: async () => true,
      requestBackupRestoreConfirmation: async () => true,
      requestReplacementApproval: async () => true,
      prepareReplacement: async () => undefined,
      scheduleRestart: async () => undefined,
      idFactory: () => RESTORE_ID,
    });

    await expect(controller.restoreBackup(createBackupRestoreInput())).rejects.toThrow(
      /cancel the active data import preview/iu,
    );
    expect(database.prepareBackupRestore).not.toHaveBeenCalled();
  });

  it('discards staging and forces a clean restart if refresh fails after writer freeze', async () => {
    const database = createDatabase();
    database.refreshBackupRestore.mockRejectedValue(new Error('staged restore changed'));
    const deferredTasks: Array<() => void> = [];
    const scheduleRestart = vi.fn(async () => undefined);
    const controller = new DataPortabilityController({
      database,
      dialogs: {
        chooseExportPath: async () => undefined,
        chooseImportPath: async () => undefined,
      },
      quarantine: createQuarantine(),
      markerStore: new ReplacementMarkerStore(new MemoryMarkerPersistence()),
      appVersion: '0.1.0',
      requestDestructiveConfirmation: async () => true,
      requestBackupRestoreConfirmation: async () => true,
      requestReplacementApproval: async () => true,
      prepareReplacement: async () => undefined,
      scheduleRestart,
      idFactory: () => RESTORE_ID,
      defer: (task) => deferredTasks.push(task),
    });

    await expect(controller.restoreBackup(createBackupRestoreInput())).rejects.toThrow(
      /staged restore changed/u,
    );
    expect(database.discardBackupRestore).toHaveBeenCalledExactlyOnceWith(
      createPreparedBackupRestore(),
    );
    expect(database.createPreImportBackup).not.toHaveBeenCalled();
    expect(scheduleRestart).not.toHaveBeenCalled();
    deferredTasks[0]?.();
    await vi.waitFor(() => expect(scheduleRestart).toHaveBeenCalledTimes(1));
  });
});

function createDatabase() {
  return {
    getStatus: vi.fn(async () => ({
      schemaVersion: 7,
      appliedMigrations: 7,
      sqliteVersion: '3.53.1',
      journalMode: 'wal' as const,
      integrityCheck: 'ok' as const,
      backupCount: 0,
    })),
    readPortableRecords: vi.fn(async (): Promise<readonly PortableDataRecord[]> => [
      { type: 'app-state', data: { currentWorkspaceId: WORKSPACE_ID } },
      {
        type: 'workspace',
        data: {
          id: WORKSPACE_ID,
          name: '工作区',
          nameKey: '工作区',
          color: '#7b6ee8',
          createdAt: NOW,
          updatedAt: NOW,
          archivedAt: null,
        },
      },
    ]),
    createPreImportBackup: vi.fn(async () => ({
      id: BACKUP_ID,
      fileName: 'backup.sqlite3',
      createdAt: NOW,
      sizeBytes: 100,
      reason: 'pre-import' as const,
      schemaVersion: 7,
    })),
    validateExistingBackup: vi.fn(async () => ({
      id: BACKUP_ID,
      fileName: 'backup.sqlite3',
      createdAt: NOW,
      sizeBytes: 100,
      reason: 'pre-import' as const,
      schemaVersion: 7,
    })),
    prepareBackupRestore: vi.fn(async () => createPreparedBackupRestore()),
    refreshBackupRestore: vi.fn(async () => createPreparedBackupRestore()),
    discardBackupRestore: vi.fn(async () => undefined),
  };
}

function createQuarantine() {
  return {
    prepare: vi.fn(),
    claim: vi.fn(async () => createPreparedImport()),
    refreshClaimed: vi.fn(async () => createPreparedImport()),
    cancel: vi.fn(async () => undefined),
    discardClaimed: vi.fn(async () => undefined),
    detachClaimed: vi.fn(),
  };
}

function createPreparedImport() {
  return {
    importId: IMPORT_ID,
    packagePath: `/controlled/import-${IMPORT_ID}.dwbx`,
    packageDigest: 'b'.repeat(64),
    stagingPath: `/controlled/import-${IMPORT_ID}.sqlite3`,
    stagingDigest: 'c'.repeat(64),
  };
}

function createPreparedBackupRestore() {
  return {
    restoreId: RESTORE_ID,
    backup: {
      id: RESTORE_BACKUP_ID,
      fileName: 'backup.sqlite3',
      createdAt: NOW,
      sizeBytes: 100,
      reason: 'manual' as const,
      schemaVersion: 7,
    },
    sourceDigest: 'c'.repeat(64),
    stagingFileName: `import-${RESTORE_ID}.sqlite3`,
    stagingDigest: 'd'.repeat(64),
  };
}

function createBackupRestoreInput() {
  return {
    backupId: RESTORE_BACKUP_ID,
    expectedReason: 'manual' as const,
    expectedCreatedAt: NOW,
    expectedSizeBytes: 100,
    expectedSchemaVersion: 7,
  };
}

class MemoryMarkerPersistence implements ReplacementMarkerPersistence {
  value: unknown;

  async read(): Promise<unknown | undefined> {
    return this.value;
  }

  async write(value: unknown): Promise<void> {
    this.value = structuredClone(value);
  }

  async remove(): Promise<void> {
    this.value = undefined;
  }
}

class CommittedThenRejectedPersistence extends MemoryMarkerPersistence {
  #rejectNextWrite = true;

  override async write(value: unknown): Promise<void> {
    await super.write(value);
    if (this.#rejectNextWrite) {
      this.#rejectNextWrite = false;
      throw new Error('replacement marker directory sync failed');
    }
  }
}

function sequentialIds(...ids: readonly string[]): () => string {
  let index = 0;
  return () => ids[index++] ?? TEMPORARY_ID;
}
