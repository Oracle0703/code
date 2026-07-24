import { describe, expect, it, vi } from 'vitest';
import {
  FocusController,
  type FocusControllerDatabase,
  type FocusControllerTimer,
} from '../src/main/focus/focus-controller';
import { FocusOperationError } from '../src/main/focus/focus-errors';
import type { FocusChangedEvent, FocusSession, FocusSnapshot } from '../src/shared/contracts';

const WORKSPACE_A = '11111111-1111-4111-8111-111111111111';
const SESSION_A = '33333333-3333-4333-8333-333333333333';
const T0 = '2026-07-23T08:00:00.000Z';

describe('focus controller', () => {
  it('wakes no later than every sixty seconds and completes through timer reconciliation', async () => {
    let now = new Date(T0);
    const running = session('running', 1, 1_500, '2026-07-23T08:25:00.000Z');
    const reconcileResults = [
      { changed: false, changedWorkspaceId: null, session: running },
      { changed: true, changedWorkspaceId: WORKSPACE_A, session: null },
    ];
    const database = createDatabase({
      reconcileFocusSession: vi.fn(async () => reconcileResults.shift() ?? reconcileResults[1]!),
    });
    const timer = new ManualTimer();
    const changes: FocusChangedEvent[] = [];
    const controller = new FocusController({
      database,
      timer,
      now: () => new Date(now),
      onChanged: (event) => changes.push(event),
    });

    await controller.start();
    expect(timer.delayMs).toBe(60_000);
    now = new Date('2026-07-23T08:25:00.000Z');
    timer.fire();
    await vi.waitFor(() => expect(database.reconcileFocusSession).toHaveBeenCalledTimes(2));
    expect(timer.delayMs).toBeUndefined();
    expect(changes).toEqual([{ workspaceId: WORKSPACE_A, reason: 'timer' }]);
    await controller.stop();
  });

  it('invalidates a tracked cross-workspace session after an external archive', async () => {
    const running = session('running', 1, 1_500, '2026-07-23T08:25:00.000Z');
    const reconcileResults = [
      { changed: false, changedWorkspaceId: null, session: running },
      { changed: false, changedWorkspaceId: null, session: null },
    ];
    const changes: FocusChangedEvent[] = [];
    const timer = new ManualTimer();
    const controller = new FocusController({
      database: createDatabase({
        reconcileFocusSession: vi.fn(
          async () => reconcileResults.shift() ?? { ...reconcileResults[1]!, session: null },
        ),
      }),
      timer,
      onChanged: (event) => changes.push(event),
      now: () => new Date(T0),
    });

    await controller.start();
    expect(timer.delayMs).toBe(60_000);
    await controller.handleExternalChange();
    expect(timer.delayMs).toBeUndefined();
    expect(changes).toEqual([{ workspaceId: WORKSPACE_A, reason: 'external' }]);
    await controller.stop();
  });

  it('uses the absolute sub-second deadline without oversleeping and avoids invalid-clock loops', async () => {
    let now = new Date(T0);
    const timer = new ManualTimer();
    const errors: unknown[] = [];
    const database = createDatabase({
      reconcileFocusSession: vi.fn(async () => ({
        changed: false,
        changedWorkspaceId: null,
        session: session('running', 1, 1, '2026-07-23T08:00:00.250Z'),
      })),
    });
    const controller = new FocusController({
      database,
      timer,
      now: () => new Date(now),
      onError: (error) => errors.push(error),
    });
    await controller.start();
    expect(timer.delayMs).toBe(250);

    timer.clear(timer.callback);
    now = new Date(Number.NaN);
    await controller.evaluate();
    expect(timer.delayMs).toBeUndefined();
    expect(errors).toHaveLength(1);
    await controller.stop();
  });

  it('still pauses a running session after an in-flight evaluation rejects during stop', async () => {
    const running = session('running', 1, 1_500, '2026-07-23T08:25:00.000Z');
    const paused = session('paused', 2, 1_500, null);
    const failure = new Error('injected focus evaluation failure');
    let rejectEvaluation!: (reason: unknown) => void;
    const blockedEvaluation = new Promise<never>((_resolve, reject) => {
      rejectEvaluation = reject;
    });
    let evaluations = 0;
    const pauseRunningFocusSession = vi.fn(async () => ({
      changed: true,
      changedWorkspaceId: WORKSPACE_A,
      session: paused,
    }));
    const errors: unknown[] = [];
    const controller = new FocusController({
      database: createDatabase({
        reconcileFocusSession: vi.fn(async () => {
          evaluations += 1;
          if (evaluations === 1) {
            return { changed: false, changedWorkspaceId: null, session: running };
          }
          return blockedEvaluation;
        }),
        pauseRunningFocusSession,
      }),
      onError: (error) => errors.push(error),
      now: () => new Date(T0),
    });

    await controller.start();
    const evaluation = controller.evaluate();
    const evaluationRejected = expect(evaluation).rejects.toBe(failure);
    const stopping = controller.stop();
    expect(pauseRunningFocusSession).not.toHaveBeenCalled();

    rejectEvaluation(failure);
    await evaluationRejected;
    await expect(stopping).resolves.toBeUndefined();
    expect(errors).toEqual([failure]);
    expect(pauseRunningFocusSession).toHaveBeenCalledTimes(1);
  });

  it.each(['start', 'resume'] as const)(
    'closes acceptance before stop and pauses a late %s that becomes running',
    async (operation) => {
      const gate = deferred<FocusSnapshot>();
      let persistedStatus: 'paused' | 'running' | null = operation === 'resume' ? 'paused' : null;
      let revision = operation === 'resume' ? 2 : 0;
      const startFocusSession = vi.fn(async () => {
        const snapshot = await gate.promise;
        persistedStatus = 'running';
        revision = snapshot.session?.revision ?? revision;
        return snapshot;
      });
      const resumeFocusSession = vi.fn(async () => {
        const snapshot = await gate.promise;
        persistedStatus = 'running';
        revision = snapshot.session?.revision ?? revision;
        return snapshot;
      });
      const pauseRunningFocusSession = vi.fn(async () => {
        if (persistedStatus !== 'running') {
          return { changed: false, changedWorkspaceId: null, session: null };
        }
        persistedStatus = 'paused';
        revision += 1;
        return {
          changed: true,
          changedWorkspaceId: WORKSPACE_A,
          session: session('paused', revision, 1_500, null),
        };
      });
      const database = createDatabase({
        startFocusSession,
        resumeFocusSession,
        pauseRunningFocusSession,
        reconcileFocusSession: vi.fn(async () => ({
          changed: false,
          changedWorkspaceId: null,
          session: operation === 'resume' ? session('paused', 2, 1_500, null) : null,
        })),
      });
      const controller = new FocusController({ database, now: () => new Date(T0) });
      await controller.start();

      const late =
        operation === 'start'
          ? controller.startSession({ workspaceId: WORKSPACE_A })
          : controller.resumeSession({
              workspaceId: WORKSPACE_A,
              sessionId: SESSION_A,
              expectedRevision: 2,
            });
      const firstStop = controller.stop();
      const secondStop = controller.stop();
      expect(secondStop).toBe(firstStop);
      await expect(controller.startSession({ workspaceId: WORKSPACE_A })).rejects.toBeInstanceOf(
        FocusOperationError,
      );
      await expect(
        controller.resumeSession({
          workspaceId: WORKSPACE_A,
          sessionId: SESSION_A,
          expectedRevision: 2,
        }),
      ).rejects.toBeInstanceOf(FocusOperationError);
      expect(pauseRunningFocusSession).not.toHaveBeenCalled();

      gate.resolve(
        snapshot(
          session('running', operation === 'start' ? 1 : 3, 1_500, '2026-07-23T08:25:00.000Z'),
        ),
      );
      await late;
      await Promise.all([firstStop, secondStop]);
      expect(pauseRunningFocusSession).toHaveBeenCalledTimes(1);
      expect(persistedStatus).toBe('paused');
      expect(startFocusSession).toHaveBeenCalledTimes(operation === 'start' ? 1 : 0);
      expect(resumeFocusSession).toHaveBeenCalledTimes(operation === 'resume' ? 1 : 0);
    },
  );

  it('rejects snapshots and mutations outside the started lifecycle', async () => {
    const database = createDatabase();
    const controller = new FocusController({ database });
    await expect(controller.getSnapshot({ workspaceId: WORKSPACE_A })).rejects.toBeInstanceOf(
      FocusOperationError,
    );
    await expect(
      controller.cancelSession({
        workspaceId: WORKSPACE_A,
        sessionId: SESSION_A,
        expectedRevision: 1,
      }),
    ).rejects.toBeInstanceOf(FocusOperationError);

    await controller.start();
    await expect(controller.getSnapshot({ workspaceId: WORKSPACE_A })).resolves.toMatchObject({
      workspaceId: WORKSPACE_A,
      session: null,
    });
    await controller.stop();
    await expect(controller.getSnapshot({ workspaceId: WORKSPACE_A })).rejects.toBeInstanceOf(
      FocusOperationError,
    );
    expect(database.getFocusSnapshot).toHaveBeenCalledTimes(1);
  });
});

class ManualTimer implements FocusControllerTimer {
  callback: (() => void) | undefined;
  delayMs: number | undefined;

  set(callback: () => void, delayMs: number): unknown {
    this.callback = callback;
    this.delayMs = delayMs;
    return callback;
  }

  clear(handle: unknown): void {
    if (handle === this.callback) {
      this.callback = undefined;
      this.delayMs = undefined;
    }
  }

  fire(): void {
    const callback = this.callback;
    this.callback = undefined;
    this.delayMs = undefined;
    callback?.();
  }
}

function createDatabase(overrides: Partial<FocusControllerDatabase> = {}): FocusControllerDatabase {
  return {
    getFocusSnapshot: vi.fn(async ({ workspaceId }) => snapshot(null, workspaceId)),
    startFocusSession: vi.fn(async () =>
      snapshot(session('running', 1, 1_500, '2026-07-23T08:25:00.000Z')),
    ),
    pauseFocusSession: vi.fn(async () => snapshot(session('paused', 2, 1_500, null))),
    resumeFocusSession: vi.fn(async () =>
      snapshot(session('running', 3, 1_500, '2026-07-23T08:25:00.000Z')),
    ),
    cancelFocusSession: vi.fn(async () => snapshot(null)),
    reconcileFocusSession: vi.fn(async () => ({
      changed: false,
      changedWorkspaceId: null,
      session: null,
    })),
    pauseRunningFocusSession: vi.fn(async () => ({
      changed: false,
      changedWorkspaceId: null,
      session: null,
    })),
    ...overrides,
  };
}

function session(
  status: 'running' | 'paused',
  revision: number,
  remainingSeconds: number,
  deadlineAt: string | null,
): FocusSession {
  return {
    id: SESSION_A,
    workspaceId: WORKSPACE_A,
    workspaceName: '我的工作台',
    taskId: null,
    taskTitle: null,
    status,
    remainingSeconds,
    deadlineAt,
    revision,
    createdAt: T0,
    updatedAt: T0,
  };
}

function snapshot(focusSession: FocusSession | null, workspaceId = WORKSPACE_A): FocusSnapshot {
  return {
    workspaceId,
    todayDate: '2026-07-23',
    observedAt: T0,
    session: focusSession,
    todayCompletedCount: 0,
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
