import { describe, expect, it, vi } from 'vitest';
import type { ScheduleItem, ScheduleSnapshot } from '../src/shared/contracts';
import {
  createScheduleCreateWorkspaceIdentity,
  isScheduleCreateTodayDateCurrent,
  resolveScheduleCreateNavigationTarget,
  sameScheduleCreateFeedback,
  scheduleCreateFeedbackKey,
  scheduleCreateNavigationError,
  scheduleCreateOpenFailed,
  scheduleCreateOpenFinished,
  scheduleCreateOpenStarted,
  scheduleCreateSyncRefreshError,
  scheduleCreateTitleSummary,
  ScheduleCreateCoordinator,
  ScheduleCreateInProgressError,
  ScheduleCreateNoteDraftPreservedError,
  ScheduleCreateOpenGate,
  ScheduleCreatePublicationGate,
  ScheduleCreateSupersededError,
  ScheduleCreateSyncRefreshError,
  ScheduleCreateUnavailableError,
  type ScheduleCreateFeedback,
  type ScheduleCreateSnapshotRefresh,
  type ScheduleCreateWorkspaceIdentity,
} from '../src/renderer/schedule-create-navigation';

const WORKSPACE_A = '11111111-1111-4111-8111-111111111111';
const WORKSPACE_B = '22222222-2222-4222-8222-222222222222';
const SCHEDULE_A = '33333333-3333-4333-8333-333333333333';
const SCHEDULE_B = '44444444-4444-4444-8444-444444444444';

describe('manual schedule create navigation', () => {
  it('normalizes and bounds schedule title summaries by Unicode code point', () => {
    expect(scheduleCreateTitleSummary('  整理\n\t发布   清单  ')).toBe('整理 发布 清单');
    expect(scheduleCreateTitleSummary(`${'专'.repeat(95)}😀`)).toBe(`${'专'.repeat(95)}😀`);
    expect(scheduleCreateTitleSummary(`${'专'.repeat(95)}😀尾`)).toBe(`${'专'.repeat(95)}…`);
  });

  it('invalidates a committed navigation target when a blocking prompt crosses midnight', () => {
    expect(isScheduleCreateTodayDateCurrent('2026-07-27', new Date(2026, 6, 27, 23, 59, 59))).toBe(
      true,
    );
    expect(isScheduleCreateTodayDateCurrent('2026-07-27', new Date(2026, 6, 28, 0, 0, 0))).toBe(
      false,
    );
  });

  it('creates a distinct frozen identity for every workspace activation', () => {
    const firstA = createScheduleCreateWorkspaceIdentity(WORKSPACE_A);
    const secondA = createScheduleCreateWorkspaceIdentity(WORKSPACE_A);

    expect(firstA).toEqual(secondA);
    expect(firstA).not.toBe(secondA);
    expect(Object.isFrozen(firstA)).toBe(true);
    expect(createScheduleCreateWorkspaceIdentity(null)).toEqual({ workspaceId: null });
  });

  it('publishes a staged outcome only after the modal closes and only once', () => {
    const workspace = createScheduleCreateWorkspaceIdentity(WORKSPACE_A);
    const gate = new ScheduleCreatePublicationGate<{ readonly id: string }>();
    const outcome = Object.freeze({ id: SCHEDULE_A });

    gate.stage(workspace, outcome);
    expect(gate.take(true, workspace)).toBeNull();
    expect(gate.take(false, workspace)).toBe(outcome);
    expect(gate.take(false, workspace)).toBeNull();
  });

  it('drops staged outcomes across invalidation and A to B to A activations', () => {
    const firstA = createScheduleCreateWorkspaceIdentity(WORKSPACE_A);
    const secondA = createScheduleCreateWorkspaceIdentity(WORKSPACE_A);
    const workspaceB = createScheduleCreateWorkspaceIdentity(WORKSPACE_B);
    const gate = new ScheduleCreatePublicationGate<string>();

    gate.stage(firstA, 'first A');
    expect(gate.take(false, workspaceB)).toBeNull();
    expect(gate.take(false, firstA)).toBeNull();

    gate.stage(firstA, 'stale A');
    expect(gate.take(false, secondA)).toBeNull();

    gate.stage(secondA, 'current A');
    gate.clear();
    expect(gate.take(false, secondA)).toBeNull();
  });

  it('publishes only the latest committed create with complete schedule feedback', () => {
    const workspace = createScheduleCreateWorkspaceIdentity(WORKSPACE_A);
    const coordinator = new ScheduleCreateCoordinator();
    expect(() => coordinator.beginCreate(createScheduleCreateWorkspaceIdentity(null))).toThrow(
      ScheduleCreateSupersededError,
    );

    const older = coordinator.beginCreate(workspace);
    expect(() => coordinator.beginCreate(workspace)).toThrow(ScheduleCreateInProgressError);
    coordinator.endCreate(older);
    const newer = coordinator.beginCreate(workspace);
    expect(coordinator.isCreateCurrent(older, workspace)).toBe(false);
    expect(() => coordinator.createFeedback(older, workspace, item(), true)).toThrow(
      ScheduleCreateSupersededError,
    );

    const current = coordinator.createFeedback(newer, workspace, item(), true);
    expect(current).toEqual({
      requestGeneration: newer.generation,
      workspaceId: WORKSPACE_A,
      createdScheduleId: SCHEDULE_A,
      title: '深度工作',
      scheduledFor: '2026-07-27',
      startMinute: 540,
      endMinute: 630,
      kind: 'focus',
    });
    expect(Object.isFrozen(current)).toBe(true);
    expect(scheduleCreateFeedbackKey(current)).toBe(
      JSON.stringify([
        newer.generation,
        WORKSPACE_A,
        SCHEDULE_A,
        '深度工作',
        '2026-07-27',
        540,
        630,
        'focus',
      ]),
    );
    expect(() => coordinator.createFeedback(newer, workspace, item(), false)).toThrow(
      ScheduleCreateSupersededError,
    );
    coordinator.endCreate(newer);
  });

  it('publishes recovered feedback only for the still-current create generation', () => {
    const firstA = createScheduleCreateWorkspaceIdentity(WORKSPACE_A);
    const coordinator = new ScheduleCreateCoordinator();
    const created = item();
    const intent = coordinator.beginCreate(firstA);
    coordinator.endCreate(intent);

    expect(coordinator.createRecoveredFeedback(intent.generation, firstA, created, true)).toEqual({
      requestGeneration: intent.generation,
      workspaceId: WORKSPACE_A,
      createdScheduleId: created.id,
      title: created.title,
      scheduledFor: created.scheduledFor,
      startMinute: created.startMinute,
      endMinute: created.endMinute,
      kind: created.kind,
    });
    expect(() =>
      coordinator.createRecoveredFeedback(intent.generation, firstA, created, false),
    ).toThrow(ScheduleCreateSupersededError);
    expect(() =>
      coordinator.createRecoveredFeedback(
        intent.generation,
        createScheduleCreateWorkspaceIdentity(WORKSPACE_A),
        created,
        true,
      ),
    ).toThrow(ScheduleCreateSupersededError);

    const newer = coordinator.beginCreate(firstA);
    expect(() =>
      coordinator.createRecoveredFeedback(intent.generation, firstA, created, true),
    ).toThrow(ScheduleCreateSupersededError);
    coordinator.endCreate(newer);
  });

  it('keeps creation single-flight and ignores an old finally after replacement', () => {
    const firstA = createScheduleCreateWorkspaceIdentity(WORKSPACE_A);
    const secondA = createScheduleCreateWorkspaceIdentity(WORKSPACE_A);
    const coordinator = new ScheduleCreateCoordinator();
    const first = coordinator.beginCreate(firstA);

    expect(() => coordinator.beginCreate(firstA)).toThrow(ScheduleCreateInProgressError);
    coordinator.invalidate();
    const replacement = coordinator.beginCreate(secondA);
    coordinator.endCreate(first);
    expect(() => coordinator.beginCreate(secondA)).toThrow(ScheduleCreateInProgressError);
    coordinator.endCreate(replacement);
    expect(() => coordinator.beginCreate(secondA)).not.toThrow();
  });

  it('rejects delayed creation after invalidation or an A to B to A activation cycle', () => {
    const firstA = createScheduleCreateWorkspaceIdentity(WORKSPACE_A);
    const secondA = createScheduleCreateWorkspaceIdentity(WORKSPACE_A);
    const coordinator = new ScheduleCreateCoordinator();
    const intent = coordinator.beginCreate(firstA);

    expect(
      coordinator.isCreateCurrent(intent, createScheduleCreateWorkspaceIdentity(WORKSPACE_B)),
    ).toBe(false);
    expect(coordinator.isCreateCurrent(intent, secondA)).toBe(false);
    expect(() => coordinator.createFeedback(intent, secondA, item(), true)).toThrow(
      ScheduleCreateSupersededError,
    );
    expect(coordinator.isCreateCurrent(intent, firstA)).toBe(true);

    coordinator.invalidate();
    expect(coordinator.isCreateCurrent(intent, firstA)).toBe(false);
    expect(() => coordinator.assertCreateCurrent(intent, firstA)).toThrow(
      ScheduleCreateSupersededError,
    );
  });

  it('binds opening to the exact activation and every feedback field', () => {
    const firstA = createScheduleCreateWorkspaceIdentity(WORKSPACE_A);
    const secondA = createScheduleCreateWorkspaceIdentity(WORKSPACE_A);
    const coordinator = new ScheduleCreateCoordinator();
    const current = publishedFeedback(coordinator, firstA);
    const intent = coordinator.beginOpen(firstA, current);

    expect(coordinator.isOpenCurrent(intent, firstA, current)).toBe(true);
    expect(coordinator.isOpenCurrent(intent, secondA, current)).toBe(false);
    for (const replacement of [
      { ...current, requestGeneration: current.requestGeneration + 1 },
      { ...current, workspaceId: WORKSPACE_B },
      { ...current, createdScheduleId: SCHEDULE_B },
      { ...current, title: '较新的名称' },
      { ...current, scheduledFor: '2026-07-28' },
      { ...current, startMinute: 600 },
      { ...current, endMinute: 660 },
      { ...current, kind: 'meeting' as const },
    ]) {
      expect(coordinator.isOpenCurrent(intent, firstA, replacement)).toBe(false);
    }
    expect(sameScheduleCreateFeedback(current, { ...current })).toBe(true);
    expect(sameScheduleCreateFeedback(current, null)).toBe(false);
    expect(() =>
      coordinator.beginOpen(createScheduleCreateWorkspaceIdentity(WORKSPACE_B), current),
    ).toThrow(ScheduleCreateSupersededError);
  });

  it('makes a newer create supersede old feedback and an open already in flight', () => {
    const workspace = createScheduleCreateWorkspaceIdentity(WORKSPACE_A);
    const coordinator = new ScheduleCreateCoordinator();
    const original = publishedFeedback(coordinator, workspace);
    const openIntent = coordinator.beginOpen(workspace, original);
    const newerCreate = coordinator.beginCreate(workspace);

    expect(coordinator.isFeedbackCurrent(workspace, original, original)).toBe(false);
    expect(coordinator.isOpenCurrent(openIntent, workspace, original)).toBe(false);
    expect(() => coordinator.assertOpenCurrent(openIntent, workspace, original)).toThrow(
      ScheduleCreateSupersededError,
    );

    const newer = coordinator.createFeedback(
      newerCreate,
      workspace,
      item({ id: SCHEDULE_B, title: '较新的日程' }),
      true,
    );
    expect(newer.requestGeneration).toBeGreaterThan(original.requestGeneration);
    expect(coordinator.isFeedbackCurrent(workspace, newer, newer)).toBe(true);
    coordinator.endCreate(newerCreate);
  });

  it('cancels only an in-flight open and keeps current feedback reusable', () => {
    const workspace = createScheduleCreateWorkspaceIdentity(WORKSPACE_A);
    const coordinator = new ScheduleCreateCoordinator();
    const current = publishedFeedback(coordinator, workspace);
    const originalOpen = coordinator.beginOpen(workspace, current);

    coordinator.cancelOpen();
    expect(coordinator.isOpenCurrent(originalOpen, workspace, current)).toBe(false);
    expect(coordinator.isFeedbackCurrent(workspace, current, current)).toBe(true);
    expect(() => coordinator.beginOpen(workspace, current)).not.toThrow();
  });

  it('dismisses only the complete current feedback and invalidates its open intent', () => {
    const workspace = createScheduleCreateWorkspaceIdentity(WORKSPACE_A);
    const coordinator = new ScheduleCreateCoordinator();
    const current = publishedFeedback(coordinator, workspace);
    const intent = coordinator.beginOpen(workspace, current);

    expect(coordinator.dismiss({ ...current, title: '其他日程' }, workspace, current)).toBe(false);
    expect(coordinator.isOpenCurrent(intent, workspace, current)).toBe(true);
    expect(coordinator.dismiss(current, workspace, current)).toBe(true);
    expect(coordinator.isOpenCurrent(intent, workspace, current)).toBe(false);
    expect(coordinator.dismiss(current, workspace, current)).toBe(false);
  });

  it('fresh-reads, commits, and returns the exact id on its original date', async () => {
    const workspace = createScheduleCreateWorkspaceIdentity(WORKSPACE_A);
    const coordinator = new ScheduleCreateCoordinator();
    const current = publishedFeedback(coordinator, workspace);
    const intent = coordinator.beginOpen(workspace, current);
    const commit = vi.fn(() => true);
    const readSchedule = vi.fn(async () =>
      refresh(
        snapshot({
          items: [
            item({
              id: SCHEDULE_B,
              title: current.title,
              scheduledFor: current.scheduledFor,
              startMinute: current.startMinute,
              endMinute: current.endMinute,
              kind: current.kind,
            }),
            item({
              id: SCHEDULE_A,
              title: '创建后已重命名',
              startMinute: 600,
              endMinute: 690,
              kind: 'meeting',
              revision: 8,
              updatedAt: '2026-07-26T12:01:00.000Z',
            }),
          ],
        }),
        commit,
      ),
    );

    await expect(
      resolveScheduleCreateNavigationTarget(intent, readSchedule, () =>
        coordinator.assertOpenCurrent(intent, workspace, current),
      ),
    ).resolves.toMatchObject({
      workspaceId: WORKSPACE_A,
      todayDate: '2026-07-26',
      item: {
        id: SCHEDULE_A,
        title: '创建后已重命名',
        scheduledFor: '2026-07-27',
        startMinute: 600,
        endMinute: 690,
        kind: 'meeting',
        revision: 8,
      },
    });
    expect(readSchedule).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledOnce();
  });

  it('never falls back by title, date, time, kind, timestamp, or list position when id is missing', async () => {
    const workspace = createScheduleCreateWorkspaceIdentity(WORKSPACE_A);
    const coordinator = new ScheduleCreateCoordinator();
    const current = publishedFeedback(coordinator, workspace);
    const intent = coordinator.beginOpen(workspace, current);
    const commit = vi.fn(() => true);

    await expect(
      resolveScheduleCreateNavigationTarget(
        intent,
        async () =>
          refresh(
            snapshot({
              items: [
                item({
                  id: SCHEDULE_B,
                  title: current.title,
                  scheduledFor: current.scheduledFor,
                  startMinute: current.startMinute,
                  endMinute: current.endMinute,
                  kind: current.kind,
                  createdAt: '2026-07-26T12:00:00.000Z',
                  updatedAt: '2026-07-26T12:00:00.000Z',
                }),
              ],
            }),
            commit,
          ),
        () => coordinator.assertOpenCurrent(intent, workspace, current),
      ),
    ).rejects.toBeInstanceOf(ScheduleCreateUnavailableError);
    expect(commit).not.toHaveBeenCalled();
  });

  it('treats duplicate ids, a changed date, a wrong workspace, and commit=false as unavailable', async () => {
    const workspace = createScheduleCreateWorkspaceIdentity(WORKSPACE_A);
    const coordinator = new ScheduleCreateCoordinator();
    const current = publishedFeedback(coordinator, workspace);
    const intent = coordinator.beginOpen(workspace, current);
    const assertCurrent = () => coordinator.assertOpenCurrent(intent, workspace, current);
    const duplicateCommit = vi.fn(() => true);
    const changedDateCommit = vi.fn(() => true);
    const wrongWorkspaceCommit = vi.fn(() => true);

    await expect(
      resolveScheduleCreateNavigationTarget(
        intent,
        async () =>
          refresh(
            snapshot({
              items: [item(), item({ scheduledFor: '2026-07-28', title: '重复 ID' })],
            }),
            duplicateCommit,
          ),
        assertCurrent,
      ),
    ).rejects.toBeInstanceOf(ScheduleCreateUnavailableError);
    expect(duplicateCommit).not.toHaveBeenCalled();

    await expect(
      resolveScheduleCreateNavigationTarget(
        intent,
        async () =>
          refresh(
            snapshot({
              items: [item({ scheduledFor: '2026-07-28' })],
            }),
            changedDateCommit,
          ),
        assertCurrent,
      ),
    ).rejects.toBeInstanceOf(ScheduleCreateUnavailableError);
    expect(changedDateCommit).not.toHaveBeenCalled();

    await expect(
      resolveScheduleCreateNavigationTarget(
        intent,
        async () => refresh(snapshot({ workspaceId: WORKSPACE_B }), wrongWorkspaceCommit),
        assertCurrent,
      ),
    ).rejects.toBeInstanceOf(ScheduleCreateUnavailableError);
    expect(wrongWorkspaceCommit).not.toHaveBeenCalled();

    const rejectedCommit = vi.fn(() => false);
    await expect(
      resolveScheduleCreateNavigationTarget(
        intent,
        async () => refresh(snapshot(), rejectedCommit),
        assertCurrent,
      ),
    ).rejects.toBeInstanceOf(ScheduleCreateUnavailableError);
    expect(rejectedCommit).toHaveBeenCalledOnce();
  });

  it('rejects a delayed read after A to B to A, dismiss, or a newer create', async () => {
    const firstA = createScheduleCreateWorkspaceIdentity(WORKSPACE_A);
    const coordinator = new ScheduleCreateCoordinator();
    const current = publishedFeedback(coordinator, firstA);
    const intent = coordinator.beginOpen(firstA, current);
    let currentWorkspace: ScheduleCreateWorkspaceIdentity = firstA;
    let currentFeedback: ScheduleCreateFeedback | null = current;
    let release!: (value: ScheduleCreateSnapshotRefresh) => void;
    const delayed = new Promise<ScheduleCreateSnapshotRefresh>((resolve) => {
      release = resolve;
    });
    const commit = vi.fn(() => true);
    const resolution = resolveScheduleCreateNavigationTarget(
      intent,
      () => delayed,
      () => coordinator.assertOpenCurrent(intent, currentWorkspace, currentFeedback),
    );

    currentWorkspace = createScheduleCreateWorkspaceIdentity(WORKSPACE_B);
    currentWorkspace = createScheduleCreateWorkspaceIdentity(WORKSPACE_A);
    currentFeedback = null;
    coordinator.beginCreate(currentWorkspace);
    release(refresh(snapshot(), commit));

    await expect(resolution).rejects.toBeInstanceOf(ScheduleCreateSupersededError);
    expect(commit).not.toHaveBeenCalled();
  });

  it('does not return a target when state changes during the authoritative commit', async () => {
    const workspace = createScheduleCreateWorkspaceIdentity(WORKSPACE_A);
    const coordinator = new ScheduleCreateCoordinator();
    const current = publishedFeedback(coordinator, workspace);
    const intent = coordinator.beginOpen(workspace, current);
    let currentFeedback: ScheduleCreateFeedback | null = current;
    const commit = vi.fn(() => {
      currentFeedback = null;
      coordinator.invalidate();
      return true;
    });

    await expect(
      resolveScheduleCreateNavigationTarget(
        intent,
        async () => refresh(snapshot(), commit),
        () => coordinator.assertOpenCurrent(intent, workspace, currentFeedback),
      ),
    ).rejects.toBeInstanceOf(ScheduleCreateSupersededError);
    expect(commit).toHaveBeenCalledOnce();
  });

  it('gates duplicate opens without letting a late end release a replacement lease', () => {
    const original = feedback();
    const equalReplacement = { ...original };
    const newer = feedback({
      requestGeneration: original.requestGeneration + 1,
      createdScheduleId: SCHEDULE_B,
    });
    const gate = new ScheduleCreateOpenGate();

    expect(gate.begin(original)).toBe(true);
    expect(gate.begin(equalReplacement)).toBe(false);
    expect(gate.begin(newer)).toBe(true);
    gate.end(original);
    expect(gate.begin(equalReplacement)).toBe(true);
    gate.end(original);
    expect(gate.begin({ ...equalReplacement })).toBe(false);
    gate.end(equalReplacement);
    expect(gate.begin({ ...equalReplacement })).toBe(true);
  });

  it('tracks focusable errors and ignores late reducers after feedback changes', () => {
    const original = feedback();
    const newer = feedback({
      requestGeneration: original.requestGeneration + 1,
      createdScheduleId: SCHEDULE_B,
      title: '较新的日程',
      scheduledFor: '2026-07-28',
      startMinute: 600,
      endMinute: 660,
      kind: 'meeting',
    });
    const originalState = scheduleCreateOpenStarted(original);
    const newerState = scheduleCreateOpenStarted(newer);

    expect(scheduleCreateFeedbackKey(original)).not.toBe(scheduleCreateFeedbackKey(newer));
    expect(scheduleCreateOpenFailed(originalState, original, '打开失败', 'original-error')).toEqual(
      {
        feedbackKey: scheduleCreateFeedbackKey(original),
        opening: false,
        error: '打开失败',
        errorFocusKey: 'original-error',
      },
    );
    expect(scheduleCreateOpenFailed(newerState, original, '旧失败', 'stale-error')).toBe(
      newerState,
    );
    expect(scheduleCreateOpenFinished(newerState, original)).toBe(newerState);
    expect(scheduleCreateOpenFinished(newerState, newer)).toEqual({
      feedbackKey: scheduleCreateFeedbackKey(newer),
      opening: false,
      error: null,
      errorFocusKey: null,
    });
  });

  it('preserves typed failures and bounds unknown remote errors', () => {
    const superseded = new ScheduleCreateSupersededError();
    const inProgress = new ScheduleCreateInProgressError();
    const draftPreserved = new ScheduleCreateNoteDraftPreservedError();
    const unavailable = new ScheduleCreateUnavailableError();
    expect(superseded.message).toMatch(/新建日程/u);
    expect(inProgress.message).toMatch(/创建/u);
    expect(draftPreserved.message).toMatch(/未保存/u);
    expect(unavailable.message).toMatch(/日程/u);
    expect(scheduleCreateNavigationError(superseded)).toBe(superseded);
    expect(scheduleCreateNavigationError(draftPreserved)).toBe(draftPreserved);
    expect(scheduleCreateNavigationError(unavailable)).toBe(unavailable);
    const refreshFailure = new ScheduleCreateSyncRefreshError('安全的重新读取失败提示');
    expect(scheduleCreateSyncRefreshError(superseded)).toBe(superseded);
    expect(scheduleCreateSyncRefreshError(refreshFailure)).toBe(refreshFailure);

    for (const remote of [
      new Error("Error invoking remote method 'schedule:get-snapshot': token=secret-key"),
      new Error('日程不存在；数据库路径=/secret/workspace.db'),
      new Error('secret provider details'),
    ]) {
      const bounded = scheduleCreateNavigationError(remote);
      expect(bounded.message).toBe('无法打开刚创建的日程，请重试。');
      expect(bounded.message).not.toContain('secret');
      expect(bounded.cause).toBe(remote);

      const boundedRefresh = scheduleCreateSyncRefreshError(remote);
      expect(boundedRefresh.message).toBe(
        '日程列表仍无法安全确认。请稍后重新读取；日程可能已经创建，请不要重复创建。',
      );
      expect(boundedRefresh.message).not.toMatch(/secret|token|workspace\.db/u);
      expect(boundedRefresh.cause).toBeUndefined();
    }
  });
});

function publishedFeedback(
  coordinator: ScheduleCreateCoordinator,
  workspace: ScheduleCreateWorkspaceIdentity,
): ScheduleCreateFeedback {
  const intent = coordinator.beginCreate(workspace);
  const current = coordinator.createFeedback(intent, workspace, item(), true);
  coordinator.endCreate(intent);
  return current;
}

function feedback(overrides: Partial<ScheduleCreateFeedback> = {}): ScheduleCreateFeedback {
  return Object.freeze({
    requestGeneration: 7,
    workspaceId: WORKSPACE_A,
    createdScheduleId: SCHEDULE_A,
    title: '深度工作',
    scheduledFor: '2026-07-27',
    startMinute: 540,
    endMinute: 630,
    kind: 'focus',
    ...overrides,
  });
}

function item(overrides: Partial<ScheduleItem> = {}): ScheduleItem {
  return {
    id: SCHEDULE_A,
    title: '深度工作',
    kind: 'focus',
    scheduledFor: '2026-07-27',
    startMinute: 540,
    endMinute: 630,
    revision: 1,
    createdAt: '2026-07-26T12:00:00.000Z',
    updatedAt: '2026-07-26T12:00:00.000Z',
    ...overrides,
  };
}

function snapshot(overrides: Partial<ScheduleSnapshot> = {}): ScheduleSnapshot {
  return {
    workspaceId: WORKSPACE_A,
    todayDate: '2026-07-26',
    planningDays: [],
    items: [item()],
    ...overrides,
  };
}

function refresh(
  scheduleSnapshot: ScheduleSnapshot,
  commit: () => boolean = () => true,
): ScheduleCreateSnapshotRefresh {
  return { snapshot: scheduleSnapshot, commit };
}
