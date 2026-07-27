import { describe, expect, it, vi } from 'vitest';
import {
  archivedScheduleIsAbsent,
  createScheduleArchiveMutationIntent,
  createScheduleUpdateMutationIntent,
  reconcileScheduleArchiveResult,
  reconcileScheduleUpdateResult,
  ScheduleMutationResultUnavailableError,
  ScheduleMutationSnapshotCommitError,
  ScheduleMutationSupersededError,
  updatedScheduleFromSnapshot,
  type ScheduleArchiveMutationIntent,
  type ScheduleArchiveReconciliationInput,
  type ScheduleMutationSnapshotRefresh,
  type ScheduleUpdateMutationIntent,
  type ScheduleUpdateReconciliationInput,
} from '../src/renderer/schedule-state';
import type { ScheduleItem, ScheduleSnapshot } from '../src/shared/contracts';
import { createRollingPlanningDays } from '../src/shared/planning-domain';

const WORKSPACE_A = '11111111-1111-4111-8111-111111111111';
const WORKSPACE_B = '22222222-2222-4222-8222-222222222222';
const SCHEDULE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_SCHEDULE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const TODAY = '2026-07-27';
const TOMORROW = '2026-07-28';

describe('schedule mutation intents and exact snapshot identity', () => {
  it('normalizes update targets and predicts the exact committed revision', () => {
    const original = schedule();
    const intent = createScheduleUpdateMutationIntent(
      WORKSPACE_A,
      original,
      TODAY,
      '  更新日程  ',
      'meeting',
      600,
      660,
    );

    expect(intent).toEqual({
      kind: 'update',
      expectedWorkspaceId: WORKSPACE_A,
      expectedDate: TODAY,
      originalSchedule: original,
      title: '更新日程',
      scheduleKind: 'meeting',
      startMinute: 600,
      endMinute: 660,
      contentChanged: true,
      expectedCommittedRevision: original.revision + 1,
    });
    expect(Object.isFrozen(intent)).toBe(true);
    expect(Object.isFrozen(intent.originalSchedule)).toBe(true);
    expect(intent.originalSchedule).not.toBe(original);
  });

  it('treats normalization-only targets as a no-op without changing revision or updatedAt', () => {
    const original = schedule();
    const intent = createScheduleUpdateMutationIntent(
      WORKSPACE_A,
      original,
      TODAY,
      '  原日程  ',
      original.kind,
      original.startMinute,
      original.endMinute,
    );

    expect(intent.contentChanged).toBe(false);
    expect(intent.expectedCommittedRevision).toBe(original.revision);
    expect(updatedScheduleFromSnapshot(intent, snapshot([original]))).toBe(original);
    expect(
      updatedScheduleFromSnapshot(
        intent,
        snapshot([
          {
            ...original,
            revision: original.revision + 1,
            updatedAt: '2026-07-27T12:00:01.000Z',
          },
        ]),
      ),
    ).toBeNull();
    expect(
      updatedScheduleFromSnapshot(
        intent,
        snapshot([{ ...original, updatedAt: '2026-07-27T12:00:01.000Z' }]),
      ),
    ).toBeNull();
  });

  it('freezes a normalized archive identity bound to the expected date', () => {
    const original = schedule();
    const intent = createScheduleArchiveMutationIntent(WORKSPACE_A, original, TODAY);

    expect(intent).toEqual({
      kind: 'archive',
      expectedWorkspaceId: WORKSPACE_A,
      expectedDate: TODAY,
      originalSchedule: original,
    });
    expect(Object.isFrozen(intent)).toBe(true);
    expect(Object.isFrozen(intent.originalSchedule)).toBe(true);
    expect(intent.originalSchedule).not.toBe(original);
  });

  it('allows a no-op update at the maximum revision but rejects mutations that must increment it', () => {
    const maximumRevision = schedule({ revision: Number.MAX_SAFE_INTEGER });

    expect(() =>
      createScheduleUpdateMutationIntent(
        WORKSPACE_A,
        maximumRevision,
        TODAY,
        maximumRevision.title,
        maximumRevision.kind,
        maximumRevision.startMinute,
        maximumRevision.endMinute,
      ),
    ).not.toThrow();
    expect(() =>
      createScheduleUpdateMutationIntent(
        WORKSPACE_A,
        maximumRevision,
        TODAY,
        '更新日程',
        maximumRevision.kind,
        maximumRevision.startMinute,
        maximumRevision.endMinute,
      ),
    ).toThrow(TypeError);
    expect(() => createScheduleArchiveMutationIntent(WORKSPACE_A, maximumRevision, TODAY)).toThrow(
      TypeError,
    );
  });

  it.each([
    {
      name: 'an invalid workspace',
      run: () =>
        createScheduleUpdateMutationIntent(
          'not-a-workspace',
          schedule(),
          TODAY,
          '更新日程',
          'focus',
          540,
          600,
        ),
    },
    {
      name: 'an expected date different from the original',
      run: () =>
        createScheduleUpdateMutationIntent(
          WORKSPACE_A,
          schedule(),
          TOMORROW,
          '更新日程',
          'focus',
          540,
          600,
        ),
    },
    {
      name: 'an unnormalized original title',
      run: () =>
        createScheduleUpdateMutationIntent(
          WORKSPACE_A,
          schedule({ title: ' 原日程 ' }),
          TODAY,
          '更新日程',
          'focus',
          540,
          600,
        ),
    },
    {
      name: 'an invalid original range',
      run: () =>
        createScheduleUpdateMutationIntent(
          WORKSPACE_A,
          schedule({ startMinute: 600, endMinute: 600 }),
          TODAY,
          '更新日程',
          'focus',
          540,
          600,
        ),
    },
    {
      name: 'a non-exact original creation timestamp',
      run: () =>
        createScheduleUpdateMutationIntent(
          WORKSPACE_A,
          schedule({ createdAt: '2026-07-27T11:00:00Z' }),
          TODAY,
          '更新日程',
          'focus',
          540,
          600,
        ),
    },
    {
      name: 'a regressed original update timestamp',
      run: () =>
        createScheduleUpdateMutationIntent(
          WORKSPACE_A,
          schedule({ updatedAt: '2026-07-27T10:59:59.000Z' }),
          TODAY,
          '更新日程',
          'focus',
          540,
          600,
        ),
    },
    {
      name: 'an empty update title',
      run: () =>
        createScheduleUpdateMutationIntent(
          WORKSPACE_A,
          schedule(),
          TODAY,
          ' \n ',
          'focus',
          540,
          600,
        ),
    },
    {
      name: 'an invalid update range',
      run: () =>
        createScheduleUpdateMutationIntent(
          WORKSPACE_A,
          schedule(),
          TODAY,
          '更新日程',
          'focus',
          600,
          540,
        ),
    },
  ])('rejects $name', ({ run }) => {
    expect(run).toThrow(TypeError);
  });

  it.each([
    {
      name: 'missing exact id',
      candidate: (intent: ScheduleUpdateMutationIntent) =>
        snapshot([updatedSchedule(intent, { id: OTHER_SCHEDULE_ID })]),
    },
    {
      name: 'duplicate exact id',
      candidate: (intent: ScheduleUpdateMutationIntent) =>
        snapshot([updatedSchedule(intent), updatedSchedule(intent)]),
    },
    {
      name: 'wrong workspace',
      candidate: (intent: ScheduleUpdateMutationIntent) =>
        snapshot([updatedSchedule(intent)], { workspaceId: WORKSPACE_B }),
    },
    {
      name: 'target outside the snapshot window',
      candidate: (intent: ScheduleUpdateMutationIntent) =>
        snapshot([updatedSchedule(intent)], { todayDate: TOMORROW }),
    },
    {
      name: 'wrong scheduled date',
      candidate: (intent: ScheduleUpdateMutationIntent) =>
        snapshot([updatedSchedule(intent, { scheduledFor: TOMORROW })]),
    },
    {
      name: 'drifted creation identity',
      candidate: (intent: ScheduleUpdateMutationIntent) =>
        snapshot([updatedSchedule(intent, { createdAt: '2026-07-27T11:00:01.000Z' })]),
    },
    {
      name: 'wrong title',
      candidate: (intent: ScheduleUpdateMutationIntent) =>
        snapshot([updatedSchedule(intent, { title: '错误标题' })]),
    },
    {
      name: 'wrong schedule kind',
      candidate: (intent: ScheduleUpdateMutationIntent) =>
        snapshot([updatedSchedule(intent, { kind: 'personal' })]),
    },
    {
      name: 'wrong start minute',
      candidate: (intent: ScheduleUpdateMutationIntent) =>
        snapshot([updatedSchedule(intent, { startMinute: intent.startMinute + 1 })]),
    },
    {
      name: 'wrong end minute',
      candidate: (intent: ScheduleUpdateMutationIntent) =>
        snapshot([updatedSchedule(intent, { endMinute: intent.endMinute + 1 })]),
    },
    {
      name: 'wrong revision',
      candidate: (intent: ScheduleUpdateMutationIntent) =>
        snapshot([updatedSchedule(intent, { revision: intent.expectedCommittedRevision + 1 })]),
    },
    {
      name: 'regressed update timestamp',
      candidate: (intent: ScheduleUpdateMutationIntent) =>
        snapshot([updatedSchedule(intent, { updatedAt: '2026-07-27T11:59:59.999Z' })]),
    },
    {
      name: 'non-exact update timestamp',
      candidate: (intent: ScheduleUpdateMutationIntent) =>
        snapshot([updatedSchedule(intent, { updatedAt: '2026-07-27T12:00:01Z' })]),
    },
  ])('rejects an updated schedule with $name', ({ candidate }) => {
    const intent = updateIntent();
    expect(updatedScheduleFromSnapshot(intent, candidate(intent))).toBeNull();
  });

  it('accepts exactly one target item while ignoring unrelated items', () => {
    const intent = updateIntent();
    const exact = updatedSchedule(intent);

    expect(
      updatedScheduleFromSnapshot(intent, snapshot([schedule({ id: OTHER_SCHEDULE_ID }), exact])),
    ).toBe(exact);
  });

  it('accepts a changed update with an equal, exact, monotonic timestamp', () => {
    const intent = updateIntent();
    const exact = updatedSchedule(intent, { updatedAt: intent.originalSchedule.updatedAt });

    expect(updatedScheduleFromSnapshot(intent, snapshot([exact]))).toBe(exact);
  });

  it('confirms archive absence only while the target date is in the exact workspace window', () => {
    const intent = archiveIntent();

    expect(archivedScheduleIsAbsent(intent, snapshot([schedule({ id: OTHER_SCHEDULE_ID })]))).toBe(
      true,
    );
    expect(archivedScheduleIsAbsent(intent, snapshot([], { workspaceId: WORKSPACE_B }))).toBe(
      false,
    );
    expect(archivedScheduleIsAbsent(intent, snapshot([], { todayDate: TOMORROW }))).toBe(false);
    expect(archivedScheduleIsAbsent(intent, snapshot([schedule()]))).toBe(false);
    expect(archivedScheduleIsAbsent(intent, snapshot([schedule({ scheduledFor: TOMORROW })]))).toBe(
      false,
    );
    expect(archivedScheduleIsAbsent(intent, snapshot([], { todayDate: 'not-a-date' }))).toBe(false);
  });

  it('confirms absence for a future target only when it remains in the rolling window', () => {
    const tomorrowIntent = archiveIntent({ scheduledFor: TOMORROW }, TOMORROW);
    const outsideWindowIntent = archiveIntent({ scheduledFor: '2026-08-03' }, '2026-08-03');

    expect(archivedScheduleIsAbsent(tomorrowIntent, snapshot([]))).toBe(true);
    expect(archivedScheduleIsAbsent(outsideWindowIntent, snapshot([]))).toBe(false);
  });
});

describe('schedule update reconciliation', () => {
  it('commits an exact Main response before consulting committed state or refreshing', async () => {
    const intent = updateIntent();
    const exact = updatedSchedule(intent);
    const commitResultSnapshot = vi.fn(() => true);
    const getCommittedSnapshot = vi.fn();
    const prepareSnapshotRefresh = vi.fn();

    await expect(
      reconcileScheduleUpdateResult(
        updateInput({
          intent,
          resultSnapshot: snapshot([exact]),
          commitResultSnapshot,
          getCommittedSnapshot,
          prepareSnapshotRefresh,
        }),
      ),
    ).resolves.toEqual({
      authoritativeSchedule: exact,
      committed: true,
      error: undefined,
    });
    expect(commitResultSnapshot).toHaveBeenCalledOnce();
    expect(getCommittedSnapshot).not.toHaveBeenCalled();
    expect(prepareSnapshotRefresh).not.toHaveBeenCalled();
  });

  it('uses an exact ref-backed snapshot after rejecting a malformed Main response', async () => {
    const intent = updateIntent();
    const exact = updatedSchedule(intent);
    const commitResultSnapshot = vi.fn();
    const prepareSnapshotRefresh = vi.fn();

    const result = await reconcileScheduleUpdateResult(
      updateInput({
        intent,
        resultSnapshot: snapshot([updatedSchedule(intent, { title: '错误标题' })]),
        commitResultSnapshot,
        getCommittedSnapshot: () => snapshot([exact]),
        prepareSnapshotRefresh,
      }),
    );

    expect(result.authoritativeSchedule).toBe(exact);
    expect(result.committed).toBe(true);
    expect(result.error).toBeInstanceOf(ScheduleMutationResultUnavailableError);
    expect(commitResultSnapshot).not.toHaveBeenCalled();
    expect(prepareSnapshotRefresh).not.toHaveBeenCalled();
  });

  it('survives ref and first-refresh failures, then commits the second exact refresh', async () => {
    const intent = updateIntent();
    const exact = updatedSchedule(intent);
    const secondCommit = vi.fn(() => true);
    const prepareSnapshotRefresh = vi
      .fn()
      .mockRejectedValueOnce(new Error('first authoritative read failed'))
      .mockResolvedValueOnce(refresh(snapshot([exact]), secondCommit));

    const result = await reconcileScheduleUpdateResult(
      updateInput({
        intent,
        resultSnapshot: snapshot([]),
        getCommittedSnapshot: () => {
          throw new Error('committed ref read failed');
        },
        prepareSnapshotRefresh,
      }),
    );

    expect(result.authoritativeSchedule).toBe(exact);
    expect(result.committed).toBe(true);
    expect(prepareSnapshotRefresh).toHaveBeenCalledTimes(2);
    expect(secondCommit).toHaveBeenCalledOnce();
  });

  it('fails closed after exactly two exact snapshots cannot be committed', async () => {
    const intent = updateIntent();
    const exact = updatedSchedule(intent);
    const responseCommit = vi.fn(() => false);
    const refreshCommits = [vi.fn(() => false), vi.fn(() => false)] as const;
    const getCommittedSnapshot = vi.fn(() => null);
    const prepareSnapshotRefresh = vi
      .fn()
      .mockResolvedValueOnce(refresh(snapshot([exact]), refreshCommits[0]))
      .mockResolvedValueOnce(refresh(snapshot([exact]), refreshCommits[1]));

    const result = await reconcileScheduleUpdateResult(
      updateInput({
        intent,
        resultSnapshot: snapshot([exact]),
        commitResultSnapshot: responseCommit,
        getCommittedSnapshot,
        prepareSnapshotRefresh,
      }),
    );

    expect(result).toEqual({
      authoritativeSchedule: null,
      committed: false,
      error: expect.any(ScheduleMutationSnapshotCommitError),
    });
    expect(responseCommit).toHaveBeenCalledOnce();
    expect(getCommittedSnapshot).toHaveBeenCalledTimes(2);
    expect(prepareSnapshotRefresh).toHaveBeenCalledTimes(2);
    expect(refreshCommits[0]).toHaveBeenCalledOnce();
    expect(refreshCommits[1]).toHaveBeenCalledOnce();
  });

  it('accepts an exact value from the bounded final ref check', async () => {
    const intent = updateIntent();
    const exact = updatedSchedule(intent);
    let committedChecks = 0;
    const prepareSnapshotRefresh = vi.fn(async () => refresh(snapshot([])));

    const result = await reconcileScheduleUpdateResult(
      updateInput({
        intent,
        resultSnapshot: snapshot([]),
        getCommittedSnapshot: () => {
          committedChecks += 1;
          return committedChecks === 2 ? snapshot([exact]) : null;
        },
        prepareSnapshotRefresh,
      }),
    );

    expect(result.authoritativeSchedule).toBe(exact);
    expect(result.committed).toBe(true);
    expect(committedChecks).toBe(2);
    expect(prepareSnapshotRefresh).toHaveBeenCalledTimes(2);
  });

  it('fails closed before touching snapshots when the intent is already superseded', async () => {
    const commitResultSnapshot = vi.fn();
    const getCommittedSnapshot = vi.fn();
    const prepareSnapshotRefresh = vi.fn();

    const result = await reconcileScheduleUpdateResult(
      updateInput({
        commitResultSnapshot,
        getCommittedSnapshot,
        prepareSnapshotRefresh,
        isCurrent: () => false,
      }),
    );

    expect(result).toEqual({
      authoritativeSchedule: null,
      committed: false,
      error: expect.any(ScheduleMutationSupersededError),
    });
    expect(commitResultSnapshot).not.toHaveBeenCalled();
    expect(getCommittedSnapshot).not.toHaveBeenCalled();
    expect(prepareSnapshotRefresh).not.toHaveBeenCalled();
  });

  it('fails closed when an awaited refresh supersedes the intent', async () => {
    const intent = updateIntent();
    let current = true;
    const commit = vi.fn(() => true);

    const result = await reconcileScheduleUpdateResult(
      updateInput({
        intent,
        resultSnapshot: snapshot([]),
        prepareSnapshotRefresh: async () => {
          current = false;
          return refresh(snapshot([updatedSchedule(intent)]), commit);
        },
        isCurrent: () => current,
      }),
    );

    expect(result).toEqual({
      authoritativeSchedule: null,
      committed: false,
      error: expect.any(ScheduleMutationSupersededError),
    });
    expect(commit).not.toHaveBeenCalled();
  });

  it('fails closed when a successful response commit supersedes the intent', async () => {
    const intent = updateIntent();
    let current = true;

    const result = await reconcileScheduleUpdateResult(
      updateInput({
        intent,
        resultSnapshot: snapshot([updatedSchedule(intent)]),
        commitResultSnapshot: () => {
          current = false;
          return true;
        },
        isCurrent: () => current,
      }),
    );

    expect(result).toEqual({
      authoritativeSchedule: null,
      committed: false,
      error: expect.any(ScheduleMutationSupersededError),
    });
  });

  it('checks currency after reading a ref-backed snapshot', async () => {
    const intent = updateIntent();
    let current = true;
    const prepareSnapshotRefresh = vi.fn();

    const result = await reconcileScheduleUpdateResult(
      updateInput({
        intent,
        resultSnapshot: snapshot([]),
        getCommittedSnapshot: () => {
          current = false;
          return snapshot([updatedSchedule(intent)]);
        },
        prepareSnapshotRefresh,
        isCurrent: () => current,
      }),
    );

    expect(result).toEqual({
      authoritativeSchedule: null,
      committed: false,
      error: expect.any(ScheduleMutationSupersededError),
    });
    expect(prepareSnapshotRefresh).not.toHaveBeenCalled();
  });

  it('reconciles a validated response after a newer post-target snapshot commits', async () => {
    const intent = updateIntent();
    const responseSchedule = updatedSchedule(intent);
    const rolloverCommit = vi.fn(() => true);
    const prepareSnapshotRefresh = vi.fn(async () =>
      refresh(snapshot([], { todayDate: TOMORROW }), rolloverCommit),
    );

    const result = await reconcileScheduleUpdateResult(
      updateInput({
        intent,
        resultSnapshot: snapshot([responseSchedule]),
        commitResultSnapshot: () => false,
        prepareSnapshotRefresh,
      }),
    );

    expect(result.authoritativeSchedule).toBe(responseSchedule);
    expect(result.committed).toBe(true);
    expect(result.error).toBeInstanceOf(ScheduleMutationSnapshotCommitError);
    expect(prepareSnapshotRefresh).toHaveBeenCalledOnce();
    expect(rolloverCommit).toHaveBeenCalledOnce();
  });

  it('accepts a newer post-target snapshot that is already ref-backed and committed', async () => {
    const intent = updateIntent();
    const responseSchedule = updatedSchedule(intent);
    const prepareSnapshotRefresh = vi.fn();

    const result = await reconcileScheduleUpdateResult(
      updateInput({
        intent,
        resultSnapshot: snapshot([responseSchedule]),
        commitResultSnapshot: () => false,
        getCommittedSnapshot: () => snapshot([], { todayDate: TOMORROW }),
        prepareSnapshotRefresh,
      }),
    );

    expect(result.authoritativeSchedule).toBe(responseSchedule);
    expect(result.committed).toBe(true);
    expect(prepareSnapshotRefresh).not.toHaveBeenCalled();
  });

  it('does not use rollover rescue when the Main response identity was invalid', async () => {
    const intent = updateIntent();
    const commits = [vi.fn(() => true), vi.fn(() => true)] as const;
    const prepareSnapshotRefresh = vi
      .fn()
      .mockResolvedValueOnce(refresh(snapshot([], { todayDate: TOMORROW }), commits[0]))
      .mockResolvedValueOnce(refresh(snapshot([], { todayDate: TOMORROW }), commits[1]));

    const result = await reconcileScheduleUpdateResult(
      updateInput({
        intent,
        resultSnapshot: snapshot([
          updatedSchedule(intent, { createdAt: '2026-07-27T11:00:01.000Z' }),
        ]),
        prepareSnapshotRefresh,
      }),
    );

    expect(result).toEqual({
      authoritativeSchedule: null,
      committed: false,
      error: expect.any(ScheduleMutationResultUnavailableError),
    });
    expect(prepareSnapshotRefresh).toHaveBeenCalledTimes(2);
    expect(commits[0]).not.toHaveBeenCalled();
    expect(commits[1]).not.toHaveBeenCalled();
  });

  it('requires rollover to be strictly past the target date and in the expected workspace', async () => {
    const intent = updateIntent();
    const commits = [vi.fn(() => true), vi.fn(() => true)] as const;
    const prepareSnapshotRefresh = vi
      .fn()
      .mockResolvedValueOnce(refresh(snapshot([]), commits[0]))
      .mockResolvedValueOnce(
        refresh(snapshot([], { workspaceId: WORKSPACE_B, todayDate: TOMORROW }), commits[1]),
      );

    const result = await reconcileScheduleUpdateResult(
      updateInput({
        intent,
        resultSnapshot: snapshot([updatedSchedule(intent)]),
        commitResultSnapshot: () => false,
        prepareSnapshotRefresh,
      }),
    );

    expect(result.committed).toBe(false);
    expect(result.authoritativeSchedule).toBeNull();
    expect(commits[0]).not.toHaveBeenCalled();
    expect(commits[1]).not.toHaveBeenCalled();
  });

  it('does not claim rollover reconciliation until the newer snapshot commits', async () => {
    const intent = updateIntent();
    const prepareSnapshotRefresh = vi.fn(async () =>
      refresh(snapshot([], { todayDate: TOMORROW }), () => false),
    );

    const result = await reconcileScheduleUpdateResult(
      updateInput({
        intent,
        resultSnapshot: snapshot([updatedSchedule(intent)]),
        commitResultSnapshot: () => false,
        prepareSnapshotRefresh,
      }),
    );

    expect(result).toEqual({
      authoritativeSchedule: null,
      committed: false,
      error: expect.any(ScheduleMutationSnapshotCommitError),
    });
    expect(prepareSnapshotRefresh).toHaveBeenCalledTimes(2);
  });
});

describe('schedule archive reconciliation', () => {
  it('confirms exact absence only after the Main response snapshot commits', async () => {
    const commitResultSnapshot = vi.fn(() => true);

    await expect(
      reconcileScheduleArchiveResult(
        archiveInput({
          resultSnapshot: snapshot([schedule({ id: OTHER_SCHEDULE_ID })]),
          commitResultSnapshot,
        }),
      ),
    ).resolves.toEqual({
      confirmed: true,
      committed: true,
      error: undefined,
    });
    expect(commitResultSnapshot).toHaveBeenCalledOnce();
  });

  it('rejects a present id and wrong-window absence without committing either', async () => {
    const intent = archiveIntent();
    const commits = [vi.fn(() => true), vi.fn(() => true), vi.fn(() => true)] as const;
    const prepareSnapshotRefresh = vi
      .fn()
      .mockResolvedValueOnce(refresh(snapshot([schedule()]), commits[1]))
      .mockResolvedValueOnce(refresh(snapshot([], { todayDate: TOMORROW }), commits[2]));

    const result = await reconcileScheduleArchiveResult(
      archiveInput({
        intent,
        resultSnapshot: snapshot([schedule()]),
        commitResultSnapshot: commits[0],
        getCommittedSnapshot: () => snapshot([schedule()]),
        prepareSnapshotRefresh,
      }),
    );

    expect(result.confirmed).toBe(false);
    expect(result.committed).toBe(false);
    expect(result.error).toBeInstanceOf(ScheduleMutationResultUnavailableError);
    expect(commits[0]).not.toHaveBeenCalled();
    expect(commits[1]).not.toHaveBeenCalled();
    expect(commits[2]).not.toHaveBeenCalled();
    expect(prepareSnapshotRefresh).toHaveBeenCalledTimes(2);
  });

  it('does not confirm an absent archive candidate whose commit returns false', async () => {
    const prepareSnapshotRefresh = vi.fn(async () => refresh(snapshot([]), () => false));

    const result = await reconcileScheduleArchiveResult(
      archiveInput({
        resultSnapshot: snapshot([]),
        commitResultSnapshot: () => false,
        prepareSnapshotRefresh,
      }),
    );

    expect(result).toEqual({
      confirmed: false,
      committed: false,
      error: expect.any(ScheduleMutationSnapshotCommitError),
    });
    expect(prepareSnapshotRefresh).toHaveBeenCalledTimes(2);
  });

  it('confirms archive absence from the bounded final committed ref check', async () => {
    let committedChecks = 0;
    const prepareSnapshotRefresh = vi.fn(async () => refresh(snapshot([schedule()])));

    const result = await reconcileScheduleArchiveResult(
      archiveInput({
        resultSnapshot: snapshot([schedule()]),
        getCommittedSnapshot: () => {
          committedChecks += 1;
          return committedChecks === 2 ? snapshot([]) : snapshot([schedule()]);
        },
        prepareSnapshotRefresh,
      }),
    );

    expect(result.confirmed).toBe(true);
    expect(result.committed).toBe(true);
    expect(committedChecks).toBe(2);
    expect(prepareSnapshotRefresh).toHaveBeenCalledTimes(2);
  });

  it('reconciles a validated archive response after a post-target snapshot commits', async () => {
    const rolloverCommit = vi.fn(() => true);
    const prepareSnapshotRefresh = vi.fn(async () =>
      refresh(snapshot([], { todayDate: TOMORROW }), rolloverCommit),
    );

    const result = await reconcileScheduleArchiveResult(
      archiveInput({
        resultSnapshot: snapshot([]),
        commitResultSnapshot: () => false,
        prepareSnapshotRefresh,
      }),
    );

    expect(result.confirmed).toBe(true);
    expect(result.committed).toBe(true);
    expect(rolloverCommit).toHaveBeenCalledOnce();
  });

  it('does not use rollover rescue for an invalid archive response', async () => {
    const commits = [vi.fn(() => true), vi.fn(() => true)] as const;
    const prepareSnapshotRefresh = vi
      .fn()
      .mockResolvedValueOnce(refresh(snapshot([], { todayDate: TOMORROW }), commits[0]))
      .mockResolvedValueOnce(refresh(snapshot([], { todayDate: TOMORROW }), commits[1]));

    const result = await reconcileScheduleArchiveResult(
      archiveInput({
        resultSnapshot: snapshot([], { workspaceId: WORKSPACE_B }),
        prepareSnapshotRefresh,
      }),
    );

    expect(result).toEqual({
      confirmed: false,
      committed: false,
      error: expect.any(ScheduleMutationResultUnavailableError),
    });
    expect(commits[0]).not.toHaveBeenCalled();
    expect(commits[1]).not.toHaveBeenCalled();
  });

  it('fails closed if rollover commit invalidates the request', async () => {
    let current = true;

    const result = await reconcileScheduleArchiveResult(
      archiveInput({
        resultSnapshot: snapshot([]),
        commitResultSnapshot: () => false,
        prepareSnapshotRefresh: async () =>
          refresh(snapshot([], { todayDate: TOMORROW }), () => {
            current = false;
            return true;
          }),
        isCurrent: () => current,
      }),
    );

    expect(result).toEqual({
      confirmed: false,
      committed: false,
      error: expect.any(ScheduleMutationSupersededError),
    });
  });
});

function updateIntent(originalOverrides: Partial<ScheduleItem> = {}): ScheduleUpdateMutationIntent {
  return createScheduleUpdateMutationIntent(
    WORKSPACE_A,
    schedule(originalOverrides),
    originalOverrides.scheduledFor ?? TODAY,
    '更新日程',
    'meeting',
    600,
    660,
  );
}

function archiveIntent(
  originalOverrides: Partial<ScheduleItem> = {},
  expectedDate = originalOverrides.scheduledFor ?? TODAY,
): ScheduleArchiveMutationIntent {
  return createScheduleArchiveMutationIntent(
    WORKSPACE_A,
    schedule(originalOverrides),
    expectedDate,
  );
}

function updatedSchedule(
  intent: ScheduleUpdateMutationIntent,
  overrides: Partial<ScheduleItem> = {},
): ScheduleItem {
  return {
    ...intent.originalSchedule,
    title: intent.title,
    kind: intent.scheduleKind,
    startMinute: intent.startMinute,
    endMinute: intent.endMinute,
    revision: intent.expectedCommittedRevision,
    updatedAt: intent.contentChanged
      ? '2026-07-27T12:00:01.000Z'
      : intent.originalSchedule.updatedAt,
    ...overrides,
  };
}

function schedule(overrides: Partial<ScheduleItem> = {}): ScheduleItem {
  return {
    id: SCHEDULE_ID,
    title: '原日程',
    kind: 'focus',
    scheduledFor: TODAY,
    startMinute: 540,
    endMinute: 600,
    revision: 3,
    createdAt: '2026-07-27T11:00:00.000Z',
    updatedAt: '2026-07-27T12:00:00.000Z',
    ...overrides,
  };
}

function snapshot(
  items: readonly ScheduleItem[],
  {
    workspaceId = WORKSPACE_A,
    todayDate = TODAY,
  }: {
    readonly workspaceId?: string;
    readonly todayDate?: string;
  } = {},
): ScheduleSnapshot {
  return {
    workspaceId,
    todayDate,
    planningDays: todayDate === 'not-a-date' ? [] : createRollingPlanningDays(todayDate),
    items,
  };
}

function refresh(
  candidate: ScheduleSnapshot,
  commit: () => boolean = () => true,
): ScheduleMutationSnapshotRefresh {
  return { snapshot: candidate, commit };
}

function updateInput(
  overrides: Partial<ScheduleUpdateReconciliationInput> = {},
): ScheduleUpdateReconciliationInput {
  const intent = updateIntent();
  return {
    intent,
    resultSnapshot: snapshot([updatedSchedule(intent)]),
    commitResultSnapshot: () => true,
    getCommittedSnapshot: () => null,
    prepareSnapshotRefresh: async () => refresh(snapshot([])),
    isCurrent: () => true,
    ...overrides,
  };
}

function archiveInput(
  overrides: Partial<ScheduleArchiveReconciliationInput> = {},
): ScheduleArchiveReconciliationInput {
  return {
    intent: archiveIntent(),
    resultSnapshot: snapshot([]),
    commitResultSnapshot: () => true,
    getCommittedSnapshot: () => null,
    prepareSnapshotRefresh: async () => refresh(snapshot([schedule()])),
    isCurrent: () => true,
    ...overrides,
  };
}
