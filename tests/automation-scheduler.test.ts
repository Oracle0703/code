import { describe, expect, it, vi } from 'vitest';
import {
  AutomationScheduler,
  type AutomationSchedulerTimer,
} from '../src/main/automations/automation-scheduler';
import type { StoredAutomation } from '../src/main/automations/automation-repository';

const NOW = new Date(2026, 6, 23, 12, 0, 0);

describe('AutomationScheduler', () => {
  it('rejects an explicitly invalid wake interval', () => {
    expect(
      () =>
        new AutomationScheduler({
          store: {
            readSchedulerEntries: vi.fn(async () => []),
            runOccurrence: vi.fn(),
          },
          maximumWakeDelayMs: 0,
        }),
    ).toThrow(/wake interval/u);
  });

  it('single-flights concurrent evaluation and runs a due occurrence once', async () => {
    let release!: (entries: readonly StoredAutomation[]) => void;
    const firstRead = new Promise<readonly StoredAutomation[]>((resolve) => {
      release = resolve;
    });
    const readSchedulerEntries = vi
      .fn()
      .mockReturnValueOnce(firstRead)
      .mockResolvedValue([completedAutomation()]);
    const runOccurrence = vi.fn(async () => ({
      status: 'success' as const,
      workspaceId: WORKSPACE_ID,
      outputKind: 'task' as const,
    }));
    const timer = createTimer();
    const scheduler = new AutomationScheduler({
      store: { readSchedulerEntries, runOccurrence },
      now: () => NOW,
      timer,
    });

    const first = scheduler.start();
    const second = scheduler.evaluate();
    release([dueAutomation()]);
    await Promise.all([first, second]);

    expect(readSchedulerEntries).toHaveBeenCalledTimes(2);
    expect(runOccurrence).toHaveBeenCalledTimes(1);
    expect(runOccurrence).toHaveBeenCalledWith({
      automationId: AUTOMATION_ID,
      expectedRevision: 2,
      occurrenceDate: '2026-07-23',
      scheduledFor: new Date(2026, 6, 23, 8, 30, 0).toISOString(),
    });
    expect(timer.set).toHaveBeenCalledTimes(1);
    await scheduler.stop();
  });

  it('invalidates an in-flight generation before stop waits for it', async () => {
    let release!: (entries: readonly StoredAutomation[]) => void;
    const read = new Promise<readonly StoredAutomation[]>((resolve) => {
      release = resolve;
    });
    const runOccurrence = vi.fn();
    const timer = createTimer();
    const scheduler = new AutomationScheduler({
      store: {
        readSchedulerEntries: vi.fn(() => read),
        runOccurrence,
      },
      now: () => NOW,
      timer,
    });

    const starting = scheduler.start();
    const stopping = scheduler.stop();
    release([dueAutomation()]);
    await Promise.all([starting, stopping]);

    expect(runOccurrence).not.toHaveBeenCalled();
    expect(timer.set).not.toHaveBeenCalled();
  });

  it('caps a wake at ten committed actions and schedules the remaining batch', async () => {
    const entries = Array.from({ length: 11 }, (_, index) =>
      dueAutomation(`${String(index).padStart(8, '0')}-1111-4111-8111-111111111111`),
    );
    const timer = createTimer();
    const scheduler = new AutomationScheduler({
      store: {
        readSchedulerEntries: vi.fn(async () => entries),
        runOccurrence: vi.fn(async () => ({
          status: 'success' as const,
          workspaceId: WORKSPACE_ID,
          outputKind: 'task' as const,
        })),
      },
      now: () => NOW,
      timer,
    });

    await scheduler.start();
    expect(timer.set).toHaveBeenCalledWith(expect.any(Function), 1_000);
    await scheduler.stop();
  });

  it('backs off for the full wake interval when persistent writes fail', async () => {
    const runOccurrence = vi.fn(async () => {
      throw new Error('database is full');
    });
    const timer = createTimer();
    const scheduler = new AutomationScheduler({
      store: {
        readSchedulerEntries: vi.fn(async () => [dueAutomation()]),
        runOccurrence,
      },
      now: () => NOW,
      timer,
      maximumWakeDelayMs: 60_000,
    });

    await scheduler.start();

    expect(runOccurrence).toHaveBeenCalledTimes(1);
    expect(timer.set).toHaveBeenCalledTimes(1);
    expect(timer.set).toHaveBeenCalledWith(expect.any(Function), 60_000);
    await scheduler.stop();
  });
});

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const AUTOMATION_ID = '22222222-2222-4222-8222-222222222222';

function dueAutomation(id = AUTOMATION_ID): StoredAutomation {
  return {
    id,
    workspaceId: WORKSPACE_ID,
    name: '每日计划',
    enabled: true,
    effectiveAt: '2026-07-01T00:00:00.000Z',
    schedule: { cadence: 'daily', localTimeMinute: 8 * 60 + 30, weekday: null },
    action: { kind: 'create-today-task', title: '检查今日计划' },
    revision: 2,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    archivedAt: null,
    runState: {
      lastAttemptAt: null,
      lastAttemptOccurrence: null,
      lastSuccessAt: null,
      lastSuccessOccurrence: null,
      lastOutputKind: null,
      lastErrorCode: null,
      consecutiveFailures: 0,
      nextRetryAt: null,
      updatedAt: '2026-07-01T00:00:00.000Z',
    },
  };
}

function completedAutomation(): StoredAutomation {
  const automation = dueAutomation();
  return {
    ...automation,
    runState: {
      lastAttemptAt: NOW.toISOString(),
      lastAttemptOccurrence: '2026-07-23',
      lastSuccessAt: NOW.toISOString(),
      lastSuccessOccurrence: '2026-07-23',
      lastOutputKind: 'task',
      lastErrorCode: null,
      consecutiveFailures: 0,
      nextRetryAt: null,
      updatedAt: NOW.toISOString(),
    },
  };
}

function createTimer(): AutomationSchedulerTimer & {
  readonly set: ReturnType<typeof vi.fn>;
  readonly clear: ReturnType<typeof vi.fn>;
} {
  return {
    set: vi.fn(() => 1),
    clear: vi.fn(),
  };
}
