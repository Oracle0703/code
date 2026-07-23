import { describe, expect, it, vi } from 'vitest';
import type * as NodePty from 'node-pty';
import { TerminalManager } from '../src/main/terminal/terminal-manager';
import type {
  ResolvedTerminalProfile,
  TerminalProfileResolverLike,
} from '../src/main/terminal/terminal-profile-resolver';
import type {
  TerminalDataEvent,
  TerminalExitEvent,
  TerminalSnapshot,
} from '../src/shared/contracts';

const WORKSPACE_A = '11111111-1111-4111-8111-111111111111';
const WORKSPACE_B = '22222222-2222-4222-8222-222222222222';
const WORKSPACE_C = '33333333-3333-4333-8333-333333333333';

describe('terminal manager', () => {
  it('keeps independent sessions, routes sequenced output, and restarts an exited tab in place', async () => {
    const harness = createHarness();
    let snapshot = await harness.manager.create({
      workspaceId: WORKSPACE_A,
      profileId: 'system-default',
    });
    const firstId = snapshot.activeSessionId;
    snapshot = await harness.manager.create({
      workspaceId: WORKSPACE_A,
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

    snapshot = await harness.manager.close({
      workspaceId: WORKSPACE_A,
      sessionId: firstId!,
    });
    expect(snapshot.sessions.map(({ id }) => id)).toEqual([secondId]);
    expect(snapshot.activeSessionId).toBe(secondId);
    expect(secondPty.kill).not.toHaveBeenCalled();
  });

  it('allows only one restart when the same exited tab is restarted concurrently', async () => {
    const harness = createHarness();
    const initial = await harness.manager.create({
      workspaceId: WORKSPACE_A,
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

  it('bounds repeated failed restart processes even when subscription and kill both throw', async () => {
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
      profileId: 'system-default',
    });
    const sessionId = initial.activeSessionId!;
    harness.ptys[0]!.emitExit(0);

    const attempts = await Promise.allSettled(
      Array.from({ length: 12 }, () =>
        harness.manager.restart({ workspaceId: WORKSPACE_A, sessionId }),
      ),
    );

    expect(attempts.every(({ status }) => status === 'rejected')).toBe(true);
    expect(harness.ptys).toHaveLength(1 + 8);
    expect(harness.spawn).toHaveBeenCalledTimes(1 + 8);
  });

  it('enforces active-workspace ownership while background output remains correctly attributed', async () => {
    const harness = createHarness();
    const snapshotA = await harness.manager.create({
      workspaceId: WORKSPACE_A,
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
    expect(await harness.manager.getSnapshot({ workspaceId: WORKSPACE_B })).toMatchObject({
      activeSessionId: sessionB,
      sessions: [{ id: sessionB }],
    });
  });

  it('rejects unavailable profiles before spawning and invalidates a create delayed by switching', async () => {
    const deferredProfiles = deferred<readonly ResolvedTerminalProfile[]>();
    const harness = createHarness({
      profileResolver: { listProfiles: () => deferredProfiles.promise },
    });
    const pending = harness.manager.create({
      workspaceId: WORKSPACE_A,
      profileId: 'system-default',
    });
    harness.manager.setActiveWorkspace(WORKSPACE_B);
    deferredProfiles.resolve(PROFILES);
    await expect(pending).rejects.toThrow('active workspace');
    expect(harness.spawn).not.toHaveBeenCalled();

    const unavailableHarness = createHarness();
    await expect(
      unavailableHarness.manager.create({
        workspaceId: WORKSPACE_A,
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
        profileId: 'system-default',
      });
    }
    await expect(
      harness.manager.create({
        workspaceId: WORKSPACE_A,
        profileId: 'system-default',
      }),
    ).rejects.toThrow('at most 8');

    harness.manager.setActiveWorkspace(WORKSPACE_B);
    for (let index = 0; index < 8; index += 1) {
      await harness.manager.create({
        workspaceId: WORKSPACE_B,
        profileId: 'command-prompt',
      });
    }
    harness.manager.setActiveWorkspace(WORKSPACE_C);
    await expect(
      harness.manager.create({
        workspaceId: WORKSPACE_C,
        profileId: 'system-default',
      }),
    ).rejects.toThrow('at most 16');
    expect(harness.ptys.every((pty) => pty.kill.mock.calls.length === 0)).toBe(true);
  });

  it('drops late native events and attempts every teardown when one kill fails', async () => {
    const harness = createHarness();
    const first = await harness.manager.create({
      workspaceId: WORKSPACE_A,
      profileId: 'system-default',
    });
    const firstId = first.activeSessionId!;
    const second = await harness.manager.create({
      workspaceId: WORKSPACE_A,
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
    expect(() => harness.manager.discardWorkspace(WORKSPACE_A)).toThrow(
      'Unable to stop every terminal process',
    );
    expect(pty.kill).toHaveBeenCalledTimes(2);

    await expect(harness.manager.shutdown()).resolves.toBeUndefined();
    expect(pty.kill).toHaveBeenCalledTimes(3);
  });

  it('splits oversized output into bounded ordered events without breaking surrogate pairs', async () => {
    const harness = createHarness();
    const snapshot = await harness.manager.create({
      workspaceId: WORKSPACE_A,
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
});

function createHarness(
  options: {
    profileResolver?: TerminalProfileResolverLike;
    idCount?: number;
    configurePty?: (pty: FakePty, index: number) => void;
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
    profileResolver: options.profileResolver ?? {
      listProfiles: async () => PROFILES,
    },
    ptyFactory: { spawn },
    now: () => new Date('2026-07-22T12:00:00.000Z'),
    idFactory: () => ids.shift() ?? '99999999-9999-4999-8999-999999999999',
    workingDirectory: () => '/home/tester',
    platform: 'linux',
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
  readonly kill = vi.fn();
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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
