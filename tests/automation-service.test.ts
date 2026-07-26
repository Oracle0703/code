import { mkdtemp, rm } from 'node:fs/promises';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AutomationConflictError,
  AutomationLimitError,
  AutomationNotFoundError,
  AutomationOperationError,
} from '../src/main/automations/automation-errors';
import { DatabaseService } from '../src/main/database/database-service';
import { DatabaseIntegrityError, DatabaseStateError } from '../src/main/database/errors';
import { createNodeSqliteAdapter, type SqliteAdapter } from '../src/main/database/sqlite-adapter';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const AUTOMATION_ID = '22222222-2222-4222-8222-222222222222';
const TASK_ID = '33333333-3333-4333-8333-333333333333';
const NOTE_AUTOMATION_ID = '44444444-4444-4444-8444-444444444444';
const NOTE_ID = '55555555-5555-4555-8555-555555555555';
const FAILED_AUTOMATION_ID = '66666666-6666-4666-8666-666666666666';
const WORKSPACE_B_ID = '77777777-7777-4777-8777-777777777777';
const WORKSPACE_B_AUTOMATION_ID = '88888888-8888-4888-8888-888888888888';
const SECOND_TASK_ID = '99999999-9999-4999-8999-999999999999';
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

describe('AutomationService through DatabaseService', () => {
  it('runs disabled task and note definitions without changing schedule state or ledgers', async () => {
    const automationIds = [AUTOMATION_ID, NOTE_AUTOMATION_ID];
    const { service, dataDirectory } = await createServiceContext({
      now: () => new Date(2026, 6, 23, 8, 15, 0),
      automationIdFactory: () => automationIds.shift()!,
      automationTaskIdFactory: () => TASK_ID,
      automationNoteIdFactory: () => NOTE_ID,
    });
    await service.createAutomation({
      workspaceId: WORKSPACE_ID,
      name: '按需巡检',
      schedule: { cadence: 'daily', localTimeMinute: 510, weekday: null },
      action: { kind: 'create-today-task', title: '检查本机备份' },
    });
    await service.createAutomation({
      workspaceId: WORKSPACE_ID,
      name: '按需回顾',
      schedule: { cadence: 'weekly', localTimeMinute: 1_050, weekday: 5 },
      action: { kind: 'create-note', title: '本周回顾', body: '## 完成\n' },
    });
    const before = readAutomationPersistenceState(dataDirectory);

    await expect(
      service.runAutomationNow({
        workspaceId: WORKSPACE_ID,
        automationId: AUTOMATION_ID,
        expectedRevision: 1,
      }),
    ).resolves.toEqual({
      workspaceId: WORKSPACE_ID,
      automationId: AUTOMATION_ID,
      outputKind: 'task',
      outputId: TASK_ID,
    });
    await expect(
      service.runAutomationNow({
        workspaceId: WORKSPACE_ID,
        automationId: NOTE_AUTOMATION_ID,
        expectedRevision: 1,
      }),
    ).resolves.toEqual({
      workspaceId: WORKSPACE_ID,
      automationId: NOTE_AUTOMATION_ID,
      outputKind: 'note',
      outputId: NOTE_ID,
    });

    expect((await service.getTaskSnapshot({ workspaceId: WORKSPACE_ID })).tasks).toEqual([
      expect.objectContaining({
        id: TASK_ID,
        title: '检查本机备份',
        plannedFor: '2026-07-23',
      }),
    ]);
    expect((await service.getNoteSnapshot({ workspaceId: WORKSPACE_ID })).notes).toEqual([
      expect.objectContaining({
        id: NOTE_ID,
        title: '本周回顾',
        body: '## 完成\n',
      }),
    ]);
    expect(readAutomationPersistenceState(dataDirectory)).toEqual(before);
    const snapshot = await service.getAutomationSnapshot({ workspaceId: WORKSPACE_ID });
    expect(snapshot.items).toHaveLength(2);
    expect(snapshot.items.find(({ id }) => id === AUTOMATION_ID)).toMatchObject({
      enabled: false,
      revision: 1,
      nextRunAt: null,
      lastRun: { status: 'never' },
    });
    expect(snapshot.items.find(({ id }) => id === NOTE_AUTOMATION_ID)).toMatchObject({
      enabled: false,
      revision: 1,
      nextRunAt: null,
      lastRun: { status: 'never' },
    });
    await service.close();
  });

  it('rejects stale, archived-definition, and archived-workspace manual runs without output', async () => {
    const workspaceIds = [WORKSPACE_ID, WORKSPACE_B_ID];
    const automationIds = [AUTOMATION_ID, WORKSPACE_B_AUTOMATION_ID];
    const service = await createService({
      now: () => new Date(2026, 6, 23, 8, 0, 0),
      workspaceIdFactory: () => workspaceIds.shift()!,
      automationIdFactory: () => automationIds.shift()!,
      automationTaskIdFactory: () => TASK_ID,
    });
    await service.createAutomation({
      workspaceId: WORKSPACE_ID,
      name: '版本绑定',
      schedule: { cadence: 'daily', localTimeMinute: 510, weekday: null },
      action: { kind: 'create-today-task', title: '不会由旧版本创建' },
    });
    await service.updateAutomation({
      workspaceId: WORKSPACE_ID,
      automationId: AUTOMATION_ID,
      expectedRevision: 1,
      name: '版本绑定（新）',
      schedule: { cadence: 'daily', localTimeMinute: 510, weekday: null },
      action: { kind: 'create-today-task', title: '只接受新版本' },
    });
    await expect(
      service.runAutomationNow({
        workspaceId: WORKSPACE_ID,
        automationId: AUTOMATION_ID,
        expectedRevision: 1,
      }),
    ).rejects.toBeInstanceOf(AutomationConflictError);
    await service.archiveAutomation({
      workspaceId: WORKSPACE_ID,
      automationId: AUTOMATION_ID,
      expectedRevision: 2,
    });
    await expect(
      service.runAutomationNow({
        workspaceId: WORKSPACE_ID,
        automationId: AUTOMATION_ID,
        expectedRevision: 3,
      }),
    ).rejects.toBeInstanceOf(AutomationNotFoundError);

    await service.createWorkspace({ name: '即将归档', color: '#348bd4' });
    await service.createAutomation({
      workspaceId: WORKSPACE_B_ID,
      name: '归档空间规则',
      schedule: { cadence: 'daily', localTimeMinute: 510, weekday: null },
      action: { kind: 'create-today-task', title: '归档后不可创建' },
    });
    await expect(
      service.runAutomationNow({
        workspaceId: WORKSPACE_ID,
        automationId: WORKSPACE_B_AUTOMATION_ID,
        expectedRevision: 1,
      }),
    ).rejects.toBeInstanceOf(AutomationNotFoundError);
    await service.archiveWorkspace({ workspaceId: WORKSPACE_B_ID });
    await expect(
      service.runAutomationNow({
        workspaceId: WORKSPACE_B_ID,
        automationId: WORKSPACE_B_AUTOMATION_ID,
        expectedRevision: 1,
      }),
    ).rejects.toBeInstanceOf(AutomationNotFoundError);
    expect((await service.getTaskSnapshot({ workspaceId: WORKSPACE_ID })).tasks).toEqual([]);
    await service.close();
  });

  it('keeps a manual run independent from an adjacent scheduled occurrence', async () => {
    let now = new Date(2026, 6, 23, 8, 0, 0);
    const outputIds = [TASK_ID, SECOND_TASK_ID];
    const { service, dataDirectory } = await createServiceContext({
      now: () => now,
      automationIdFactory: () => AUTOMATION_ID,
      automationTaskIdFactory: () => outputIds.shift()!,
    });
    await service.createAutomation({
      workspaceId: WORKSPACE_ID,
      name: '手动与计划独立',
      schedule: { cadence: 'daily', localTimeMinute: 510, weekday: null },
      action: { kind: 'create-today-task', title: '检查今日计划' },
    });
    const enabled = await service.setAutomationEnabled({
      workspaceId: WORKSPACE_ID,
      automationId: AUTOMATION_ID,
      expectedRevision: 1,
      enabled: true,
    });
    const beforeManual = readAutomationPersistenceState(dataDirectory);
    const nextRunAt = enabled.items[0]?.nextRunAt;
    now = new Date(2026, 6, 23, 8, 29, 0);

    await expect(
      service.runAutomationNow({
        workspaceId: WORKSPACE_ID,
        automationId: AUTOMATION_ID,
        expectedRevision: 2,
      }),
    ).resolves.toMatchObject({ outputKind: 'task', outputId: TASK_ID });
    expect(readAutomationPersistenceState(dataDirectory)).toEqual(beforeManual);
    expect(
      (await service.getAutomationSnapshot({ workspaceId: WORKSPACE_ID })).items[0],
    ).toMatchObject({
      revision: 2,
      nextRunAt,
      lastRun: { status: 'never' },
    });

    now = new Date(2026, 6, 23, 9, 0, 0);
    const input = {
      automationId: AUTOMATION_ID,
      expectedRevision: 2,
      occurrenceDate: '2026-07-23',
      scheduledFor: new Date(2026, 6, 23, 8, 30, 0).toISOString(),
    };
    await expect(service.runAutomationOccurrence(input)).resolves.toMatchObject({
      status: 'success',
      outputKind: 'task',
    });
    await expect(service.runAutomationOccurrence(input)).resolves.toMatchObject({
      status: 'skipped',
    });
    expect(
      new Set(
        (await service.getTaskSnapshot({ workspaceId: WORKSPACE_ID })).tasks.map(({ id }) => id),
      ),
    ).toEqual(new Set([TASK_ID, SECOND_TASK_ID]));
    const afterSchedule = readAutomationPersistenceState(dataDirectory);
    expect(afterSchedule.occurrences).toHaveLength(1);
    expect(afterSchedule.runState).not.toEqual(beforeManual.runState);
    await service.close();
  });

  it('creates disabled definitions and atomically deduplicates a generated Today task', async () => {
    let now = new Date(2026, 6, 23, 8, 0, 0);
    const service = await createService({
      now: () => now,
      automationIdFactory: () => AUTOMATION_ID,
      automationTaskIdFactory: () => TASK_ID,
    });
    const created = await service.createAutomation({
      workspaceId: WORKSPACE_ID,
      name: '每日计划',
      schedule: { cadence: 'daily', localTimeMinute: 8 * 60 + 30, weekday: null },
      action: { kind: 'create-today-task', title: '检查今日计划' },
    });
    expect(created.createdAutomationId).toBe(AUTOMATION_ID);
    expect(created.automationSnapshot.items[0]).toMatchObject({
      id: AUTOMATION_ID,
      enabled: false,
      revision: 1,
      nextRunAt: null,
      lastRun: { status: 'never' },
    });
    await service.setAutomationEnabled({
      workspaceId: WORKSPACE_ID,
      automationId: AUTOMATION_ID,
      expectedRevision: 1,
      enabled: true,
    });

    now = new Date(2026, 6, 23, 9, 0, 0);
    const scheduledFor = new Date(2026, 6, 23, 8, 30, 0).toISOString();
    await expect(
      service.runAutomationOccurrence({
        automationId: AUTOMATION_ID,
        expectedRevision: 2,
        occurrenceDate: '2026-07-23',
        scheduledFor,
      }),
    ).resolves.toEqual({
      status: 'success',
      workspaceId: WORKSPACE_ID,
      outputKind: 'task',
    });
    await expect(
      service.runAutomationOccurrence({
        automationId: AUTOMATION_ID,
        expectedRevision: 2,
        occurrenceDate: '2026-07-23',
        scheduledFor,
      }),
    ).resolves.toMatchObject({ status: 'skipped' });
    expect((await service.getTaskSnapshot({ workspaceId: WORKSPACE_ID })).tasks).toEqual([
      expect.objectContaining({
        id: TASK_ID,
        title: '检查今日计划',
        plannedFor: '2026-07-23',
      }),
    ]);
    expect(
      (await service.getAutomationSnapshot({ workspaceId: WORKSPACE_ID })).items[0]?.lastRun,
    ).toMatchObject({ status: 'success', outputKind: 'task' });
    await service.close();
  });

  it('returns the exact inserted identities when automation names are duplicated', async () => {
    const automationIds = [AUTOMATION_ID, NOTE_AUTOMATION_ID];
    const service = await createService({
      now: () => new Date(2026, 6, 23, 8, 0, 0),
      automationIdFactory: () => automationIds.shift()!,
    });
    const input = {
      workspaceId: WORKSPACE_ID,
      name: '重复名称',
      schedule: { cadence: 'daily' as const, localTimeMinute: 510, weekday: null },
      action: { kind: 'create-today-task' as const, title: '同名定义的动作' },
    };

    const first = await service.createAutomation(input);
    const second = await service.createAutomation(input);

    expect(first.createdAutomationId).toBe(AUTOMATION_ID);
    expect(first.automationSnapshot.items).toEqual([
      expect.objectContaining({ id: AUTOMATION_ID, name: input.name }),
    ]);
    expect(second.createdAutomationId).toBe(NOTE_AUTOMATION_ID);
    expect(
      new Set(
        second.automationSnapshot.items
          .filter(({ name }) => name === input.name)
          .map(({ id }) => id),
      ),
    ).toEqual(new Set([AUTOMATION_ID, NOTE_AUTOMATION_ID]));
    expect(
      second.automationSnapshot.items.find(({ id }) => id === second.createdAutomationId),
    ).toMatchObject({ id: NOTE_AUTOMATION_ID, name: input.name });
    await service.close();
  });

  it('creates a note output and persists failure backoff without an occurrence on action failure', async () => {
    let now = new Date(2026, 6, 23, 8, 0, 0);
    let taskOutputId = 'invalid-task-id';
    const ids = [NOTE_AUTOMATION_ID, FAILED_AUTOMATION_ID];
    const { service, dataDirectory } = await createServiceContext({
      now: () => now,
      automationIdFactory: () => ids.shift()!,
      automationNoteIdFactory: () => NOTE_ID,
      automationTaskIdFactory: () => taskOutputId,
    });
    await service.createAutomation({
      workspaceId: WORKSPACE_ID,
      name: '周报',
      schedule: { cadence: 'daily', localTimeMinute: 8 * 60 + 30, weekday: null },
      action: { kind: 'create-note', title: '今日记录', body: '## 完成' },
    });
    await service.setAutomationEnabled({
      workspaceId: WORKSPACE_ID,
      automationId: NOTE_AUTOMATION_ID,
      expectedRevision: 1,
      enabled: true,
    });
    await service.createAutomation({
      workspaceId: WORKSPACE_ID,
      name: '失败任务',
      schedule: { cadence: 'daily', localTimeMinute: 8 * 60 + 30, weekday: null },
      action: { kind: 'create-today-task', title: '不会半提交' },
    });
    await service.setAutomationEnabled({
      workspaceId: WORKSPACE_ID,
      automationId: FAILED_AUTOMATION_ID,
      expectedRevision: 1,
      enabled: true,
    });

    now = new Date(2026, 6, 23, 9, 0, 0);
    const runInput = {
      expectedRevision: 2,
      occurrenceDate: '2026-07-23',
      scheduledFor: new Date(2026, 6, 23, 8, 30, 0).toISOString(),
    };
    await expect(
      service.runAutomationOccurrence({
        automationId: NOTE_AUTOMATION_ID,
        ...runInput,
      }),
    ).resolves.toMatchObject({ status: 'success', outputKind: 'note' });
    await expect(
      service.runAutomationOccurrence({
        automationId: FAILED_AUTOMATION_ID,
        ...runInput,
      }),
    ).resolves.toMatchObject({ status: 'failed', errorCode: 'action-failed' });
    expect((await service.getNoteSnapshot({ workspaceId: WORKSPACE_ID })).notes).toEqual([
      expect.objectContaining({ id: NOTE_ID, title: '今日记录', body: '## 完成' }),
    ]);
    expect((await service.getTaskSnapshot({ workspaceId: WORKSPACE_ID })).tasks).toEqual([]);
    const failed = (await service.getAutomationSnapshot({ workspaceId: WORKSPACE_ID })).items.find(
      ({ id }) => id === FAILED_AUTOMATION_ID,
    );
    expect(failed?.lastRun).toMatchObject({
      status: 'failed',
      errorCode: 'action-failed',
      consecutiveFailures: 1,
    });
    const failedPersistence = readAutomationPersistenceState(dataDirectory);
    taskOutputId = TASK_ID;
    await expect(
      service.runAutomationNow({
        workspaceId: WORKSPACE_ID,
        automationId: FAILED_AUTOMATION_ID,
        expectedRevision: 2,
      }),
    ).resolves.toMatchObject({ outputKind: 'task', outputId: TASK_ID });
    expect(readAutomationPersistenceState(dataDirectory)).toEqual(failedPersistence);
    expect(
      (await service.getAutomationSnapshot({ workspaceId: WORKSPACE_ID })).items.find(
        ({ id }) => id === FAILED_AUTOMATION_ID,
      )?.lastRun,
    ).toEqual(failed?.lastRun);
    await service.close();
  });

  it('enforces CRUD revisions, immutable action kinds, default disabled state, and limits', async () => {
    const service = await createService({
      now: () => new Date(2026, 6, 23, 8, 0, 0),
    });
    const createdIds: string[] = [];
    for (let index = 0; index < 100; index += 1) {
      const result = await service.createAutomation({
        workspaceId: WORKSPACE_ID,
        name: `自动化 ${index + 1}`,
        schedule: { cadence: 'daily', localTimeMinute: 510, weekday: null },
        action: { kind: 'create-today-task', title: `任务 ${index + 1}` },
      });
      const created = result.automationSnapshot.items.find(
        ({ id }) => id === result.createdAutomationId,
      );
      expect(created).toMatchObject({ enabled: false, revision: 1 });
      createdIds.push(created!.id);
    }
    await expect(
      service.createAutomation({
        workspaceId: WORKSPACE_ID,
        name: '超过全局上限',
        schedule: { cadence: 'daily', localTimeMinute: 510, weekday: null },
        action: { kind: 'create-today-task', title: '不会创建' },
      }),
    ).rejects.toBeInstanceOf(AutomationLimitError);

    for (const automationId of createdIds.slice(0, 25)) {
      await service.setAutomationEnabled({
        workspaceId: WORKSPACE_ID,
        automationId,
        expectedRevision: 1,
        enabled: true,
      });
    }
    await expect(
      service.setAutomationEnabled({
        workspaceId: WORKSPACE_ID,
        automationId: createdIds[25],
        expectedRevision: 1,
        enabled: true,
      }),
    ).rejects.toBeInstanceOf(AutomationLimitError);

    await expect(
      service.updateAutomation({
        workspaceId: WORKSPACE_ID,
        automationId: createdIds[0],
        expectedRevision: 1,
        name: '迟到更新',
        schedule: { cadence: 'daily', localTimeMinute: 510, weekday: null },
        action: { kind: 'create-today-task', title: '迟到' },
      }),
    ).rejects.toBeInstanceOf(AutomationConflictError);
    await expect(
      service.updateAutomation({
        workspaceId: WORKSPACE_ID,
        automationId: createdIds[0],
        expectedRevision: 2,
        name: '不允许换动作',
        schedule: { cadence: 'daily', localTimeMinute: 510, weekday: null },
        action: { kind: 'create-note', title: '笔记', body: '' },
      }),
    ).rejects.toBeInstanceOf(AutomationConflictError);
    await service.close();
  });

  it('skips a stale definition revision and commits only one output under concurrent runs', async () => {
    let now = new Date(2026, 6, 23, 8, 0, 0);
    const service = await createService({
      now: () => now,
      automationIdFactory: () => AUTOMATION_ID,
      automationTaskIdFactory: () => TASK_ID,
    });
    await service.createAutomation({
      workspaceId: WORKSPACE_ID,
      name: '版本绑定',
      schedule: { cadence: 'daily', localTimeMinute: 510, weekday: null },
      action: { kind: 'create-today-task', title: '原任务' },
    });
    await service.setAutomationEnabled({
      workspaceId: WORKSPACE_ID,
      automationId: AUTOMATION_ID,
      expectedRevision: 1,
      enabled: true,
    });
    now = new Date(2026, 6, 23, 8, 10, 0);
    await service.updateAutomation({
      workspaceId: WORKSPACE_ID,
      automationId: AUTOMATION_ID,
      expectedRevision: 2,
      name: '版本绑定',
      schedule: { cadence: 'daily', localTimeMinute: 510, weekday: null },
      action: { kind: 'create-today-task', title: '新任务' },
    });
    now = new Date(2026, 6, 23, 9, 0, 0);
    const input = {
      automationId: AUTOMATION_ID,
      occurrenceDate: '2026-07-23',
      scheduledFor: new Date(2026, 6, 23, 8, 30, 0).toISOString(),
    };
    await expect(
      service.runAutomationOccurrence({ ...input, expectedRevision: 2 }),
    ).resolves.toMatchObject({ status: 'skipped' });

    const results = await Promise.all([
      service.runAutomationOccurrence({ ...input, expectedRevision: 3 }),
      service.runAutomationOccurrence({ ...input, expectedRevision: 3 }),
    ]);
    expect(results.map(({ status }) => status).sort()).toEqual(['skipped', 'success']);
    expect((await service.getTaskSnapshot({ workspaceId: WORKSPACE_ID })).tasks).toEqual([
      expect.objectContaining({ id: TASK_ID, title: '新任务' }),
    ]);
    await service.close();
  });

  it('honors persisted backoff and resets failure count for a newer occurrence', async () => {
    let now = new Date(2026, 6, 23, 8, 0, 0);
    const service = await createService({
      now: () => now,
      automationIdFactory: () => FAILED_AUTOMATION_ID,
      automationTaskIdFactory: () => 'invalid-task-id',
    });
    await service.createAutomation({
      workspaceId: WORKSPACE_ID,
      name: '退避任务',
      schedule: { cadence: 'daily', localTimeMinute: 510, weekday: null },
      action: { kind: 'create-today-task', title: '失败后退避' },
    });
    await service.setAutomationEnabled({
      workspaceId: WORKSPACE_ID,
      automationId: FAILED_AUTOMATION_ID,
      expectedRevision: 1,
      enabled: true,
    });
    now = new Date(2026, 6, 23, 9, 0, 0);
    const firstOccurrence = {
      automationId: FAILED_AUTOMATION_ID,
      expectedRevision: 2,
      occurrenceDate: '2026-07-23',
      scheduledFor: new Date(2026, 6, 23, 8, 30, 0).toISOString(),
    };
    await expect(service.runAutomationOccurrence(firstOccurrence)).resolves.toMatchObject({
      status: 'failed',
    });
    await expect(service.runAutomationOccurrence(firstOccurrence)).resolves.toMatchObject({
      status: 'skipped',
    });

    now = new Date(2026, 6, 23, 9, 6, 0);
    await expect(service.runAutomationOccurrence(firstOccurrence)).resolves.toMatchObject({
      status: 'failed',
    });
    expect(
      (await service.getAutomationSnapshot({ workspaceId: WORKSPACE_ID })).items[0]?.lastRun,
    ).toMatchObject({ status: 'failed', consecutiveFailures: 2 });

    now = new Date(2026, 6, 24, 9, 0, 0);
    await expect(
      service.runAutomationOccurrence({
        ...firstOccurrence,
        occurrenceDate: '2026-07-24',
        scheduledFor: new Date(2026, 6, 24, 8, 30, 0).toISOString(),
      }),
    ).resolves.toMatchObject({ status: 'failed' });
    expect(
      (await service.getAutomationSnapshot({ workspaceId: WORKSPACE_ID })).items[0]?.lastRun,
    ).toMatchObject({ status: 'failed', consecutiveFailures: 1 });
    await service.close();
  });

  it('clamps run-state timestamps and can succeed after a failed future clock is corrected', async () => {
    let now = new Date(2026, 6, 23, 8, 0, 0);
    let outputId = 'invalid-task-id';
    const service = await createService({
      now: () => now,
      automationIdFactory: () => FAILED_AUTOMATION_ID,
      automationTaskIdFactory: () => outputId,
    });
    await service.createAutomation({
      workspaceId: WORKSPACE_ID,
      name: '时钟修正',
      schedule: { cadence: 'daily', localTimeMinute: 510, weekday: null },
      action: { kind: 'create-today-task', title: '修正后继续' },
    });
    await service.setAutomationEnabled({
      workspaceId: WORKSPACE_ID,
      automationId: FAILED_AUTOMATION_ID,
      expectedRevision: 1,
      enabled: true,
    });
    now = new Date(2026, 6, 24, 9, 0, 0);
    await expect(
      service.runAutomationOccurrence({
        automationId: FAILED_AUTOMATION_ID,
        expectedRevision: 2,
        occurrenceDate: '2026-07-24',
        scheduledFor: new Date(2026, 6, 24, 8, 30, 0).toISOString(),
      }),
    ).resolves.toMatchObject({ status: 'failed' });

    now = new Date(2026, 6, 23, 9, 0, 0);
    outputId = TASK_ID;
    await expect(
      service.runAutomationOccurrence({
        automationId: FAILED_AUTOMATION_ID,
        expectedRevision: 2,
        occurrenceDate: '2026-07-23',
        scheduledFor: new Date(2026, 6, 23, 8, 30, 0).toISOString(),
      }),
    ).resolves.toMatchObject({ status: 'success' });
    expect(
      (await service.getAutomationSnapshot({ workspaceId: WORKSPACE_ID })).items[0]?.lastRun,
    ).toMatchObject({ status: 'success', outputKind: 'task' });
    await service.close();
  });

  it('preserves definitions, success state, immutable ledger, and output in a validated backup and reopen', async () => {
    let now = new Date(2026, 6, 23, 8, 0, 0);
    const { service, dataDirectory } = await createServiceContext({
      now: () => now,
      automationIdFactory: () => AUTOMATION_ID,
      automationTaskIdFactory: () => TASK_ID,
    });
    await service.createAutomation({
      workspaceId: WORKSPACE_ID,
      name: '备份自动化',
      schedule: { cadence: 'daily', localTimeMinute: 510, weekday: null },
      action: { kind: 'create-today-task', title: '进入备份' },
    });
    await service.setAutomationEnabled({
      workspaceId: WORKSPACE_ID,
      automationId: AUTOMATION_ID,
      expectedRevision: 1,
      enabled: true,
    });
    now = new Date(2026, 6, 23, 9, 0, 0);
    await service.runAutomationOccurrence({
      automationId: AUTOMATION_ID,
      expectedRevision: 2,
      occurrenceDate: '2026-07-23',
      scheduledFor: new Date(2026, 6, 23, 8, 30, 0).toISOString(),
    });
    const backup = await service.createBackup();
    await service.close();

    const snapshot = new DatabaseSync(join(dataDirectory, 'backups', backup.fileName), {
      readOnly: true,
    });
    try {
      expect(
        snapshot
          .prepare(
            `SELECT
               (SELECT COUNT(*) FROM automations) AS definitions,
               (SELECT COUNT(*) FROM automation_run_state WHERE last_success_at IS NOT NULL) AS successes,
               (SELECT COUNT(*) FROM automation_occurrences) AS occurrences,
               (SELECT COUNT(*) FROM tasks WHERE id = ?) AS outputs`,
          )
          .get(TASK_ID),
      ).toEqual({ definitions: 1, successes: 1, occurrences: 1, outputs: 1 });
    } finally {
      snapshot.close();
    }

    const reopened = new DatabaseService({ dataDirectory, now: () => now });
    await reopened.open();
    expect(
      (await reopened.getAutomationSnapshot({ workspaceId: WORKSPACE_ID })).items[0],
    ).toMatchObject({
      id: AUTOMATION_ID,
      lastRun: { status: 'success', outputKind: 'task' },
    });
    await reopened.close();
  });

  it.each([
    ['output', 'INSERT INTO tasks'],
    ['occurrence ledger', 'INSERT INTO automation_occurrences'],
    ['success state', 'UPDATE automation_run_state'],
  ])(
    'rolls back output, ledger, and state when %s persistence fails',
    async (_label, sqlNeedle) => {
      let now = new Date(2026, 6, 23, 8, 0, 0);
      let injectFailure = false;
      let failedOnce = false;
      const service = await createService({
        now: () => now,
        automationIdFactory: () => AUTOMATION_ID,
        automationTaskIdFactory: () => TASK_ID,
        adapterFactory: (path, options) => {
          const adapter = createNodeSqliteAdapter(path, options);
          return new Proxy(adapter, {
            get(target, property) {
              if (property === 'run') {
                return (
                  sql: string,
                  parameters?: readonly import('node:sqlite').SQLInputValue[],
                ) => {
                  if (injectFailure && !failedOnce && sql.includes(sqlNeedle)) {
                    failedOnce = true;
                    throw new Error(`injected ${sqlNeedle} failure`);
                  }
                  return target.run(sql, parameters);
                };
              }
              const value = Reflect.get(target, property, target) as unknown;
              return typeof value === 'function' ? value.bind(target) : value;
            },
          });
        },
      });
      await service.createAutomation({
        workspaceId: WORKSPACE_ID,
        name: '原子执行',
        schedule: { cadence: 'daily', localTimeMinute: 510, weekday: null },
        action: { kind: 'create-today-task', title: '只能完整提交' },
      });
      await service.setAutomationEnabled({
        workspaceId: WORKSPACE_ID,
        automationId: AUTOMATION_ID,
        expectedRevision: 1,
        enabled: true,
      });
      now = new Date(2026, 6, 23, 9, 0, 0);
      const input = {
        automationId: AUTOMATION_ID,
        expectedRevision: 2,
        occurrenceDate: '2026-07-23',
        scheduledFor: new Date(2026, 6, 23, 8, 30, 0).toISOString(),
      };
      injectFailure = true;
      await expect(service.runAutomationOccurrence(input)).resolves.toMatchObject({
        status: 'failed',
      });
      expect((await service.getTaskSnapshot({ workspaceId: WORKSPACE_ID })).tasks).toEqual([]);

      now = new Date(2026, 6, 23, 9, 6, 0);
      await expect(service.runAutomationOccurrence(input)).resolves.toMatchObject({
        status: 'success',
      });
      expect((await service.getTaskSnapshot({ workspaceId: WORKSPACE_ID })).tasks).toHaveLength(1);
      await service.close();
    },
  );

  it('rolls back a failed manual output without touching schedule state or ledgers', async () => {
    let failTaskInsert = false;
    const { service, dataDirectory } = await createServiceContext({
      now: () => new Date(2026, 6, 23, 9, 0, 0),
      automationIdFactory: () => AUTOMATION_ID,
      automationTaskIdFactory: () => TASK_ID,
      adapterFactory: (path, options) => {
        const adapter = createNodeSqliteAdapter(path, options);
        return options?.readOnly
          ? adapter
          : bindAdapterWithAutomationTransactionFailure(adapter, {
              failCommitAfterSuccess: () => false,
              failTaskInsert: () => failTaskInsert,
              failRollbackAfterSuccess: () => false,
            });
      },
    });
    await service.createAutomation({
      workspaceId: WORKSPACE_ID,
      name: '手动原子执行',
      schedule: { cadence: 'daily', localTimeMinute: 510, weekday: null },
      action: { kind: 'create-today-task', title: '只能完整提交' },
    });
    const before = readAutomationPersistenceState(dataDirectory);
    failTaskInsert = true;

    await expect(
      service.runAutomationNow({
        workspaceId: WORKSPACE_ID,
        automationId: AUTOMATION_ID,
        expectedRevision: 1,
      }),
    ).rejects.toBeInstanceOf(AutomationOperationError);
    expect((await service.getTaskSnapshot({ workspaceId: WORKSPACE_ID })).tasks).toEqual([]);
    expect(readAutomationPersistenceState(dataDirectory)).toEqual(before);

    failTaskInsert = false;
    await expect(
      service.runAutomationNow({
        workspaceId: WORKSPACE_ID,
        automationId: AUTOMATION_ID,
        expectedRevision: 1,
      }),
    ).resolves.toMatchObject({ outputKind: 'task', outputId: TASK_ID });
    expect((await service.getTaskSnapshot({ workspaceId: WORKSPACE_ID })).tasks).toHaveLength(1);
    expect(readAutomationPersistenceState(dataDirectory)).toEqual(before);
    await service.close();
  });

  it('poisons manual execution when COMMIT succeeds before the adapter throws', async () => {
    let failCommitAfterSuccess = false;
    const { service, dataDirectory } = await createServiceContext({
      now: () => new Date(2026, 6, 23, 9, 0, 0),
      automationIdFactory: () => AUTOMATION_ID,
      automationTaskIdFactory: () => TASK_ID,
      adapterFactory: (path, options) => {
        const adapter = createNodeSqliteAdapter(path, options);
        return options?.readOnly
          ? adapter
          : bindAdapterWithAutomationTransactionFailure(adapter, {
              failCommitAfterSuccess: () => failCommitAfterSuccess,
              failTaskInsert: () => false,
              failRollbackAfterSuccess: () => false,
            });
      },
    });
    await service.createAutomation({
      workspaceId: WORKSPACE_ID,
      name: '提交结果未知',
      schedule: { cadence: 'daily', localTimeMinute: 510, weekday: null },
      action: { kind: 'create-today-task', title: '提交后保留' },
    });
    const before = readAutomationPersistenceState(dataDirectory);
    failCommitAfterSuccess = true;

    await expect(
      service.runAutomationNow({
        workspaceId: WORKSPACE_ID,
        automationId: AUTOMATION_ID,
        expectedRevision: 1,
      }),
    ).rejects.toBeInstanceOf(DatabaseIntegrityError);
    await expect(
      service.getAutomationSnapshot({ workspaceId: WORKSPACE_ID }),
    ).rejects.toBeInstanceOf(DatabaseStateError);
    failCommitAfterSuccess = false;
    await service.close();

    const reopened = new DatabaseService({ dataDirectory });
    await reopened.open();
    await expect(reopened.getTaskSnapshot({ workspaceId: WORKSPACE_ID })).resolves.toMatchObject({
      tasks: [{ id: TASK_ID, title: '提交后保留' }],
    });
    expect(readAutomationPersistenceState(dataDirectory)).toEqual(before);
    await reopened.close();
  });

  it('poisons manual execution when a failed insert cannot roll back safely', async () => {
    let failTaskInsert = false;
    let failRollbackAfterSuccess = false;
    const { service, dataDirectory } = await createServiceContext({
      now: () => new Date(2026, 6, 23, 9, 0, 0),
      automationIdFactory: () => AUTOMATION_ID,
      automationTaskIdFactory: () => TASK_ID,
      adapterFactory: (path, options) => {
        const adapter = createNodeSqliteAdapter(path, options);
        return options?.readOnly
          ? adapter
          : bindAdapterWithAutomationTransactionFailure(adapter, {
              failCommitAfterSuccess: () => false,
              failTaskInsert: () => failTaskInsert,
              failRollbackAfterSuccess: () => failRollbackAfterSuccess,
            });
      },
    });
    await service.createAutomation({
      workspaceId: WORKSPACE_ID,
      name: '回滚结果未知',
      schedule: { cadence: 'daily', localTimeMinute: 510, weekday: null },
      action: { kind: 'create-today-task', title: '不会半提交' },
    });
    const before = readAutomationPersistenceState(dataDirectory);
    failTaskInsert = true;
    failRollbackAfterSuccess = true;

    await expect(
      service.runAutomationNow({
        workspaceId: WORKSPACE_ID,
        automationId: AUTOMATION_ID,
        expectedRevision: 1,
      }),
    ).rejects.toBeInstanceOf(DatabaseIntegrityError);
    await expect(service.getTaskSnapshot({ workspaceId: WORKSPACE_ID })).rejects.toBeInstanceOf(
      DatabaseStateError,
    );
    failTaskInsert = false;
    failRollbackAfterSuccess = false;
    await service.close();

    const reopened = new DatabaseService({ dataDirectory });
    await reopened.open();
    await expect(reopened.getTaskSnapshot({ workspaceId: WORKSPACE_ID })).resolves.toMatchObject({
      tasks: [],
    });
    expect(readAutomationPersistenceState(dataDirectory)).toEqual(before);
    await reopened.close();
  });

  it('poisons the service when COMMIT succeeds before the adapter throws', async () => {
    let now = new Date(2026, 6, 23, 8, 0, 0);
    let failCommitAfterSuccess = false;
    const { service, dataDirectory } = await createServiceContext({
      now: () => now,
      automationIdFactory: () => AUTOMATION_ID,
      automationTaskIdFactory: () => TASK_ID,
      adapterFactory: (path, options) => {
        const adapter = createNodeSqliteAdapter(path, options);
        return options?.readOnly
          ? adapter
          : bindAdapterWithAutomationTransactionFailure(adapter, {
              failCommitAfterSuccess: () => failCommitAfterSuccess,
              failTaskInsert: () => false,
              failRollbackAfterSuccess: () => false,
            });
      },
    });
    await createEnabledTaskAutomation(service);
    now = new Date(2026, 6, 23, 9, 0, 0);
    failCommitAfterSuccess = true;

    await expect(service.runAutomationOccurrence(dueRunInput())).rejects.toBeInstanceOf(
      DatabaseIntegrityError,
    );
    await expect(
      service.getAutomationSnapshot({ workspaceId: WORKSPACE_ID }),
    ).rejects.toBeInstanceOf(DatabaseStateError);
    failCommitAfterSuccess = false;
    await service.close();

    const reopened = new DatabaseService({
      dataDirectory,
      now: () => now,
      automationTaskIdFactory: () => TASK_ID,
    });
    await reopened.open();
    await expect(reopened.getTaskSnapshot({ workspaceId: WORKSPACE_ID })).resolves.toMatchObject({
      tasks: [{ id: TASK_ID }],
    });
    await expect(
      reopened.getAutomationSnapshot({ workspaceId: WORKSPACE_ID }),
    ).resolves.toMatchObject({
      items: [
        {
          id: AUTOMATION_ID,
          lastRun: {
            status: 'success',
            outputKind: 'task',
          },
        },
      ],
    });
    await expect(reopened.runAutomationOccurrence(dueRunInput())).resolves.toMatchObject({
      status: 'skipped',
    });
    await reopened.close();
  });

  it('poisons the service when a failed output transaction cannot roll back safely', async () => {
    let now = new Date(2026, 6, 23, 8, 0, 0);
    let failTaskInsert = false;
    let failRollbackAfterSuccess = false;
    const { service, dataDirectory } = await createServiceContext({
      now: () => now,
      automationIdFactory: () => AUTOMATION_ID,
      automationTaskIdFactory: () => TASK_ID,
      adapterFactory: (path, options) => {
        const adapter = createNodeSqliteAdapter(path, options);
        return options?.readOnly
          ? adapter
          : bindAdapterWithAutomationTransactionFailure(adapter, {
              failCommitAfterSuccess: () => false,
              failTaskInsert: () => failTaskInsert,
              failRollbackAfterSuccess: () => failRollbackAfterSuccess,
            });
      },
    });
    await createEnabledTaskAutomation(service);
    now = new Date(2026, 6, 23, 9, 0, 0);
    failTaskInsert = true;
    failRollbackAfterSuccess = true;

    await expect(service.runAutomationOccurrence(dueRunInput())).rejects.toBeInstanceOf(
      DatabaseIntegrityError,
    );
    await expect(service.getTaskSnapshot({ workspaceId: WORKSPACE_ID })).rejects.toBeInstanceOf(
      DatabaseStateError,
    );
    failTaskInsert = false;
    failRollbackAfterSuccess = false;
    await service.close();

    const reopened = new DatabaseService({
      dataDirectory,
      now: () => now,
      automationTaskIdFactory: () => TASK_ID,
    });
    await reopened.open();
    await expect(reopened.getTaskSnapshot({ workspaceId: WORKSPACE_ID })).resolves.toMatchObject({
      tasks: [],
    });
    await expect(
      reopened.getAutomationSnapshot({ workspaceId: WORKSPACE_ID }),
    ).resolves.toMatchObject({
      items: [{ id: AUTOMATION_ID, lastRun: { status: 'never' } }],
    });
    await expect(reopened.runAutomationOccurrence(dueRunInput())).resolves.toMatchObject({
      status: 'success',
    });
    await expect(reopened.getTaskSnapshot({ workspaceId: WORKSPACE_ID })).resolves.toMatchObject({
      tasks: [{ id: TASK_ID }],
    });
    await reopened.close();
  });
});

async function createService(
  options: Pick<
    ConstructorParameters<typeof DatabaseService>[0],
    | 'now'
    | 'workspaceIdFactory'
    | 'automationIdFactory'
    | 'automationTaskIdFactory'
    | 'automationNoteIdFactory'
    | 'adapterFactory'
  >,
): Promise<DatabaseService> {
  return (await createServiceContext(options)).service;
}

async function createServiceContext(
  options: Pick<
    ConstructorParameters<typeof DatabaseService>[0],
    | 'now'
    | 'workspaceIdFactory'
    | 'automationIdFactory'
    | 'automationTaskIdFactory'
    | 'automationNoteIdFactory'
    | 'adapterFactory'
  >,
): Promise<{ readonly service: DatabaseService; readonly dataDirectory: string }> {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'daily-workbench-automation-service-'));
  temporaryDirectories.push(dataDirectory);
  const service = new DatabaseService({
    dataDirectory,
    workspaceIdFactory: () => WORKSPACE_ID,
    ...options,
  });
  await service.open();
  return { service, dataDirectory };
}

function readAutomationPersistenceState(dataDirectory: string): {
  readonly definitions: readonly Record<string, unknown>[];
  readonly runState: readonly Record<string, unknown>[];
  readonly occurrences: readonly Record<string, unknown>[];
} {
  const database = new DatabaseSync(join(dataDirectory, 'daily-workbench.sqlite3'), {
    readOnly: true,
  });
  try {
    return {
      definitions: database
        .prepare(
          `SELECT id, workspace_id, name, cadence, local_time_minute, weekday,
                  action_kind, action_title, action_body, enabled, effective_at,
                  revision, created_at, updated_at, archived_at
           FROM automations
           ORDER BY id`,
        )
        .all()
        .map((row) => ({ ...row })),
      runState: database
        .prepare(
          `SELECT automation_id, last_attempt_at, last_attempt_occurrence,
                  last_success_at, last_success_occurrence, last_output_kind,
                  last_error_code, consecutive_failures, next_retry_at, updated_at
           FROM automation_run_state
           ORDER BY automation_id`,
        )
        .all()
        .map((row) => ({ ...row })),
      occurrences: database
        .prepare(
          `SELECT automation_id, occurrence_date, scheduled_for, definition_revision,
                  completed_at, output_kind, task_id, note_id
           FROM automation_occurrences
           ORDER BY automation_id, occurrence_date`,
        )
        .all()
        .map((row) => ({ ...row })),
    };
  } finally {
    database.close();
  }
}

async function createEnabledTaskAutomation(service: DatabaseService): Promise<void> {
  await service.createAutomation({
    workspaceId: WORKSPACE_ID,
    name: '事务自动化',
    schedule: { cadence: 'daily', localTimeMinute: 510, weekday: null },
    action: { kind: 'create-today-task', title: '只提交一次' },
  });
  await service.setAutomationEnabled({
    workspaceId: WORKSPACE_ID,
    automationId: AUTOMATION_ID,
    expectedRevision: 1,
    enabled: true,
  });
}

function dueRunInput() {
  return {
    automationId: AUTOMATION_ID,
    expectedRevision: 2,
    occurrenceDate: '2026-07-23',
    scheduledFor: new Date(2026, 6, 23, 8, 30, 0).toISOString(),
  };
}

function bindAdapterWithAutomationTransactionFailure(
  adapter: SqliteAdapter,
  failures: {
    readonly failCommitAfterSuccess: () => boolean;
    readonly failTaskInsert: () => boolean;
    readonly failRollbackAfterSuccess: () => boolean;
  },
): SqliteAdapter {
  return new Proxy(adapter, {
    get(target, property) {
      if (property === 'run') {
        return (sql: string, parameters: readonly SQLInputValue[] = []) => {
          if (failures.failTaskInsert() && sql.includes('INSERT INTO tasks')) {
            throw new Error('injected automation task insertion failure');
          }
          return target.run(sql, parameters);
        };
      }
      if (property === 'exec') {
        return (sql: string) => {
          target.exec(sql);
          if (sql === 'COMMIT' && failures.failCommitAfterSuccess()) {
            throw new Error('injected post-commit automation failure');
          }
          if (sql === 'ROLLBACK' && failures.failRollbackAfterSuccess()) {
            throw new Error('injected post-rollback automation failure');
          }
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
