import { describe, expect, it, vi } from 'vitest';
import type { AutomationItem, AutomationSnapshot } from '../src/shared/contracts';
import {
  automationCreateFeedbackKey,
  automationCreateNameSummary,
  automationCreateNavigationError,
  automationCreateSyncRefreshError,
  automationCreateOpenFailed,
  automationCreateOpenFinished,
  automationCreateOpenStarted,
  AutomationCreateCoordinator,
  AutomationCreateInProgressError,
  AutomationCreateNoteDraftPreservedError,
  AutomationCreateOpenGate,
  AutomationCreateSupersededError,
  AutomationCreateSyncRefreshError,
  AutomationCreateUnavailableError,
  createAutomationCreateWorkspaceIdentity,
  resolveAutomationCreateNavigationTarget,
  sameAutomationCreateFeedback,
  type AutomationCreateFeedback,
  type AutomationCreateSnapshotRefresh,
  type AutomationCreateWorkspaceIdentity,
} from '../src/renderer/automation-create-navigation';

const WORKSPACE_A = '11111111-1111-4111-8111-111111111111';
const WORKSPACE_B = '22222222-2222-4222-8222-222222222222';
const AUTOMATION_A = '33333333-3333-4333-8333-333333333333';
const AUTOMATION_B = '44444444-4444-4444-8444-444444444444';

describe('manual automation create navigation', () => {
  it('normalizes and bounds automation name summaries by Unicode code point', () => {
    expect(automationCreateNameSummary('  整理\n\t发布   清单  ')).toBe('整理 发布 清单');
    expect(automationCreateNameSummary(`${'自'.repeat(95)}😀`)).toBe(`${'自'.repeat(95)}😀`);
    expect(automationCreateNameSummary(`${'自'.repeat(95)}😀尾`)).toBe(`${'自'.repeat(95)}…`);
  });

  it('creates a distinct frozen identity for every workspace activation', () => {
    const firstA = createAutomationCreateWorkspaceIdentity(WORKSPACE_A);
    const secondA = createAutomationCreateWorkspaceIdentity(WORKSPACE_A);

    expect(firstA).toEqual(secondA);
    expect(firstA).not.toBe(secondA);
    expect(Object.isFrozen(firstA)).toBe(true);
    expect(createAutomationCreateWorkspaceIdentity(null)).toEqual({ workspaceId: null });
  });

  it('publishes only the latest committed create with complete default-disabled feedback', () => {
    const workspace = createAutomationCreateWorkspaceIdentity(WORKSPACE_A);
    const coordinator = new AutomationCreateCoordinator();
    expect(() => coordinator.beginCreate(createAutomationCreateWorkspaceIdentity(null))).toThrow(
      AutomationCreateSupersededError,
    );

    const older = coordinator.beginCreate(workspace);
    expect(() => coordinator.beginCreate(workspace)).toThrow(AutomationCreateInProgressError);
    coordinator.endCreate(older);
    const newer = coordinator.beginCreate(workspace);
    expect(coordinator.isCreateCurrent(older, workspace)).toBe(false);
    expect(() => coordinator.createFeedback(older, workspace, item(), true)).toThrow(
      AutomationCreateSupersededError,
    );

    const current = coordinator.createFeedback(newer, workspace, item(), true);
    expect(current).toEqual({
      requestGeneration: newer.generation,
      workspaceId: WORKSPACE_A,
      createdAutomationId: AUTOMATION_A,
      name: '每日整理提醒',
      enabled: false,
    });
    expect(Object.isFrozen(current)).toBe(true);
    expect(automationCreateFeedbackKey(current)).toBe(
      JSON.stringify([newer.generation, WORKSPACE_A, AUTOMATION_A, '每日整理提醒', false]),
    );
    expect(() => coordinator.createFeedback(newer, workspace, item(), false)).toThrow(
      AutomationCreateSupersededError,
    );
    coordinator.endCreate(newer);
  });

  it('publishes recovered feedback only for the still-current create generation', () => {
    const firstA = createAutomationCreateWorkspaceIdentity(WORKSPACE_A);
    const coordinator = new AutomationCreateCoordinator();
    const created = item();
    const intent = coordinator.beginCreate(firstA);
    coordinator.endCreate(intent);

    expect(coordinator.createRecoveredFeedback(intent.generation, firstA, created, true)).toEqual({
      requestGeneration: intent.generation,
      workspaceId: WORKSPACE_A,
      createdAutomationId: created.id,
      name: created.name,
      enabled: created.enabled,
    });
    expect(() =>
      coordinator.createRecoveredFeedback(intent.generation, firstA, created, false),
    ).toThrow(AutomationCreateSupersededError);
    expect(() =>
      coordinator.createRecoveredFeedback(
        intent.generation,
        createAutomationCreateWorkspaceIdentity(WORKSPACE_A),
        created,
        true,
      ),
    ).toThrow(AutomationCreateSupersededError);

    const newer = coordinator.beginCreate(firstA);
    expect(() =>
      coordinator.createRecoveredFeedback(intent.generation, firstA, created, true),
    ).toThrow(AutomationCreateSupersededError);
    coordinator.endCreate(newer);
  });

  it('keeps creation single-flight and ignores an old finally after replacement', () => {
    const firstA = createAutomationCreateWorkspaceIdentity(WORKSPACE_A);
    const secondA = createAutomationCreateWorkspaceIdentity(WORKSPACE_A);
    const coordinator = new AutomationCreateCoordinator();
    const first = coordinator.beginCreate(firstA);

    expect(() => coordinator.beginCreate(firstA)).toThrow(AutomationCreateInProgressError);
    coordinator.invalidate();
    const replacement = coordinator.beginCreate(secondA);
    coordinator.endCreate(first);
    expect(() => coordinator.beginCreate(secondA)).toThrow(AutomationCreateInProgressError);
    coordinator.endCreate(replacement);
    expect(() => coordinator.beginCreate(secondA)).not.toThrow();
  });

  it('rejects delayed creation after invalidation or an A to B to A activation cycle', () => {
    const firstA = createAutomationCreateWorkspaceIdentity(WORKSPACE_A);
    const secondA = createAutomationCreateWorkspaceIdentity(WORKSPACE_A);
    const coordinator = new AutomationCreateCoordinator();
    const intent = coordinator.beginCreate(firstA);

    expect(
      coordinator.isCreateCurrent(intent, createAutomationCreateWorkspaceIdentity(WORKSPACE_B)),
    ).toBe(false);
    expect(coordinator.isCreateCurrent(intent, secondA)).toBe(false);
    expect(() => coordinator.createFeedback(intent, secondA, item(), true)).toThrow(
      AutomationCreateSupersededError,
    );
    expect(coordinator.isCreateCurrent(intent, firstA)).toBe(true);

    coordinator.invalidate();
    expect(coordinator.isCreateCurrent(intent, firstA)).toBe(false);
    expect(() => coordinator.assertCreateCurrent(intent, firstA)).toThrow(
      AutomationCreateSupersededError,
    );
  });

  it('binds opening to the exact activation and every feedback field', () => {
    const firstA = createAutomationCreateWorkspaceIdentity(WORKSPACE_A);
    const secondA = createAutomationCreateWorkspaceIdentity(WORKSPACE_A);
    const coordinator = new AutomationCreateCoordinator();
    const current = publishedFeedback(coordinator, firstA);
    const intent = coordinator.beginOpen(firstA, current);

    expect(coordinator.isOpenCurrent(intent, firstA, current)).toBe(true);
    expect(coordinator.isOpenCurrent(intent, secondA, current)).toBe(false);
    for (const replacement of [
      { ...current, requestGeneration: current.requestGeneration + 1 },
      { ...current, workspaceId: WORKSPACE_B },
      { ...current, createdAutomationId: AUTOMATION_B },
      { ...current, name: '较新的名称' },
      { ...current, enabled: true },
    ]) {
      expect(coordinator.isOpenCurrent(intent, firstA, replacement)).toBe(false);
    }
    expect(sameAutomationCreateFeedback(current, { ...current })).toBe(true);
    expect(sameAutomationCreateFeedback(current, null)).toBe(false);
    expect(() =>
      coordinator.beginOpen(createAutomationCreateWorkspaceIdentity(WORKSPACE_B), current),
    ).toThrow(AutomationCreateSupersededError);
  });

  it('makes a newer create supersede old feedback and an open already in flight', () => {
    const workspace = createAutomationCreateWorkspaceIdentity(WORKSPACE_A);
    const coordinator = new AutomationCreateCoordinator();
    const original = publishedFeedback(coordinator, workspace);
    const openIntent = coordinator.beginOpen(workspace, original);
    const newerCreate = coordinator.beginCreate(workspace);

    expect(coordinator.isFeedbackCurrent(workspace, original, original)).toBe(false);
    expect(coordinator.isOpenCurrent(openIntent, workspace, original)).toBe(false);
    expect(() => coordinator.assertOpenCurrent(openIntent, workspace, original)).toThrow(
      AutomationCreateSupersededError,
    );

    const newer = coordinator.createFeedback(
      newerCreate,
      workspace,
      item({ id: AUTOMATION_B, name: '较新的自动化' }),
      true,
    );
    expect(newer.requestGeneration).toBeGreaterThan(original.requestGeneration);
    expect(coordinator.isFeedbackCurrent(workspace, newer, newer)).toBe(true);
    coordinator.endCreate(newerCreate);
  });

  it('cancels only an in-flight open and keeps current feedback reusable', () => {
    const workspace = createAutomationCreateWorkspaceIdentity(WORKSPACE_A);
    const coordinator = new AutomationCreateCoordinator();
    const current = publishedFeedback(coordinator, workspace);
    const originalOpen = coordinator.beginOpen(workspace, current);

    coordinator.cancelOpen();
    expect(coordinator.isOpenCurrent(originalOpen, workspace, current)).toBe(false);
    expect(coordinator.isFeedbackCurrent(workspace, current, current)).toBe(true);
    expect(() => coordinator.beginOpen(workspace, current)).not.toThrow();
  });

  it('dismisses only the complete current feedback and invalidates its open intent', () => {
    const workspace = createAutomationCreateWorkspaceIdentity(WORKSPACE_A);
    const coordinator = new AutomationCreateCoordinator();
    const current = publishedFeedback(coordinator, workspace);
    const intent = coordinator.beginOpen(workspace, current);

    expect(coordinator.dismiss({ ...current, name: '其他自动化' }, workspace, current)).toBe(false);
    expect(coordinator.isOpenCurrent(intent, workspace, current)).toBe(true);
    expect(coordinator.dismiss(current, workspace, current)).toBe(true);
    expect(coordinator.isOpenCurrent(intent, workspace, current)).toBe(false);
    expect(coordinator.dismiss(current, workspace, current)).toBe(false);
  });

  it('fresh-reads, commits, and returns the exact id at its current revision', async () => {
    const workspace = createAutomationCreateWorkspaceIdentity(WORKSPACE_A);
    const coordinator = new AutomationCreateCoordinator();
    const current = publishedFeedback(coordinator, workspace);
    const intent = coordinator.beginOpen(workspace, current);
    const commit = vi.fn(() => true);
    const readAutomation = vi.fn(async () =>
      refresh(
        snapshot({
          items: [
            item({
              id: AUTOMATION_B,
              name: current.name,
              enabled: current.enabled,
            }),
            item({
              id: AUTOMATION_A,
              name: '创建后已重命名',
              enabled: true,
              revision: 8,
              updatedAt: '2026-07-25T12:01:00.000Z',
            }),
          ],
        }),
        commit,
      ),
    );

    await expect(
      resolveAutomationCreateNavigationTarget(intent, readAutomation, () =>
        coordinator.assertOpenCurrent(intent, workspace, current),
      ),
    ).resolves.toMatchObject({
      workspaceId: WORKSPACE_A,
      item: {
        id: AUTOMATION_A,
        name: '创建后已重命名',
        enabled: true,
        revision: 8,
      },
    });
    expect(readAutomation).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledOnce();
  });

  it('never falls back by name, enabled state, timestamp, or list position when id is missing', async () => {
    const workspace = createAutomationCreateWorkspaceIdentity(WORKSPACE_A);
    const coordinator = new AutomationCreateCoordinator();
    const current = publishedFeedback(coordinator, workspace);
    const intent = coordinator.beginOpen(workspace, current);
    const commit = vi.fn(() => true);

    await expect(
      resolveAutomationCreateNavigationTarget(
        intent,
        async () =>
          refresh(
            snapshot({
              items: [
                item({
                  id: AUTOMATION_B,
                  name: current.name,
                  enabled: current.enabled,
                  createdAt: '2026-07-25T12:00:00.000Z',
                  updatedAt: '2026-07-25T12:00:00.000Z',
                }),
              ],
            }),
            commit,
          ),
        () => coordinator.assertOpenCurrent(intent, workspace, current),
      ),
    ).rejects.toBeInstanceOf(AutomationCreateUnavailableError);
    expect(commit).not.toHaveBeenCalled();
  });

  it('treats duplicate ids, a wrong workspace, and commit=false as unavailable', async () => {
    const workspace = createAutomationCreateWorkspaceIdentity(WORKSPACE_A);
    const coordinator = new AutomationCreateCoordinator();
    const current = publishedFeedback(coordinator, workspace);
    const intent = coordinator.beginOpen(workspace, current);
    const assertCurrent = () => coordinator.assertOpenCurrent(intent, workspace, current);
    const duplicateCommit = vi.fn(() => true);
    const wrongWorkspaceCommit = vi.fn(() => true);

    await expect(
      resolveAutomationCreateNavigationTarget(
        intent,
        async () =>
          refresh(
            snapshot({
              items: [item(), item({ name: '重复 ID 的损坏记录' })],
            }),
            duplicateCommit,
          ),
        assertCurrent,
      ),
    ).rejects.toBeInstanceOf(AutomationCreateUnavailableError);
    expect(duplicateCommit).not.toHaveBeenCalled();

    await expect(
      resolveAutomationCreateNavigationTarget(
        intent,
        async () => refresh(snapshot({ workspaceId: WORKSPACE_B }), wrongWorkspaceCommit),
        assertCurrent,
      ),
    ).rejects.toBeInstanceOf(AutomationCreateUnavailableError);
    expect(wrongWorkspaceCommit).not.toHaveBeenCalled();

    const rejectedCommit = vi.fn(() => false);
    await expect(
      resolveAutomationCreateNavigationTarget(
        intent,
        async () => refresh(snapshot(), rejectedCommit),
        assertCurrent,
      ),
    ).rejects.toBeInstanceOf(AutomationCreateUnavailableError);
    expect(rejectedCommit).toHaveBeenCalledOnce();
  });

  it('rejects a delayed read after A to B to A, dismiss, or a newer create', async () => {
    const firstA = createAutomationCreateWorkspaceIdentity(WORKSPACE_A);
    const coordinator = new AutomationCreateCoordinator();
    const current = publishedFeedback(coordinator, firstA);
    const intent = coordinator.beginOpen(firstA, current);
    let currentWorkspace: AutomationCreateWorkspaceIdentity = firstA;
    let currentFeedback: AutomationCreateFeedback | null = current;
    let release!: (value: AutomationCreateSnapshotRefresh) => void;
    const delayed = new Promise<AutomationCreateSnapshotRefresh>((resolve) => {
      release = resolve;
    });
    const commit = vi.fn(() => true);
    const resolution = resolveAutomationCreateNavigationTarget(
      intent,
      () => delayed,
      () => coordinator.assertOpenCurrent(intent, currentWorkspace, currentFeedback),
    );

    currentWorkspace = createAutomationCreateWorkspaceIdentity(WORKSPACE_B);
    currentWorkspace = createAutomationCreateWorkspaceIdentity(WORKSPACE_A);
    currentFeedback = null;
    coordinator.beginCreate(currentWorkspace);
    release(refresh(snapshot(), commit));

    await expect(resolution).rejects.toBeInstanceOf(AutomationCreateSupersededError);
    expect(commit).not.toHaveBeenCalled();
  });

  it('does not return a target when state changes during the authoritative commit', async () => {
    const workspace = createAutomationCreateWorkspaceIdentity(WORKSPACE_A);
    const coordinator = new AutomationCreateCoordinator();
    const current = publishedFeedback(coordinator, workspace);
    const intent = coordinator.beginOpen(workspace, current);
    let currentFeedback: AutomationCreateFeedback | null = current;
    const commit = vi.fn(() => {
      currentFeedback = null;
      coordinator.invalidate();
      return true;
    });

    await expect(
      resolveAutomationCreateNavigationTarget(
        intent,
        async () => refresh(snapshot(), commit),
        () => coordinator.assertOpenCurrent(intent, workspace, currentFeedback),
      ),
    ).rejects.toBeInstanceOf(AutomationCreateSupersededError);
    expect(commit).toHaveBeenCalledOnce();
  });

  it('gates duplicate opens without letting a late end release a replacement lease', () => {
    const original = feedback();
    const equalReplacement = { ...original };
    const newer = feedback({
      requestGeneration: original.requestGeneration + 1,
      createdAutomationId: AUTOMATION_B,
    });
    const gate = new AutomationCreateOpenGate();

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
      createdAutomationId: AUTOMATION_B,
      name: '较新的自动化',
      enabled: true,
    });
    const originalState = automationCreateOpenStarted(original);
    const newerState = automationCreateOpenStarted(newer);

    expect(automationCreateFeedbackKey(original)).not.toBe(automationCreateFeedbackKey(newer));
    expect(
      automationCreateOpenFailed(originalState, original, '打开失败', 'original-error'),
    ).toEqual({
      feedbackKey: automationCreateFeedbackKey(original),
      opening: false,
      error: '打开失败',
      errorFocusKey: 'original-error',
    });
    expect(automationCreateOpenFailed(newerState, original, '旧失败', 'stale-error')).toBe(
      newerState,
    );
    expect(automationCreateOpenFinished(newerState, original)).toBe(newerState);
    expect(automationCreateOpenFinished(newerState, newer)).toEqual({
      feedbackKey: automationCreateFeedbackKey(newer),
      opening: false,
      error: null,
      errorFocusKey: null,
    });
  });

  it('preserves typed failures and bounds unknown remote errors', () => {
    const superseded = new AutomationCreateSupersededError();
    const inProgress = new AutomationCreateInProgressError();
    const draftPreserved = new AutomationCreateNoteDraftPreservedError();
    const unavailable = new AutomationCreateUnavailableError();
    expect(superseded.message).toMatch(/新建自动化/u);
    expect(inProgress.message).toMatch(/创建/u);
    expect(draftPreserved.message).toMatch(/未保存/u);
    expect(unavailable.message).toMatch(/自动化/u);
    expect(automationCreateNavigationError(superseded)).toBe(superseded);
    expect(automationCreateNavigationError(draftPreserved)).toBe(draftPreserved);
    expect(automationCreateNavigationError(unavailable)).toBe(unavailable);
    const refreshFailure = new AutomationCreateSyncRefreshError('安全的重新读取失败提示');
    expect(automationCreateSyncRefreshError(superseded)).toBe(superseded);
    expect(automationCreateSyncRefreshError(refreshFailure)).toBe(refreshFailure);

    for (const remote of [
      new Error(
        "Error invoking remote method 'automation:get-snapshot': 数据不可用；token=secret-key",
      ),
      new Error('自动化不存在；数据库路径=/secret/workspace.db'),
      new Error('secret provider details'),
    ]) {
      const bounded = automationCreateNavigationError(remote);
      expect(bounded.message).toBe('无法打开刚创建的自动化，请重试。');
      expect(bounded.message).not.toContain('secret');
      expect(bounded.cause).toBe(remote);

      const boundedRefresh = automationCreateSyncRefreshError(remote);
      expect(boundedRefresh.message).toBe(
        '自动化列表仍无法安全确认。请稍后重新读取；规则可能已经创建，请不要重复创建。',
      );
      expect(boundedRefresh.message).not.toMatch(/secret|token|workspace\.db/u);
      expect(boundedRefresh.cause).toBeUndefined();
    }
  });
});

function publishedFeedback(
  coordinator: AutomationCreateCoordinator,
  workspace: AutomationCreateWorkspaceIdentity,
): AutomationCreateFeedback {
  const intent = coordinator.beginCreate(workspace);
  const current = coordinator.createFeedback(intent, workspace, item(), true);
  coordinator.endCreate(intent);
  return current;
}

function feedback(overrides: Partial<AutomationCreateFeedback> = {}): AutomationCreateFeedback {
  return Object.freeze({
    requestGeneration: 7,
    workspaceId: WORKSPACE_A,
    createdAutomationId: AUTOMATION_A,
    name: '每日整理提醒',
    enabled: false,
    ...overrides,
  });
}

function item(overrides: Partial<AutomationItem> = {}): AutomationItem {
  return {
    id: AUTOMATION_A,
    name: '每日整理提醒',
    enabled: false,
    schedule: {
      cadence: 'daily',
      localTimeMinute: 540,
      weekday: null,
    },
    action: {
      kind: 'create-today-task',
      title: '整理发布清单',
    },
    revision: 1,
    nextRunAt: null,
    lastRun: { status: 'never' },
    createdAt: '2026-07-25T12:00:00.000Z',
    updatedAt: '2026-07-25T12:00:00.000Z',
    ...overrides,
  };
}

function snapshot(overrides: Partial<AutomationSnapshot> = {}): AutomationSnapshot {
  return {
    workspaceId: WORKSPACE_A,
    items: [item()],
    ...overrides,
  };
}

function refresh(
  automationSnapshot: AutomationSnapshot,
  commit: () => boolean = () => true,
): AutomationCreateSnapshotRefresh {
  return { snapshot: automationSnapshot, commit };
}
