import { describe, expect, it } from 'vitest';
import {
  recoveryActionFor,
  ReplacementMarkerStore,
  type DatabaseReplacementMarker,
  type ReplacementMarkerPersistence,
} from '../src/main/data-portability/replacement-marker';

class MemoryPersistence implements ReplacementMarkerPersistence {
  value: DatabaseReplacementMarker | undefined;

  async read(): Promise<unknown | undefined> {
    return this.value;
  }

  async write(marker: DatabaseReplacementMarker): Promise<void> {
    this.value = { ...marker };
  }

  async remove(): Promise<void> {
    this.value = undefined;
  }
}

describe('database replacement marker', () => {
  it('allows only the crash-recoverable forward state sequence', async () => {
    const persistence = new MemoryPersistence();
    const store = new ReplacementMarkerStore(persistence);
    const marker = await store.create({
      replacementId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      timestamp: '2026-07-22T12:00:00.000Z',
      databaseFileName: 'daily-workbench.sqlite3',
      stagingFileName: 'import-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.sqlite3',
      rollbackFileName: 'rollback-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.sqlite3',
      stagingSha256: 'a'.repeat(64),
      preImportBackupId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    });
    expect(recoveryActionFor(marker)).toBe('move-old-database');
    const moved = await store.transition('ready', 'old-moved', '2026-07-22T12:00:01.000Z');
    expect(recoveryActionFor(moved)).toBe('install-staged-database');
    await expect(
      store.transition('old-moved', 'committed', '2026-07-22T12:00:02.000Z'),
    ).rejects.toThrow(/cannot move/u);

    await store.transition('old-moved', 'new-installed', '2026-07-22T12:00:02.000Z');
    await store.transition('new-installed', 'validated', '2026-07-22T12:00:03.000Z');
    await store.transition('validated', 'committed', '2026-07-22T12:00:04.000Z');
    await store.removeTerminal();
    expect(await store.read()).toBeUndefined();
  });

  it('supports explicit rollback after an interrupted install', async () => {
    const persistence = new MemoryPersistence();
    const store = new ReplacementMarkerStore(persistence);
    await store.create({
      replacementId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      timestamp: '2026-07-22T12:00:00.000Z',
      databaseFileName: 'daily-workbench.sqlite3',
      stagingFileName: 'import-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.sqlite3',
      rollbackFileName: 'rollback-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.sqlite3',
      stagingSha256: 'b'.repeat(64),
      preImportBackupId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    });
    await store.transition('ready', 'old-moved', '2026-07-22T12:00:01.000Z');
    const rollingBack = await store.transition(
      'old-moved',
      'rolling-back',
      '2026-07-22T12:00:02.000Z',
    );
    expect(recoveryActionFor(rollingBack)).toBe('restore-old-database');
    await store.transition('rolling-back', 'rolled-back', '2026-07-22T12:00:03.000Z');
    await store.removeTerminal();
  });

  it('clamps recovery timestamps when the wall clock moves backwards', async () => {
    const persistence = new MemoryPersistence();
    const store = new ReplacementMarkerStore(persistence);
    await store.create({
      replacementId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      timestamp: '2026-07-22T12:00:00.000Z',
      databaseFileName: 'daily-workbench.sqlite3',
      stagingFileName: 'import-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.sqlite3',
      rollbackFileName: 'rollback-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.sqlite3',
      stagingSha256: 'c'.repeat(64),
      preImportBackupId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    });

    await expect(
      store.transition('ready', 'old-moved', '2026-07-21T12:00:00.000Z'),
    ).resolves.toMatchObject({
      phase: 'old-moved',
      updatedAt: '2026-07-22T12:00:00.000Z',
    });
  });
});
