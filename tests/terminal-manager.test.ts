import { describe, expect, it, vi } from 'vitest';
import type * as NodePty from 'node-pty';
import { TerminalManager } from '../src/main/terminal/terminal-manager';
import type {
  ResolvedTerminalLaunch,
  TerminalConfigurationServiceLike,
  TerminalConfigurationState,
  TerminalLaunchConfiguration,
} from '../src/main/terminal/terminal-configuration-service';
import type { ResolvedTerminalProfile } from '../src/main/terminal/terminal-profile-resolver';
import type {
  TerminalConfigurationSnapshot,
  TerminalDataEvent,
  TerminalExitEvent,
  TerminalProfileId,
  TerminalSnapshot,
} from '../src/shared/contracts';

const WORKSPACE_A = '11111111-1111-4111-8111-111111111111';
const WORKSPACE_B = '22222222-2222-4222-8222-222222222222';
const WORKSPACE_C = '33333333-3333-4333-8333-333333333333';
const PROCESS_SETTLE_TEST_WAIT_MS = 750;

describe('terminal manager', () => {
  it('keeps independent sessions, routes sequenced output, and restarts an exited tab in place', async () => {
    const harness = createHarness();
    let snapshot = await harness.manager.create({
      workspaceId: WORKSPACE_A,
      configurationRevision: 1,
      profileId: 'system-default',
    });
    const firstId = snapshot.activeSessionId;
    snapshot = await harness.manager.create({
      workspaceId: WORKSPACE_A,
      configurationRevision: 1,
      profileId: 'command-prompt',
    });
    const secondId = snapshot.activeSessionId;
    expect(firstId).not.toBeNull();
    expect(secondId).not.toBeNull();
    expect(secondId).not.toBe(firstId);
    expect(snapshot.sessions).toHaveLength(2);
    expect(snapshot.revision).toBe(2);

    const firstPty = harness.ptys[0]!;
    const secondPty = harness.ptys[1]!;
    firstPty.emitData('first');
    firstPty.emitData(' again');
    secondPty.emitData('second');
    expect(harness.dataEvents).toEqual([
      { workspaceId: WORKSPACE_A, sessionId: firstId, sequence: 1, data: 'first' },
      { workspaceId: WORKSPACE_A, sessionId: firstId, sequence: 2, data: ' again' },
      { workspaceId: WORKSPACE_A, sessionId: secondId, sequence: 1, data: 'second' },
    ]);

    harness.manager.write({
      workspaceId: WORKSPACE_A,
      sessionId: firstId!,
      data: 'echo ok\r',
    });
    harness.manager.resize({
      workspaceId: WORKSPACE_A,
      sessionId: firstId!,
      columns: 132,
      rows: 40,
    });
    harness.manager.clear({ workspaceId: WORKSPACE_A, sessionId: firstId! });
    expect(firstPty.write).toHaveBeenCalledExactlyOnceWith('echo ok\r');
    expect(firstPty.resize).toHaveBeenCalledExactlyOnceWith(132, 40);
    expect(firstPty.clear).toHaveBeenCalledTimes(1);

    firstPty.emitExit(7, 15);
    snapshot = harness.lastSnapshot(WORKSPACE_A);
    expect(snapshot.sessions.find(({ id }) => id === firstId)).toMatchObject({
      status: 'exited',
      exitCode: 7,
    });
    expect(harness.exitEvents).toEqual([
      {
        workspaceId: WORKSPACE_A,
        sessionId: firstId,
        exitCode: 7,
        signal: 15,
      },
    ]);
    expect(firstPty.kill).not.toHaveBeenCalled();
    expect(() =>
      harness.manager.write({
        workspaceId: WORKSPACE_A,
        sessionId: firstId!,
        data: 'late',
      }),
    ).toThrow('not running');

    snapshot = await harness.manager.restart({
      workspaceId: WORKSPACE_A,
      sessionId: firstId!,
    });
    expect(snapshot.activeSessionId).toBe(firstId);
    expect(snapshot.sessions.find(({ id }) => id === firstId)).toMatchObject({
      status: 'running',
    });
    expect(snapshot.sessions.find(({ id }) => id === firstId)).not.toHaveProperty('exitCode');
    expect(harness.ptys).toHaveLength(3);
    expect(harness.spawn.mock.calls[2]).toMatchObject(['/bin/sh', ['-l'], { cwd: '/home/tester' }]);

    snapshot = await harness.manager.close({
      workspaceId: WORKSPACE_A,
      sessionId: firstId!,
    });
    expect(snapshot.sessions.map(({ id }) => id)).toEqual([secondId]);
    expect(snapshot.activeSessionId).toBe(secondId);
    expect(secondPty.kill).not.toHaveBeenCalled();
  });

  it('cleans up a naturally exited Windows PTY before restarting its tab', async () => {
    const harness = createHarness({ platform: 'win32' });
    const initial = await harness.manager.create({
      workspaceId: WORKSPACE_A,
      configurationRevision: 1,
      profileId: 'system-default',
    });
    const sessionId = initial.activeSessionId!;
    const pty = harness.ptys[0]!;

    pty.emitExit(0);

    expect(pty.kill).toHaveBeenCalledTimes(1);
    expect(harness.exitEvents).toEqual([
      {
        workspaceId: WORKSPACE_A,
        sessionId,
        exitCode: 0,
      },
    ]);
    await expect(
      harness.manager.restart({ workspaceId: WORKSPACE_A, sessionId }),
    ).resolves.toMatchObject({
      activeSessionId: sessionId,
      sessions: [expect.objectContaining({ id: sessionId, status: 'running' })],
    });
    expect(harness.ptys).toHaveLength(2);
  });

  it('retries failed Windows post-exit cleanup before restarting the tab', async () => {
    const harness = createHarness({
      platform: 'win32',
      configurePty: (pty, index) => {
        if (index === 0) {
          pty.kill.mockImplementationOnce(() => {
            throw new Error('PTY already stopped');
          });
        }
      },
    });
    const initial = await harness.manager.create({
      workspaceId: WORKSPACE_A,
      configurationRevision: 1,
      profileId: 'system-default',
    });
    const sessionId = initial.activeSessionId!;
    const pty = harness.ptys[0]!;

    pty.emitExit(23);

    expect(pty.kill).toHaveBeenCalledTimes(1);
    expect(harness.lastSnapshot(WORKSPACE_A).sessions[0]).toMatchObject({
      id: sessionId,
      status: 'exited',
      exitCode: 23,
    });
    expect(harness.exitEvents).toEqual([
      {
        workspaceId: WORKSPACE_A,
        sessionId,
        exitCode: 23,
      },
    ]);
    await expect(
      harness.manager.restart({ workspaceId: WORKSPACE_A, sessionId }),
    ).resolves.toMatchObject({
      activeSessionId: sessionId,
      sessions: [expect.objectContaining({ id: sessionId, status: 'running' })],
    });
    expect(pty.kill).toHaveBeenCalledTimes(2);
    expect(harness.ptys).toHaveLength(2);
  });

  it('refuses to restart while Windows post-exit cleanup keeps failing', async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness({
        platform: 'win32',
        configurePty: (pty, index) => {
          if (index === 0) {
            pty.kill.mockImplementation(() => {
              throw new Error('ConPTY cleanup failed');
            });
          }
        },
      });
      const initial = await harness.manager.create({
        workspaceId: WORKSPACE_A,
        configurationRevision: 1,
        profileId: 'system-default',
      });
      const sessionId = initial.activeSessionId!;
      const pty = harness.ptys[0]!;
      pty.emitExit(31);

      const restart = harness.manager
        .restart({ workspaceId: WORKSPACE_A, sessionId })
        .catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(2_000);

      const error = await restart;
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('Unable to stop every terminal process');
      expect(pty.kill).toHaveBeenCalledTimes(3);
      expect(harness.spawn).toHaveBeenCalledTimes(1);
      expect(harness.lastSnapshot(WORKSPACE_A).sessions[0]).toMatchObject({
        id: sessionId,
        status: 'exited',
        exitCode: 31,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('allows only one restart when the same exited tab is restarted concurrently', async () => {
    const harness = createHarness();
    const initial = await harness.manager.create({
      workspaceId: WORKSPACE_A,
      configurationRevision: 1,
      profileId: 'system-default',
    });
    const sessionId = initial.activeSessionId!;
    harness.ptys[0]!.emitExit(0);

    const first = harness.manager.restart({ workspaceId: WORKSPACE_A, sessionId });
    const second = harness.manager.restart({ workspaceId: WORKSPACE_A, sessionId });
    const results = await Promise.allSettled([first, second]);

    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(({ status }) => status === 'rejected')).toHaveLength(1);
    expect(harness.ptys).toHaveLength(2);
    expect(
      (await harness.manager.getSnapshot({ workspaceId: WORKSPACE_A })).sessions[0],
    ).toMatchObject({ id: sessionId, status: 'running' });
  });

  it('blocks another restart after a failed spawn cannot release its PTY', async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness({
        configurePty: (pty, index) => {
          if (index === 0) return;
          pty.failDataSubscription = true;
          pty.kill.mockImplementation(() => {
            throw new Error('conpty teardown failed');
          });
        },
      });
      const initial = await harness.manager.create({
        workspaceId: WORKSPACE_A,
        configurationRevision: 1,
        profileId: 'system-default',
      });
      const sessionId = initial.activeSessionId!;
      harness.ptys[0]!.emitExit(0);

      await expect(
        harness.manager.restart({ workspaceId: WORKSPACE_A, sessionId }),
      ).rejects.toThrow('Unable to restart');
      const blockedRestart = harness.manager
        .restart({ workspaceId: WORKSPACE_A, sessionId })
        .catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(2_000);

      const error = await blockedRestart;
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('Unable to stop every terminal process');
      expect(harness.ptys).toHaveLength(2);
      expect(harness.spawn).toHaveBeenCalledTimes(2);
      expect(harness.ptys[1]!.kill).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('enforces active-workspace ownership while background output remains correctly attributed', async () => {
    const harness = createHarness();
    const snapshotA = await harness.manager.create({
      workspaceId: WORKSPACE_A,
      configurationRevision: 1,
      profileId: 'system-default',
    });
    const sessionA = snapshotA.activeSessionId!;
    const ptyA = harness.ptys[0]!;

    harness.manager.setActiveWorkspace(WORKSPACE_B);
    await expect(harness.manager.getSnapshot({ workspaceId: WORKSPACE_A })).rejects.toThrow(
      'active workspace',
    );
    expect(() =>
      harness.manager.write({
        workspaceId: WORKSPACE_A,
        sessionId: sessionA,
        data: 'forged',
      }),
    ).toThrow('active workspace');

    const snapshotB = await harness.manager.create({
      workspaceId: WORKSPACE_B,
      configurationRevision: 1,
      profileId: 'command-prompt',
    });
    const sessionB = snapshotB.activeSessionId!;
    const ptyB = harness.ptys[1]!;
    ptyA.emitData('background-a');
    expect(harness.dataEvents.at(-1)).toEqual({
      workspaceId: WORKSPACE_A,
      sessionId: sessionA,
      sequence: 1,
      data: 'background-a',
    });

    harness.manager.setActiveWorkspace(WORKSPACE_A);
    const restored = await harness.manager.getSnapshot({ workspaceId: WORKSPACE_A });
    expect(restored.sessions.map(({ id }) => id)).toEqual([sessionA]);
    expect(() =>
      harness.manager.resize({
        workspaceId: WORKSPACE_A,
        sessionId: sessionB,
        columns: 80,
        rows: 24,
      }),
    ).toThrow('not found in this workspace');

    harness.manager.setActiveWorkspace(WORKSPACE_B);
    harness.manager.discardWorkspace(WORKSPACE_A);
    expect(ptyA.kill).toHaveBeenCalledTimes(1);
    expect(ptyB.kill).not.toHaveBeenCalled();
    expect(harness.lastSnapshot(WORKSPACE_A)).toMatchObject({
      activeSessionId: null,
      sessions: [],
    });
    expect(await harness.manager.getSnapshot({ workspaceId: WORKSPACE_B })).toMatchObject({
      activeSessionId: sessionB,
      sessions: [{ id: sessionB }],
    });
  });

  it('rejects unavailable profiles before spawning and invalidates a create delayed by switching', async () => {
    const deferredLaunch = deferred<ResolvedTerminalLaunch>();
    const configurationService = createConfigurationService();
    configurationService.resolveLaunch = vi.fn(() => deferredLaunch.promise);
    const harness = createHarness({
      configurationService,
    });
    const pending = harness.manager.create({
      workspaceId: WORKSPACE_A,
      configurationRevision: 1,
      profileId: 'system-default',
    });
    harness.manager.setActiveWorkspace(WORKSPACE_B);
    deferredLaunch.resolve(resolvedLaunch('system-default'));
    await expect(pending).rejects.toThrow('active workspace');
    expect(harness.spawn).not.toHaveBeenCalled();

    const unavailableHarness = createHarness();
    await expect(
      unavailableHarness.manager.create({
        workspaceId: WORKSPACE_A,
        configurationRevision: 1,
        profileId: 'wsl-default',
      }),
    ).rejects.toThrow('未检测到可启动的 WSL 发行版');
    expect(unavailableHarness.spawn).not.toHaveBeenCalled();
  });

  it('enforces per-workspace and global limits without killing existing sessions', async () => {
    const harness = createHarness({ idCount: 20 });
    for (let index = 0; index < 8; index += 1) {
      await harness.manager.create({
        workspaceId: WORKSPACE_A,
        configurationRevision: 1,
        profileId: 'system-default',
      });
    }
    await expect(
      harness.manager.create({
        workspaceId: WORKSPACE_A,
        configurationRevision: 1,
        profileId: 'system-default',
      }),
    ).rejects.toThrow('at most 8');

    harness.manager.setActiveWorkspace(WORKSPACE_B);
    for (let index = 0; index < 8; index += 1) {
      await harness.manager.create({
        workspaceId: WORKSPACE_B,
        configurationRevision: 1,
        profileId: 'command-prompt',
      });
    }
    harness.manager.setActiveWorkspace(WORKSPACE_C);
    await expect(
      harness.manager.create({
        workspaceId: WORKSPACE_C,
        configurationRevision: 1,
        profileId: 'system-default',
      }),
    ).rejects.toThrow('at most 16');
    expect(harness.ptys.every((pty) => pty.kill.mock.calls.length === 0)).toBe(true);
  });

  it('drops late native events and attempts every teardown when one kill fails', async () => {
    const harness = createHarness();
    const first = await harness.manager.create({
      workspaceId: WORKSPACE_A,
      configurationRevision: 1,
      profileId: 'system-default',
    });
    const firstId = first.activeSessionId!;
    const second = await harness.manager.create({
      workspaceId: WORKSPACE_A,
      configurationRevision: 1,
      profileId: 'command-prompt',
    });
    const secondId = second.activeSessionId!;
    const firstPty = harness.ptys[0]!;
    const secondPty = harness.ptys[1]!;
    firstPty.kill.mockImplementationOnce(() => {
      throw new Error('already gone');
    });

    await expect(harness.manager.shutdown()).resolves.toBeUndefined();
    await expect(harness.manager.shutdown()).resolves.toBeUndefined();
    expect(firstPty.kill).toHaveBeenCalledTimes(2);
    expect(secondPty.kill).toHaveBeenCalledTimes(1);
    firstPty.emitData('late');
    firstPty.emitExit(0);
    secondPty.emitData('late');
    expect(harness.dataEvents).toEqual([]);
    expect(harness.exitEvents).toEqual([]);
    await expect(harness.manager.getSnapshot({ workspaceId: WORKSPACE_A })).rejects.toThrow(
      'shutting down',
    );
    expect(firstId).not.toBe(secondId);
  });

  it('retains a native handle after repeated kill failures and retries it during shutdown', async () => {
    const harness = createHarness();
    await harness.manager.create({
      workspaceId: WORKSPACE_A,
      configurationRevision: 1,
      profileId: 'system-default',
    });
    const pty = harness.ptys[0]!;
    pty.kill
      .mockImplementationOnce(() => {
        throw new Error('conpty temporarily busy');
      })
      .mockImplementationOnce(() => {
        throw new Error('conpty still busy');
      });

    harness.manager.setActiveWorkspace(WORKSPACE_B);
    expect(() => harness.manager.discardWorkspace(WORKSPACE_A)).not.toThrow();
    expect(pty.kill).toHaveBeenCalledTimes(2);

    await expect(harness.manager.shutdown()).resolves.toBeUndefined();
    expect(pty.kill).toHaveBeenCalledTimes(3);
  });

  it('splits oversized output into bounded ordered events without breaking surrogate pairs', async () => {
    const harness = createHarness();
    const snapshot = await harness.manager.create({
      workspaceId: WORKSPACE_A,
      configurationRevision: 1,
      profileId: 'system-default',
    });
    const firstChunk = 'x'.repeat(64 * 1024 - 1);
    const data = `${firstChunk}😀tail`;
    harness.ptys[0]!.emitData(data);

    expect(harness.dataEvents).toEqual([
      {
        workspaceId: WORKSPACE_A,
        sessionId: snapshot.activeSessionId,
        sequence: 1,
        data: firstChunk,
      },
      {
        workspaceId: WORKSPACE_A,
        sessionId: snapshot.activeSessionId,
        sequence: 2,
        data: '😀tail',
      },
    ]);
  });

  it('rejects late configuration reads after a newer preference update was published', async () => {
    const oldRead = deferred<TerminalConfigurationState>();
    const updated = deferred<TerminalConfigurationState>();
    const configurationService = createConfigurationService();
    configurationService.getState = vi.fn(() => oldRead.promise);
    configurationService.updateProfile = vi.fn(() => updated.promise);
    const harness = createHarness({ configurationService });

    const read = harness.manager.getSnapshot({ workspaceId: WORKSPACE_A });
    const update = harness.manager.updateProfile({
      workspaceId: WORKSPACE_A,
      profileId: 'command-prompt',
      expectedRevision: 1,
    });
    updated.resolve(configurationState(2, 1, 'command-prompt'));
    await expect(update).resolves.toMatchObject({
      configuration: { revision: 2, preferredProfileId: 'command-prompt' },
    });
    oldRead.resolve(configurationState(1, 1, 'system-default'));

    await expect(read).resolves.toMatchObject({
      configuration: { revision: 2, preferredProfileId: 'command-prompt' },
    });
    expect(harness.lastSnapshot(WORKSPACE_A)).toMatchObject({
      configuration: { revision: 2, preferredProfileId: 'command-prompt' },
    });
  });

  it('keeps a newer capability refresh when an older snapshot read completes late', async () => {
    const oldRead = deferred<TerminalConfigurationState>();
    const refreshed = deferred<TerminalConfigurationState>();
    const configurationService = createConfigurationService();
    configurationService.getState = vi.fn(() => oldRead.promise);
    configurationService.refreshCapabilities = vi.fn(() => refreshed.promise);
    const harness = createHarness({ configurationService });

    const read = harness.manager.getSnapshot({ workspaceId: WORKSPACE_A });
    const refresh = harness.manager.refreshCapabilities({ workspaceId: WORKSPACE_A });
    refreshed.resolve(configurationState(1, 2));
    await expect(refresh).resolves.toMatchObject({
      configuration: { wsl: { capabilityRevision: 2 } },
    });
    oldRead.resolve(configurationState(1, 1));
    await expect(read).resolves.toMatchObject({
      configuration: { wsl: { capabilityRevision: 2 } },
    });
  });

  it('uses request start order to reject a late read with the same version tuple', async () => {
    const firstRead = deferred<TerminalConfigurationState>();
    const configurationService = createConfigurationService();
    configurationService.getState = vi
      .fn()
      .mockImplementationOnce(() => firstRead.promise)
      .mockImplementationOnce(async () => ({
        ...CONFIGURATION_STATE,
        configuration: {
          ...CONFIGURATION,
          workingDirectory: {
            ...CONFIGURATION.workingDirectory,
            available: false,
            unavailableReason: 'temporarily unavailable',
          },
        },
      }));
    const harness = createHarness({ configurationService });

    const first = harness.manager.getSnapshot({ workspaceId: WORKSPACE_A });
    const second = harness.manager.getSnapshot({ workspaceId: WORKSPACE_A });
    await expect(second).resolves.toMatchObject({
      configuration: { workingDirectory: { available: false } },
    });
    firstRead.resolve(CONFIGURATION_STATE);
    await expect(first).resolves.toMatchObject({
      configuration: { workingDirectory: { available: false } },
    });
  });

  it('stops acceptance synchronously while a create is awaiting configuration', async () => {
    const pendingLaunch = deferred<ResolvedTerminalLaunch>();
    const configurationService = createConfigurationService();
    configurationService.resolveLaunch = vi.fn(() => pendingLaunch.promise);
    const harness = createHarness({ configurationService });
    const create = harness.manager.create({
      workspaceId: WORKSPACE_A,
      configurationRevision: 1,
    });

    const shutdown = harness.manager.shutdown();
    expect(configurationService.stop).toHaveBeenCalledTimes(1);
    expect(() =>
      harness.manager.write({
        workspaceId: WORKSPACE_A,
        sessionId: 'missing',
        data: 'late',
      }),
    ).toThrow('shutting down');
    pendingLaunch.resolve(resolvedLaunch('system-default'));

    await expect(create).rejects.toThrow('shutting down');
    await expect(shutdown).resolves.toBeUndefined();
    expect(harness.spawn).not.toHaveBeenCalled();
  });

  it('waits for native exit instead of treating a successful kill call as completion', async () => {
    const harness = createHarness({
      configurePty: (pty) => {
        pty.kill.mockImplementation(() => undefined);
      },
    });
    const snapshot = await harness.manager.create({
      workspaceId: WORKSPACE_A,
      configurationRevision: 1,
    });
    const pty = harness.ptys[0]!;
    let completed = false;
    const close = harness.manager
      .close({
        workspaceId: WORKSPACE_A,
        sessionId: snapshot.activeSessionId!,
      })
      .then((result) => {
        completed = true;
        return result;
      });
    await Promise.resolve();
    expect(pty.kill).toHaveBeenCalledTimes(1);
    expect(completed).toBe(false);

    pty.emitExit(0);
    await expect(close).resolves.toMatchObject({ sessions: [] });
    expect(completed).toBe(true);
  });

  it('does not release a native handle when exit arrives after a failed kill', async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness({
        configurePty: (pty) => {
          pty.kill
            .mockImplementationOnce(() => {
              queueMicrotask(() => pty.emitExit(0));
              throw new Error('kill failed before worker disposal');
            })
            .mockImplementationOnce(() => {
              throw new Error('worker still busy');
            })
            .mockImplementationOnce(() => undefined);
        },
      });
      const snapshot = await harness.manager.create({
        workspaceId: WORKSPACE_A,
        configurationRevision: 1,
      });
      const close = harness.manager.close({
        workspaceId: WORKSPACE_A,
        sessionId: snapshot.activeSessionId!,
      });
      let completed = false;
      void close.then(() => {
        completed = true;
      });

      await vi.advanceTimersByTimeAsync(PROCESS_SETTLE_TEST_WAIT_MS - 1);
      expect(completed).toBe(false);
      expect(harness.ptys[0]!.kill).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(1);
      await expect(close).resolves.toMatchObject({ sessions: [] });
      expect(harness.ptys[0]!.kill).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});

function createHarness(
  options: {
    configurationService?: TerminalConfigurationServiceLike;
    idCount?: number;
    configurePty?: (pty: FakePty, index: number) => void;
    platform?: NodeJS.Platform;
  } = {},
) {
  const ptys: FakePty[] = [];
  const spawn = vi.fn(() => {
    const pty = new FakePty();
    options.configurePty?.(pty, ptys.length);
    ptys.push(pty);
    return pty as unknown as NodePty.IPty;
  });
  const dataEvents: TerminalDataEvent[] = [];
  const exitEvents: TerminalExitEvent[] = [];
  const snapshots: TerminalSnapshot[] = [];
  const ids = Array.from(
    { length: options.idCount ?? 6 },
    (_, index) =>
      `${String(index + 1).padStart(8, '0')}-1111-4111-8111-${String(index + 1).padStart(12, '0')}`,
  );
  const manager = new TerminalManager({
    initialWorkspaceId: WORKSPACE_A,
    eventSink: {
      data: (event) => dataEvents.push(event),
      exit: (event) => exitEvents.push(event),
      stateChanged: (snapshot) => snapshots.push(snapshot),
    },
    configurationService: options.configurationService ?? createConfigurationService(),
    ptyFactory: { spawn },
    now: () => new Date('2026-07-22T12:00:00.000Z'),
    idFactory: () => ids.shift() ?? '99999999-9999-4999-8999-999999999999',
    platform: options.platform ?? 'linux',
    environment: { PATH: '/usr/bin' },
  });
  return {
    manager,
    ptys,
    spawn,
    dataEvents,
    exitEvents,
    snapshots,
    lastSnapshot: (workspaceId: string) => {
      const snapshot = [...snapshots]
        .reverse()
        .find((candidate) => candidate.workspaceId === workspaceId);
      if (!snapshot) throw new Error(`Missing snapshot for ${workspaceId}`);
      return snapshot;
    },
  };
}

class FakePty {
  readonly write = vi.fn();
  readonly resize = vi.fn();
  readonly clear = vi.fn();
  readonly kill = vi.fn(() => this.emitExit(0));
  public failDataSubscription = false;
  #dataListeners = new Set<(data: string) => void>();
  #exitListeners = new Set<(event: { exitCode: number; signal?: number }) => void>();

  public onData(listener: (data: string) => void): NodePty.IDisposable {
    if (this.failDataSubscription) throw new Error('data subscription failed');
    this.#dataListeners.add(listener);
    return { dispose: () => this.#dataListeners.delete(listener) };
  }

  public onExit(
    listener: (event: { exitCode: number; signal?: number }) => void,
  ): NodePty.IDisposable {
    this.#exitListeners.add(listener);
    return { dispose: () => this.#exitListeners.delete(listener) };
  }

  public emitData(data: string): void {
    for (const listener of [...this.#dataListeners]) listener(data);
  }

  public emitExit(exitCode: number, signal?: number): void {
    for (const listener of [...this.#exitListeners]) {
      listener({ exitCode, ...(signal === undefined ? {} : { signal }) });
    }
  }
}

const PROFILES: readonly ResolvedTerminalProfile[] = [
  {
    profile: {
      id: 'system-default',
      label: 'System Shell',
      kind: 'system',
      isDefault: true,
      available: true,
    },
    executable: '/bin/sh',
    args: ['-l'],
  },
  {
    profile: {
      id: 'command-prompt',
      label: 'Command Prompt',
      kind: 'command-prompt',
      isDefault: false,
      available: true,
    },
    executable: '/fake/cmd',
    args: [],
  },
  {
    profile: {
      id: 'wsl-default',
      label: 'WSL 默认发行版',
      kind: 'wsl',
      isDefault: false,
      available: false,
      unavailableReason: '未检测到可启动的 WSL 发行版',
    },
    executable: undefined,
    args: [],
  },
];

const CONFIGURATION: TerminalConfigurationSnapshot = {
  revision: 1,
  preferredProfileId: 'system-default',
  workingDirectory: {
    mode: 'user-home',
    displayPath: '/home/tester',
    available: true,
  },
  wsl: {
    status: 'unsupported',
    capabilityRevision: 1,
    distributions: [],
    selectedDistributionId: null,
    selectedDistributionLabel: null,
    selectedDistributionAvailable: false,
  },
};

const CONFIGURATION_STATE: TerminalConfigurationState = {
  profiles: PROFILES,
  configuration: CONFIGURATION,
};

function configurationState(
  revision: number,
  capabilityRevision: number,
  preferredProfileId: TerminalProfileId = 'system-default',
): TerminalConfigurationState {
  return {
    profiles: PROFILES,
    configuration: {
      ...CONFIGURATION,
      revision,
      preferredProfileId,
      wsl: {
        ...CONFIGURATION.wsl,
        capabilityRevision,
      },
    },
  };
}

function resolvedLaunch(profileId: TerminalProfileId): ResolvedTerminalLaunch {
  const resolved = PROFILES.find(({ profile }) => profile.id === profileId);
  if (!resolved?.profile.available || !resolved.executable) {
    throw new Error(resolved?.profile.unavailableReason ?? 'The terminal profile is unavailable');
  }
  const launch: TerminalLaunchConfiguration = {
    profileId,
    profileKind: resolved.profile.kind,
    label: resolved.profile.label,
    executable: resolved.executable,
    args: resolved.args,
    cwd: '/home/tester',
    wslDistributionName: null,
  };
  return { state: CONFIGURATION_STATE, launch };
}

function createConfigurationService() {
  return {
    getState: vi.fn(async () => CONFIGURATION_STATE),
    resolveLaunch: vi.fn(async (input: { profileId?: TerminalProfileId }) =>
      resolvedLaunch(input.profileId ?? 'system-default'),
    ),
    revalidateLaunch: vi.fn(async () => CONFIGURATION_STATE),
    updateProfile: vi.fn(async () => CONFIGURATION_STATE),
    updateWslDistribution: vi.fn(async () => CONFIGURATION_STATE),
    chooseWorkingDirectory: vi.fn(async () => ({
      status: 'cancelled' as const,
      state: CONFIGURATION_STATE,
    })),
    resetWorkingDirectory: vi.fn(async () => CONFIGURATION_STATE),
    refreshCapabilities: vi.fn(async () => CONFIGURATION_STATE),
    stop: vi.fn(),
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
