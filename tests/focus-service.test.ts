import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseService } from '../src/main/database/database-service';
import { DEFAULT_MIGRATIONS } from '../src/main/database/default-migrations';
import { MigrationRunner } from '../src/main/database/migration-runner';
import {
  configureDesktopPragmas,
  createNodeSqliteAdapter,
  type SqliteAdapter,
} from '../src/main/database/sqlite-adapter';
import {
  FocusConflictError,
  FocusNotFoundError,
  FocusRepository,
  FocusService,
  FocusValidationError,
} from '../src/main/focus';
import { WORKSPACE_COLORS } from '../src/shared/contracts';

const WORKSPACE_A = '11111111-1111-4111-8111-111111111111';
const WORKSPACE_B = '22222222-2222-4222-8222-222222222222';
const TASK_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SESSION_A = '33333333-3333-4333-8333-333333333333';
const SESSION_B = '44444444-4444-4444-8444-444444444444';
const TODAY = '2026-07-23';
const T0 = '2026-07-23T08:00:00.000Z';
const temporaryDirectories: string[] = [];
const openServices: DatabaseService[] = [];
const openDatabases: SqliteAdapter[] = [];

afterEach(async () => {
  await Promise.allSettled(openServices.splice(0).map((service) => service.close()));
  for (const database of openDatabases.splice(0)) database.close();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) =>
        rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }),
      ),
  );
});

describe('focus service', () => {
  it('runs one global session through pause, resume, and deadline completion', async () => {
    const context = await createService();
    const { service } = context;
    await service.createTask({
      workspaceId: WORKSPACE_A,
      title: '完成今日重点',
      planning: 'today',
    });
    await service.createWorkspace({ name: '空间 B', color: WORKSPACE_COLORS[1] });

    const started = await service.startFocusSession({
      workspaceId: WORKSPACE_A,
      taskId: TASK_A,
    });
    expect(started).toEqual({
      workspaceId: WORKSPACE_A,
      todayDate: TODAY,
      observedAt: T0,
      session: {
        id: SESSION_A,
        workspaceId: WORKSPACE_A,
        workspaceName: '我的工作台',
        taskId: TASK_A,
        taskTitle: '完成今日重点',
        status: 'running',
        remainingSeconds: 1_500,
        deadlineAt: '2026-07-23T08:25:00.000Z',
        revision: 1,
        createdAt: T0,
        updatedAt: T0,
      },
      todayCompletedCount: 0,
    });
    await expect(service.getFocusSnapshot({ workspaceId: WORKSPACE_B })).resolves.toMatchObject({
      workspaceId: WORKSPACE_B,
      session: { id: SESSION_A, workspaceId: WORKSPACE_A, status: 'running' },
      todayCompletedCount: 0,
    });
    await expect(service.startFocusSession({ workspaceId: WORKSPACE_B })).rejects.toBeInstanceOf(
      FocusConflictError,
    );

    context.setNow('2026-07-23T08:05:00.000Z');
    const paused = await service.pauseFocusSession({
      workspaceId: WORKSPACE_A,
      sessionId: SESSION_A,
      expectedRevision: 1,
    });
    expect(paused.session).toMatchObject({
      status: 'paused',
      remainingSeconds: 1_200,
      deadlineAt: null,
      revision: 2,
      updatedAt: '2026-07-23T08:05:00.000Z',
    });
    await expect(
      service.resumeFocusSession({
        workspaceId: WORKSPACE_A,
        sessionId: SESSION_A,
        expectedRevision: 1,
      }),
    ).rejects.toBeInstanceOf(FocusConflictError);

    const resumed = await service.resumeFocusSession({
      workspaceId: WORKSPACE_A,
      sessionId: SESSION_A,
      expectedRevision: 2,
    });
    expect(resumed.session).toMatchObject({
      status: 'running',
      remainingSeconds: 1_200,
      deadlineAt: '2026-07-23T08:25:00.000Z',
      revision: 3,
    });

    context.setNow('2026-07-23T08:25:00.000Z');
    await expect(service.getFocusSnapshot({ workspaceId: WORKSPACE_A })).resolves.toMatchObject({
      session: null,
      todayCompletedCount: 1,
      observedAt: '2026-07-23T08:25:00.000Z',
    });
    expect(readFocusRow(context.dataDirectory, SESSION_A)).toMatchObject({
      local_date: TODAY,
      state: 'completed',
      remaining_seconds: 0,
      deadline_at: null,
      revision: 4,
      completed_at: '2026-07-23T08:25:00.000Z',
    });
  });

  it('requires an active workspace and an unfinished task planned for Main today', async () => {
    const context = await createService();
    const { service } = context;
    await service.createTask({
      workspaceId: WORKSPACE_A,
      title: '暂不安排',
      planning: 'none',
    });
    await expect(
      service.startFocusSession({ workspaceId: WORKSPACE_A, taskId: TASK_A }),
    ).rejects.toBeInstanceOf(FocusConflictError);

    await service.updateTaskPlanning({
      workspaceId: WORKSPACE_A,
      taskId: TASK_A,
      planning: 'today',
    });
    await service.updateTaskStatus({
      workspaceId: WORKSPACE_A,
      taskId: TASK_A,
      status: 'completed',
    });
    await expect(
      service.startFocusSession({ workspaceId: WORKSPACE_A, taskId: TASK_A }),
    ).rejects.toBeInstanceOf(FocusConflictError);

    await service.createWorkspace({ name: '空间 B', color: WORKSPACE_COLORS[1] });
    await expect(
      service.startFocusSession({ workspaceId: WORKSPACE_B, taskId: TASK_A }),
    ).rejects.toBeInstanceOf(FocusConflictError);
    await service.archiveWorkspace({ workspaceId: WORKSPACE_B });
    await expect(service.startFocusSession({ workspaceId: WORKSPACE_B })).rejects.toBeInstanceOf(
      FocusNotFoundError,
    );
    expect(() => service.startFocusSession({ workspaceId: 'not-a-workspace' })).toThrow(
      FocusValidationError,
    );

    await expect(service.startFocusSession({ workspaceId: WORKSPACE_A })).resolves.toMatchObject({
      session: { taskId: null, taskTitle: null, status: 'running' },
    });
  });

  it('uses exact revisions and preserves cancelled sessions as terminal history', async () => {
    const context = await createService();
    const { service } = context;
    await service.startFocusSession({ workspaceId: WORKSPACE_A });
    context.setNow('2026-07-23T08:00:10.000Z');
    await service.pauseFocusSession({
      workspaceId: WORKSPACE_A,
      sessionId: SESSION_A,
      expectedRevision: 1,
    });
    await expect(
      service.cancelFocusSession({
        workspaceId: WORKSPACE_A,
        sessionId: SESSION_A,
        expectedRevision: 1,
      }),
    ).rejects.toBeInstanceOf(FocusConflictError);
    await service.resumeFocusSession({
      workspaceId: WORKSPACE_A,
      sessionId: SESSION_A,
      expectedRevision: 2,
    });
    context.setNow('2026-07-23T08:00:20.000Z');
    const cancelled = await service.cancelFocusSession({
      workspaceId: WORKSPACE_A,
      sessionId: SESSION_A,
      expectedRevision: 3,
    });
    expect(cancelled).toMatchObject({ session: null, todayCompletedCount: 0 });
    expect(readFocusRow(context.dataDirectory, SESSION_A)).toMatchObject({
      state: 'cancelled',
      remaining_seconds: 1_480,
      deadline_at: null,
      revision: 4,
      completed_at: null,
      cancelled_at: '2026-07-23T08:00:20.000Z',
    });
    await expect(
      service.cancelFocusSession({
        workspaceId: WORKSPACE_A,
        sessionId: SESSION_A,
        expectedRevision: 4,
      }),
    ).rejects.toBeInstanceOf(FocusConflictError);
  });

  it('atomically pauses a running session on shutdown and is idempotent once paused', async () => {
    const context = await createService();
    const { service } = context;
    await service.startFocusSession({ workspaceId: WORKSPACE_A });
    context.setNow('2026-07-23T08:01:00.000Z');

    await expect(service.pauseRunningFocusSession()).resolves.toMatchObject({
      changed: true,
      changedWorkspaceId: WORKSPACE_A,
      session: {
        id: SESSION_A,
        status: 'paused',
        remainingSeconds: 1_440,
        revision: 2,
      },
    });
    await expect(service.pauseRunningFocusSession()).resolves.toMatchObject({
      changed: false,
      changedWorkspaceId: null,
      session: { id: SESSION_A, status: 'paused', revision: 2 },
    });
  });

  it('starts from the wall clock without stalling behind a future logical workspace timestamp', async () => {
    const database = await createDirectDatabase();
    insertDirectWorkspace(database);
    database.run(`UPDATE workspaces SET updated_at = ? WHERE id = ?`, [
      '2026-07-23T08:10:00.000Z',
      WORKSPACE_A,
    ]);
    const service = new FocusService({
      execute: async (operation) => operation(database),
      now: () => new Date('2026-07-23T07:00:00.000Z'),
      todayFactory: () => TODAY,
      idFactory: () => SESSION_A,
      monotonicNowMs: () => 0,
    });

    await expect(service.start({ workspaceId: WORKSPACE_A })).resolves.toMatchObject({
      observedAt: '2026-07-23T07:00:00.000Z',
      session: {
        status: 'running',
        remainingSeconds: 1_500,
        deadlineAt: '2026-07-23T07:25:00.000Z',
        revision: 1,
        createdAt: '2026-07-23T08:10:00.000Z',
        updatedAt: '2026-07-23T08:10:00.000Z',
      },
    });
    expect(() => new FocusRepository(database).validateSnapshot()).not.toThrow();
  });

  it('checkpoints monotonic elapsed time without increasing or extending after wall-clock rollback', async () => {
    const database = await createDirectDatabase();
    insertDirectWorkspace(database);
    let wallNow = new Date(T0);
    let monotonicNowMs = 0;
    const service = new FocusService({
      execute: async (operation) => operation(database),
      now: () => new Date(wallNow),
      todayFactory: () => TODAY,
      idFactory: () => SESSION_A,
      monotonicNowMs: () => monotonicNowMs,
    });

    const started = await service.start({ workspaceId: WORKSPACE_A });
    expect(started.session).toMatchObject({
      status: 'running',
      remainingSeconds: 1_500,
      deadlineAt: '2026-07-23T08:25:00.000Z',
      revision: 1,
    });

    wallNow = new Date('2026-07-23T08:10:00.000Z');
    monotonicNowMs = 600_000;
    await expect(service.reconcileOpenSession()).resolves.toMatchObject({
      changed: true,
      session: {
        remainingSeconds: 900,
        deadlineAt: '2026-07-23T08:25:00.000Z',
        revision: 2,
      },
    });

    wallNow = new Date('2026-07-23T07:00:00.000Z');
    monotonicNowMs = 660_000;
    await expect(service.reconcileOpenSession()).resolves.toMatchObject({
      changed: true,
      session: {
        remainingSeconds: 840,
        deadlineAt: '2026-07-23T08:25:00.000Z',
        revision: 3,
      },
    });

    const paused = await service.pause({
      workspaceId: WORKSPACE_A,
      sessionId: SESSION_A,
      expectedRevision: 3,
    });
    expect(paused).toMatchObject({
      observedAt: '2026-07-23T07:00:00.000Z',
      session: {
        status: 'paused',
        remainingSeconds: 840,
        deadlineAt: null,
        revision: 4,
        updatedAt: '2026-07-23T08:10:00.000Z',
      },
    });

    const resumed = await service.resume({
      workspaceId: WORKSPACE_A,
      sessionId: SESSION_A,
      expectedRevision: 4,
    });
    expect(resumed).toMatchObject({
      observedAt: '2026-07-23T07:00:00.000Z',
      session: {
        status: 'running',
        remainingSeconds: 840,
        deadlineAt: '2026-07-23T07:14:00.000Z',
        revision: 5,
        updatedAt: '2026-07-23T08:10:00.000Z',
      },
    });
    expect(() => new FocusRepository(database).validateSnapshot()).not.toThrow();

    monotonicNowMs = 1_500_000;
    await expect(service.reconcileOpenSession()).resolves.toEqual({
      changed: true,
      changedWorkspaceId: WORKSPACE_A,
      session: null,
    });
    expect(
      database.get<Record<string, unknown>>(
        `SELECT state, remaining_seconds, deadline_at, revision
         FROM focus_sessions WHERE id = ?`,
        [SESSION_A],
      ),
    ).toEqual({
      state: 'completed',
      remaining_seconds: 0,
      deadline_at: null,
      revision: 6,
    });
  });
});

interface ServiceContext {
  readonly service: DatabaseService;
  readonly dataDirectory: string;
  setNow(value: string): void;
}

async function createService(): Promise<ServiceContext> {
  const root = await mkdtemp(join(tmpdir(), 'daily-workbench-focus-service-'));
  temporaryDirectories.push(root);
  const dataDirectory = join(root, 'data');
  let now = new Date(T0);
  const workspaceIds = [WORKSPACE_A, WORKSPACE_B];
  const sessionIds = [SESSION_A, SESSION_B];
  const service = new DatabaseService({
    dataDirectory,
    now: () => new Date(now),
    workspaceIdFactory: () => workspaceIds.shift() ?? WORKSPACE_B,
    taskIdFactory: () => TASK_A,
    taskTodayFactory: () => TODAY,
    focusIdFactory: () => sessionIds.shift() ?? SESSION_B,
    focusTodayFactory: () => TODAY,
  });
  openServices.push(service);
  await service.open();
  return {
    service,
    dataDirectory,
    setNow(value) {
      now = new Date(value);
    },
  };
}

function readFocusRow(dataDirectory: string, sessionId: string): Record<string, unknown> {
  const database = new DatabaseSync(join(dataDirectory, 'daily-workbench.sqlite3'), {
    readOnly: true,
  });
  try {
    return database
      .prepare(
        `SELECT local_date, state, remaining_seconds, deadline_at, revision,
                completed_at, cancelled_at
         FROM focus_sessions WHERE id = ?`,
      )
      .get(sessionId) as Record<string, unknown>;
  } finally {
    database.close();
  }
}

async function createDirectDatabase(): Promise<SqliteAdapter> {
  const root = await mkdtemp(join(tmpdir(), 'daily-workbench-focus-clock-'));
  temporaryDirectories.push(root);
  const database = createNodeSqliteAdapter(join(root, 'clock.sqlite3'));
  database.open();
  configureDesktopPragmas(database);
  new MigrationRunner(DEFAULT_MIGRATIONS).apply(database);
  openDatabases.push(database);
  return database;
}

function insertDirectWorkspace(database: SqliteAdapter): void {
  database.run(
    `INSERT INTO workspaces (
       id, name, name_key, color, created_at, updated_at, archived_at
     ) VALUES (?, '回拨工作区', '回拨工作区', '#7b6ee8', ?, ?, NULL)`,
    [WORKSPACE_A, T0, T0],
  );
}
