import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { TerminalManager } from '../src/main/terminal/terminal-manager';
import type { TerminalDataEvent, TerminalProfile, TerminalSnapshot } from '../src/shared/contracts';

const WORKSPACE_A = '11111111-1111-4111-8111-111111111111';
const WORKSPACE_B = '22222222-2222-4222-8222-222222222222';
const SMOKE_TIMEOUT_MS = 45_000;

let manager: TerminalManager | undefined;

void runWithTimeout()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await manager?.shutdown();
  });

async function runWithTimeout(): Promise<void> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      run(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error('Packaged TerminalManager smoke test timed out.')),
          SMOKE_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function run(): Promise<void> {
  assert.ok(
    process.versions.electron,
    'Run this bundle with the packaged Electron executable and ELECTRON_RUN_AS_NODE=1.',
  );
  assertPackagedNodePtyResolution();
  const root = await mkdtemp(join(tmpdir(), 'daily workbench 终端 smoke-'));
  const firstDirectory = join(root, '会话 A');
  const secondDirectory = join(root, 'session B');
  await Promise.all([
    mkdir(firstDirectory, { recursive: true }),
    mkdir(secondDirectory, { recursive: true }),
  ]);

  const output = new Map<string, string>();
  const waiters = new Map<string, Set<() => void>>();
  const directories = [firstDirectory, secondDirectory];
  const onData = (event: TerminalDataEvent): void => {
    output.set(
      event.sessionId,
      `${output.get(event.sessionId) ?? ''}${event.data}`.slice(-1_000_000),
    );
    for (const notify of waiters.get(event.sessionId) ?? []) notify();
  };
  manager = new TerminalManager({
    initialWorkspaceId: WORKSPACE_A,
    eventSink: {
      data: onData,
      exit: () => undefined,
      stateChanged: () => undefined,
    },
    workingDirectory: () => directories.shift() ?? root,
  });

  try {
    let snapshot = await manager.getSnapshot({ workspaceId: WORKSPACE_A });
    const available = snapshot.profiles.filter(({ available }) => available);
    assert.ok(available.length > 0, 'Packaged TerminalManager did not discover a usable profile.');
    const preferred = selectSmokeProfiles(snapshot);

    snapshot = await manager.create({
      workspaceId: WORKSPACE_A,
      profileId: preferred[0].id,
    });
    const firstId = requiredActiveSession(snapshot);
    snapshot = await manager.create({
      workspaceId: WORKSPACE_A,
      profileId: preferred[1].id,
    });
    const secondId = requiredActiveSession(snapshot);
    assert.notEqual(firstId, secondId, 'Two terminal creates must return independent sessions.');

    const firstMarker = 'DAILY_WORKBENCH_TERMINAL_A_OK';
    const secondMarker = 'DAILY_WORKBENCH_TERMINAL_B_OK';
    manager.write({
      workspaceId: WORKSPACE_A,
      sessionId: firstId,
      data: markerCommand(preferred[0], firstMarker),
    });
    manager.write({
      workspaceId: WORKSPACE_A,
      sessionId: secondId,
      data: markerCommand(preferred[1], secondMarker),
    });
    await Promise.all([
      waitForMarker(firstId, firstMarker, output, waiters),
      waitForMarker(secondId, secondMarker, output, waiters),
    ]);

    manager.resize({
      workspaceId: WORKSPACE_A,
      sessionId: firstId,
      columns: 101,
      rows: 33,
    });
    manager.resize({
      workspaceId: WORKSPACE_A,
      sessionId: secondId,
      columns: 119,
      rows: 37,
    });
    manager.clear({ workspaceId: WORKSPACE_A, sessionId: firstId });
    snapshot = await manager.close({ workspaceId: WORKSPACE_A, sessionId: firstId });
    assert.deepEqual(
      snapshot.sessions.map(({ id }) => id),
      [secondId],
    );

    const survivorMarker = 'DAILY_WORKBENCH_TERMINAL_SURVIVOR_OK';
    manager.write({
      workspaceId: WORKSPACE_A,
      sessionId: secondId,
      data: markerCommand(preferred[1], survivorMarker),
    });
    await waitForMarker(secondId, survivorMarker, output, waiters);

    manager.setActiveWorkspace(WORKSPACE_B);
    const workspaceB = await manager.getSnapshot({ workspaceId: WORKSPACE_B });
    assert.equal(workspaceB.sessions.length, 0, 'A new workspace must not inherit terminal tabs.');
    manager.setActiveWorkspace(WORKSPACE_A);
    const restored = await manager.getSnapshot({ workspaceId: WORKSPACE_A });
    assert.deepEqual(
      restored.sessions.map(({ id }) => id),
      [secondId],
      'Switching back must restore only the owning workspace sessions.',
    );

    const wsl = restored.profiles.find(({ id }) => id === 'wsl-default');
    if (process.platform === 'win32' && wsl?.available) {
      const wslSnapshot = await manager.create({
        workspaceId: WORKSPACE_A,
        profileId: wsl.id,
      });
      const wslId = requiredActiveSession(wslSnapshot);
      const wslMarker = 'DAILY_WORKBENCH_WSL_OK';
      manager.write({
        workspaceId: WORKSPACE_A,
        sessionId: wslId,
        data: markerCommand(wsl, wslMarker),
      });
      await waitForMarker(wslId, wslMarker, output, waiters);
      await manager.close({ workspaceId: WORKSPACE_A, sessionId: wslId });
      console.log('Packaged WSL default-distribution profile smoke test passed.');
    } else if (process.platform === 'win32') {
      assert.equal(
        wsl?.available,
        false,
        'Windows without a WSL distribution must report the profile as unavailable.',
      );
      console.log('Packaged WSL capability safely reported no default distribution.');
    }

    await manager.close({ workspaceId: WORKSPACE_A, sessionId: secondId });
    console.log(
      `Packaged TerminalManager profile/discovery/two-session/workspace/resize/clear/close smoke test passed ` +
        `(Electron ${process.versions.electron}, Node ${process.versions.node}, platform ${process.platform}).`,
    );
  } finally {
    await manager.shutdown();
    await removeSmokeDirectory(root);
  }
}

function assertPackagedNodePtyResolution(): void {
  const packagedAsar = process.env.DAILY_WORKBENCH_PACKAGED_ASAR;
  assert.ok(
    packagedAsar,
    'DAILY_WORKBENCH_PACKAGED_ASAR is required to prove node-pty came from the packaged payload.',
  );
  const resolvedNodePty = createRequire(__filename).resolve('node-pty');
  const candidate = normalizePathForComparison(resolvedNodePty);
  const allowedRoots = [packagedAsar, `${packagedAsar}.unpacked`].map(normalizePathForComparison);
  assert.ok(
    allowedRoots.some((root) => candidate === root || candidate.startsWith(`${root}/`)),
    'Terminal smoke resolved node-pty outside the packaged ASAR payload.',
  );
  console.log('Packaged TerminalManager resolved node-pty from the packaged application payload.');
}

function normalizePathForComparison(value: string): string {
  const normalized = resolve(value).replaceAll('\\', '/');
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
}

function selectSmokeProfiles(snapshot: TerminalSnapshot): [TerminalProfile, TerminalProfile] {
  const available = snapshot.profiles.filter(({ available }) => available);
  if (process.platform === 'win32') {
    const commandPrompt = available.find(({ id }) => id === 'command-prompt');
    const powerShell =
      available.find(({ id }) => id === 'powershell-7') ??
      available.find(({ id }) => id === 'windows-powershell');
    if (commandPrompt && powerShell) return [commandPrompt, powerShell];
  }
  const first =
    available.find(({ id }) => id === 'bash') ??
    available.find(({ isDefault }) => isDefault) ??
    available[0];
  assert.ok(first);
  const second = available.find(({ id }) => id !== first.id) ?? first;
  return [first, second];
}

function markerCommand(profile: TerminalProfile, marker: string): string {
  if (profile.kind === 'powershell') return `Write-Output '${marker}'\r`;
  if (profile.kind === 'command-prompt') return `echo ${marker}\r`;
  return `printf '%s\\n' '${marker}'\n`;
}

function requiredActiveSession(snapshot: TerminalSnapshot): string {
  assert.ok(snapshot.activeSessionId, 'Terminal mutation did not return an active session.');
  return snapshot.activeSessionId;
}

function waitForMarker(
  sessionId: string,
  marker: string,
  output: Map<string, string>,
  waiters: Map<string, Set<() => void>>,
): Promise<void> {
  if (output.get(sessionId)?.includes(marker)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      listeners.delete(check);
      reject(new Error(`Terminal session did not return its expected marker: ${marker}`));
    }, 15_000);
    const check = () => {
      if (!output.get(sessionId)?.includes(marker)) return;
      clearTimeout(timeout);
      listeners.delete(check);
      resolve();
    };
    const listeners = waiters.get(sessionId) ?? new Set<() => void>();
    listeners.add(check);
    waiters.set(sessionId, listeners);
    check();
  });
}

async function removeSmokeDirectory(directory: string): Promise<void> {
  const expectedPrefix = join(tmpdir(), 'daily workbench 终端 smoke-');
  assert.ok(
    directory.startsWith(expectedPrefix),
    `Refusing to clean an unexpected terminal smoke path: ${directory}`,
  );
  await rm(directory, { recursive: true, force: true });
}
