import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ImportQuarantine } from '../src/main/data-portability/import-quarantine';
import {
  parsePortablePackage,
  serializePortablePackage,
} from '../src/main/data-portability/package-format';
import { AtomicImportStager } from '../src/main/data-portability/staging';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe('ImportQuarantine', () => {
  it('stages an immutable package behind a one-time preview token', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'workbench-import-quarantine-'));
    directories.push(directory);
    const stager = new AtomicImportStager({
      directory,
      idFactory: () => 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      driver: {
        build: async (packageData, path) =>
          writeFile(path, `staged:${packageData.manifest.bodySha256}`),
        validate: async (path) => {
          if (!(await readFile(path, 'utf8')).startsWith('staged:')) throw new Error('invalid');
        },
      },
    });
    const quarantine = new ImportQuarantine({
      directory,
      stager,
      idFactory: () => 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      now: () => new Date('2026-07-22T12:00:00.000Z'),
    });
    const preview = await quarantine.prepare(createPackage());
    expect(preview).toMatchObject({
      importId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      currentWorkspaceName: '主工作区',
      includesBrowserData: false,
    });
    const prepared = await quarantine.claim({
      importId: preview.importId,
      previewDigest: preview.previewDigest,
    });
    expect(prepared.packagePath).toContain(preview.importId);
    expect(prepared.stagingPath).toContain(preview.importId);
    await expect(
      quarantine.claim({
        importId: preview.importId,
        previewDigest: preview.previewDigest,
      }),
    ).rejects.toThrow(/no longer available/u);
    await quarantine.discardClaimed({ importId: preview.importId });
    await expect(readFile(prepared.packagePath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(prepared.stagingPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a staged artifact changed after preview', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'workbench-import-tamper-'));
    directories.push(directory);
    const stager = {
      stage: async ({ destinationPath }: { destinationPath: string }) =>
        writeFile(destinationPath, 'valid-stage'),
      validate: async () => undefined,
    };
    const quarantine = new ImportQuarantine({
      directory,
      stager,
      idFactory: () => 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      now: () => new Date('2026-07-22T12:00:00.000Z'),
    });
    const preview = await quarantine.prepare(createPackage());
    await writeFile(join(directory, `import-${preview.importId}.sqlite3`), 'changed-stage');
    await expect(
      quarantine.claim({
        importId: preview.importId,
        previewDigest: preview.previewDigest,
      }),
    ).rejects.toThrow(/changed/u);
    expect(await readdir(directory)).toEqual([]);

    const sidecarPreview = await quarantine.prepare(createPackage());
    await writeFile(
      join(directory, `import-${sidecarPreview.importId}.sqlite3-wal`),
      'unexpected-wal',
    );
    await expect(
      quarantine.claim({
        importId: sidecarPreview.importId,
        previewDigest: sidecarPreview.previewDigest,
      }),
    ).rejects.toThrow(/already exists/u);
    expect(await readdir(directory)).toEqual([]);
  });

  it('allows only one preview and removes its SQLite sidecars on explicit cancel', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'workbench-import-single-preview-'));
    directories.push(directory);
    const ids = ['10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002'];
    const stager = {
      stage: async ({ destinationPath }: { destinationPath: string }) =>
        writeFile(destinationPath, 'valid-stage'),
      validate: async () => undefined,
    };
    const quarantine = new ImportQuarantine({
      directory,
      stager,
      idFactory: () => ids.shift() ?? '10000000-0000-4000-8000-000000000003',
      now: () => new Date('2026-07-22T12:00:00.000Z'),
    });
    const first = await quarantine.prepare(createPackage());
    const stagingPath = join(directory, `import-${first.importId}.sqlite3`);
    await Promise.all([
      writeFile(`${stagingPath}-wal`, 'wal'),
      writeFile(`${stagingPath}-shm`, 'shm'),
      writeFile(`${stagingPath}-journal`, 'journal'),
    ]);
    await expect(quarantine.prepare(createPackage())).rejects.toThrow(/cancelled/u);
    await quarantine.cancel({ importId: first.importId });
    expect(await readdir(directory)).toEqual([]);

    const second = await quarantine.prepare(createPackage());
    expect(second.importId).toBe('10000000-0000-4000-8000-000000000002');
    await quarantine.cancel({ importId: second.importId });
  });

  it('expires and removes an unclaimed preview without waiting for another request', async () => {
    vi.useFakeTimers();
    try {
      const directory = await mkdtemp(join(tmpdir(), 'workbench-import-expiry-'));
      directories.push(directory);
      const stager = {
        stage: async ({ destinationPath }: { destinationPath: string }) =>
          writeFile(destinationPath, 'valid-stage'),
        validate: async () => undefined,
      };
      const quarantine = new ImportQuarantine({
        directory,
        stager,
        idFactory: () => '20000000-0000-4000-8000-000000000001',
        now: () => new Date('2026-07-22T12:00:00.000Z'),
        sessionTtlMs: 60_000,
      });
      const preview = await quarantine.prepare(createPackage());
      const stagingPath = join(directory, `import-${preview.importId}.sqlite3`);
      await Promise.all([
        writeFile(`${stagingPath}-wal`, 'wal'),
        writeFile(`${stagingPath}-shm`, 'shm'),
        writeFile(`${stagingPath}-journal`, 'journal'),
      ]);
      await vi.advanceTimersByTimeAsync(60_000);
      await expect(
        quarantine.claim({
          importId: preview.importId,
          previewDigest: preview.previewDigest,
        }),
      ).rejects.toThrow(/no longer available/u);
      vi.useRealTimers();
      await vi.waitFor(async () => {
        expect(await readdir(directory)).toEqual([]);
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('serializes one-time claims and rebuilds a claimed stage before replacement', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'workbench-import-refresh-'));
    directories.push(directory);
    let policyRevision = 1;
    const replacementModes: boolean[] = [];
    const stager = {
      stage: async ({
        destinationPath,
        replaceExisting,
      }: {
        destinationPath: string;
        replaceExisting?: boolean;
      }) => {
        replacementModes.push(replaceExisting === true);
        await writeFile(destinationPath, `valid-stage-policy-${policyRevision}`);
      },
      validate: async ({ destinationPath }: { destinationPath: string }) => {
        expect(await readFile(destinationPath, 'utf8')).toBe(
          `valid-stage-policy-${policyRevision}`,
        );
      },
    };
    const quarantine = new ImportQuarantine({
      directory,
      stager,
      idFactory: () => '30000000-0000-4000-8000-000000000001',
      now: () => new Date('2026-07-22T12:00:00.000Z'),
    });
    const preview = await quarantine.prepare(createPackage());
    const claims = await Promise.allSettled([
      quarantine.claim({
        importId: preview.importId,
        previewDigest: preview.previewDigest,
      }),
      quarantine.claim({
        importId: preview.importId,
        previewDigest: preview.previewDigest,
      }),
    ]);
    expect(claims.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(claims.filter(({ status }) => status === 'rejected')).toHaveLength(1);
    const claimed = claims.find(
      (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof quarantine.claim>>> =>
        result.status === 'fulfilled',
    )?.value;
    expect(claimed).toBeDefined();

    policyRevision = 2;
    const refreshed = await quarantine.refreshClaimed({ importId: preview.importId });
    expect(refreshed.stagingDigest).not.toBe(claimed?.stagingDigest);
    expect(replacementModes).toEqual([false, true]);
    expect(await readFile(refreshed.stagingPath, 'utf8')).toBe('valid-stage-policy-2');
    await quarantine.discardClaimed({ importId: preview.importId });
  });

  it('rejects a stage changed during final semantic validation and enforces its size cap', async () => {
    const raceDirectory = await mkdtemp(join(tmpdir(), 'workbench-import-binding-race-'));
    directories.push(raceDirectory);
    const raceQuarantine = new ImportQuarantine({
      directory: raceDirectory,
      stager: {
        stage: async ({ destinationPath }) => writeFile(destinationPath, 'expected-stage'),
        validate: async ({ destinationPath }) => writeFile(destinationPath, 'swapped-stage'),
      },
      idFactory: () => '40000000-0000-4000-8000-000000000001',
      now: () => new Date('2026-07-22T12:00:00.000Z'),
    });
    await expect(raceQuarantine.prepare(createPackage())).rejects.toThrow(
      /changed while it was being validated/u,
    );
    expect(await readdir(raceDirectory)).toEqual([]);

    const sizeDirectory = await mkdtemp(join(tmpdir(), 'workbench-import-size-limit-'));
    directories.push(sizeDirectory);
    const sizeQuarantine = new ImportQuarantine({
      directory: sizeDirectory,
      stager: {
        stage: async ({ destinationPath }) => writeFile(destinationPath, Buffer.alloc(33)),
        validate: async () => undefined,
      },
      idFactory: () => '40000000-0000-4000-8000-000000000002',
      now: () => new Date('2026-07-22T12:00:00.000Z'),
      maxStagingBytes: 32,
    });
    await expect(sizeQuarantine.prepare(createPackage())).rejects.toThrow(/bounded/u);
    expect(await readdir(sizeDirectory)).toEqual([]);
  });
});

describe('AtomicImportStager', () => {
  it('keeps the old stage through temporary validation and cleans failed SQLite sidecars', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'workbench-import-atomic-replace-'));
    directories.push(directory);
    const destinationPath = join(directory, 'import-50000000-0000-4000-8000-000000000001.sqlite3');
    await writeFile(destinationPath, 'old-stage');
    const packageData = parsePortablePackage(createPackage());
    const failing = new AtomicImportStager({
      directory,
      idFactory: () => '50000000-0000-4000-8000-000000000002',
      driver: {
        build: async (_packageData, temporaryPath) => {
          expect(await readFile(destinationPath, 'utf8')).toBe('old-stage');
          await Promise.all([
            writeFile(temporaryPath, 'new-stage'),
            writeFile(`${temporaryPath}-journal`, 'journal'),
          ]);
        },
        validate: async (path) => {
          if (path !== destinationPath) throw new Error('temporary validation failed');
        },
      },
    });
    await expect(
      failing.stage({
        importId: '50000000-0000-4000-8000-000000000001',
        package: packageData,
        destinationPath,
        replaceExisting: true,
      }),
    ).rejects.toThrow(/temporary validation failed/u);
    expect(await readFile(destinationPath, 'utf8')).toBe('old-stage');
    expect(await readdir(directory)).toEqual([
      'import-50000000-0000-4000-8000-000000000001.sqlite3',
    ]);

    const replacement = new AtomicImportStager({
      directory,
      idFactory: () => '50000000-0000-4000-8000-000000000003',
      driver: {
        build: async (_packageData, temporaryPath) => {
          expect(await readFile(destinationPath, 'utf8')).toBe('old-stage');
          await writeFile(temporaryPath, 'new-stage');
        },
        validate: async (path) => {
          expect(await readFile(path, 'utf8')).toBe('new-stage');
        },
      },
    });
    await replacement.stage({
      importId: '50000000-0000-4000-8000-000000000001',
      package: packageData,
      destinationPath,
      replaceExisting: true,
    });
    expect(await readFile(destinationPath, 'utf8')).toBe('new-stage');
    expect(await readdir(directory)).toEqual([
      'import-50000000-0000-4000-8000-000000000001.sqlite3',
    ]);
  });

  it('never reports success when staged-file or rename-directory durability fails', async () => {
    const packageData = parsePortablePackage(createPackage());
    const fileDirectory = await mkdtemp(join(tmpdir(), 'workbench-import-file-sync-'));
    directories.push(fileDirectory);
    const fileDestination = join(
      fileDirectory,
      'import-60000000-0000-4000-8000-000000000001.sqlite3',
    );
    const fileStager = new AtomicImportStager({
      directory: fileDirectory,
      idFactory: () => '60000000-0000-4000-8000-000000000002',
      driver: {
        build: async (_packageData, temporaryPath) => writeFile(temporaryPath, 'stage'),
        validate: async () => undefined,
      },
      durability: {
        syncFile: async () => {
          throw new Error('file sync failed');
        },
        syncDirectory: async () => undefined,
      },
    });
    await expect(
      fileStager.stage({
        importId: '60000000-0000-4000-8000-000000000001',
        package: packageData,
        destinationPath: fileDestination,
      }),
    ).rejects.toThrow(/file sync failed/u);
    expect(await readdir(fileDirectory)).toEqual([]);

    const directoryDirectory = await mkdtemp(join(tmpdir(), 'workbench-import-directory-sync-'));
    directories.push(directoryDirectory);
    const directoryDestination = join(
      directoryDirectory,
      'import-60000000-0000-4000-8000-000000000003.sqlite3',
    );
    let directorySyncCalls = 0;
    const directoryStager = new AtomicImportStager({
      directory: directoryDirectory,
      idFactory: () => '60000000-0000-4000-8000-000000000004',
      driver: {
        build: async (_packageData, temporaryPath) => writeFile(temporaryPath, 'stage'),
        validate: async () => undefined,
      },
      durability: {
        syncFile: async () => undefined,
        syncDirectory: async () => {
          directorySyncCalls += 1;
          if (directorySyncCalls === 1) throw new Error('directory sync failed');
        },
      },
    });
    await expect(
      directoryStager.stage({
        importId: '60000000-0000-4000-8000-000000000003',
        package: packageData,
        destinationPath: directoryDestination,
      }),
    ).rejects.toThrow(/directory sync failed/u);
    expect(directorySyncCalls).toBe(2);
    expect(await readdir(directoryDirectory)).toEqual([]);
  });
});

function createPackage(): Buffer {
  return serializePortablePackage({
    exportId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    exportedAt: '2026-07-22T11:00:00.000Z',
    sourceAppVersion: '0.1.0',
    sourceSchemaVersion: 7,
    records: [
      {
        type: 'app-state',
        data: { currentWorkspaceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
      },
      {
        type: 'workspace',
        data: {
          id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          name: '主工作区',
          archivedAt: null,
        },
      },
    ],
  });
}
