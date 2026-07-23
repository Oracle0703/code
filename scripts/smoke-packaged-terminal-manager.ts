import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { TerminalConfigurationService } from '../src/main/terminal/terminal-configuration-service';
import { TerminalManager } from '../src/main/terminal/terminal-manager';
import type {
  StoredTerminalPreferences,
  TerminalPreferenceStore,
  TerminalProfilePreferenceWrite,
  TerminalWorkingDirectoryPreferenceWrite,
  TerminalWslDistributionPreferenceWrite,
} from '../src/main/terminal/terminal-preference-types';
import type {
  TerminalDataEvent,
  TerminalProfile,
  TerminalProfileId,
  TerminalSnapshot,
} from '../src/shared/contracts';

const WORKSPACE_A = '11111111-1111-4111-8111-111111111111';
const WORKSPACE_B = '22222222-2222-4222-8222-222222222222';
const SMOKE_TIMEOUT_MS = 75_000;
const FIRST_CWD_SENTINEL = '.daily-workbench-first-cwd';
const SECOND_CWD_SENTINEL = '.daily-workbench-second-cwd';

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
  await Promise.all([
    writeFile(join(firstDirectory, FIRST_CWD_SENTINEL), 'first\n', 'utf8'),
    writeFile(join(secondDirectory, SECOND_CWD_SENTINEL), 'second\n', 'utf8'),
  ]);
  const [canonicalRoot, canonicalFirstDirectory, canonicalSecondDirectory] = await Promise.all([
    realpath(root),
    realpath(firstDirectory),
    realpath(secondDirectory),
  ]);

  const output = new Map<string, string>();
  const waiters = new Map<string, Set<() => void>>();
  const exitedSessions = new Set<string>();
  const exitWaiters = new Map<string, Set<() => void>>();
  const selectedDirectories = [firstDirectory, secondDirectory];
  const onData = (event: TerminalDataEvent): void => {
    output.set(
      event.sessionId,
      `${output.get(event.sessionId) ?? ''}${event.data}`.slice(-1_000_000),
    );
    for (const notify of waiters.get(event.sessionId) ?? []) notify();
  };
  const store = new SmokeTerminalPreferenceStore();
  const configurationService = new TerminalConfigurationService({
    store,
    chooseWorkingDirectory: async () => selectedDirectories.shift() ?? null,
    homeDirectory: () => root,
  });
  manager = new TerminalManager({
    initialWorkspaceId: WORKSPACE_A,
    eventSink: {
      data: onData,
      exit: ({ sessionId }) => {
        exitedSessions.add(sessionId);
        for (const notify of exitWaiters.get(sessionId) ?? []) notify();
      },
      stateChanged: () => undefined,
    },
    configurationService,
  });

  try {
    let snapshot = await manager.getSnapshot({ workspaceId: WORKSPACE_A });
    const available = snapshot.profiles.filter(({ available }) => available);
    assert.ok(available.length > 0, 'Packaged TerminalManager did not discover a usable profile.');
    const preferred = selectSmokeProfiles(snapshot);
    assert.notEqual(
      preferred[0].id,
      preferred[1].id,
      'Packaged TerminalManager must expose two distinct fixed profiles for preference testing.',
    );

    const firstDirectorySelection = await manager.chooseWorkingDirectory({
      workspaceId: WORKSPACE_A,
      expectedRevision: snapshot.configuration.revision,
    });
    assert.equal(firstDirectorySelection.status, 'updated');
    snapshot = firstDirectorySelection.snapshot;
    assert.equal(snapshot.configuration.revision, 2);
    assert.equal(snapshot.configuration.workingDirectory.displayPath, canonicalFirstDirectory);
    assert.equal(snapshot.configuration.workingDirectory.available, true);

    snapshot = await manager.updateProfile({
      workspaceId: WORKSPACE_A,
      profileId: preferred[0].id,
      expectedRevision: snapshot.configuration.revision,
    });
    assert.equal(snapshot.configuration.revision, 3);
    assert.equal(snapshot.configuration.preferredProfileId, preferred[0].id);
    await assert.rejects(
      manager.create({
        workspaceId: WORKSPACE_A,
        configurationRevision: 2,
      }),
      /settings changed/u,
      'A stale packaged configuration revision must not start a PTY.',
    );
    snapshot = await manager.getSnapshot({ workspaceId: WORKSPACE_A });
    assert.equal(snapshot.sessions.length, 0);

    snapshot = await manager.create({
      workspaceId: WORKSPACE_A,
      configurationRevision: snapshot.configuration.revision,
    });
    const firstId = requiredActiveSession(snapshot);
    assert.equal(requiredSession(snapshot, firstId).profileId, preferred[0].id);
    snapshot = await manager.create({
      workspaceId: WORKSPACE_A,
      profileId: preferred[1].id,
      configurationRevision: snapshot.configuration.revision,
    });
    const secondId = requiredActiveSession(snapshot);
    assert.notEqual(firstId, secondId, 'Two terminal creates must return independent sessions.');
    assert.equal(requiredSession(snapshot, secondId).profileId, preferred[1].id);
    assert.equal(
      snapshot.configuration.preferredProfileId,
      preferred[0].id,
      'A one-shot profile must not change the persisted preference.',
    );

    const firstMarker = 'DAILY_WORKBENCH_TERMINAL_FIRST_CWD_OK';
    const secondMarker = 'DAILY_WORKBENCH_TERMINAL_ONE_SHOT_CWD_OK';
    manager.write({
      workspaceId: WORKSPACE_A,
      sessionId: firstId,
      data: cwdMarkerCommand(preferred[0], firstMarker, FIRST_CWD_SENTINEL),
    });
    manager.write({
      workspaceId: WORKSPACE_A,
      sessionId: secondId,
      data: cwdMarkerCommand(preferred[1], secondMarker, FIRST_CWD_SENTINEL),
    });
    await Promise.all([
      waitForMarker(firstId, firstMarker, output, waiters),
      waitForMarker(secondId, secondMarker, output, waiters),
    ]);

    manager.write({
      workspaceId: WORKSPACE_A,
      sessionId: firstId,
      data: exitCommand(preferred[0]),
    });
    await waitForSessionExit(firstId, exitedSessions, exitWaiters);
    snapshot = await manager.getSnapshot({ workspaceId: WORKSPACE_A });
    assert.equal(requiredSession(snapshot, firstId).status, 'exited');

    snapshot = await manager.updateProfile({
      workspaceId: WORKSPACE_A,
      profileId: preferred[1].id,
      expectedRevision: snapshot.configuration.revision,
    });
    assert.equal(snapshot.configuration.revision, 4);
    const secondDirectorySelection = await manager.chooseWorkingDirectory({
      workspaceId: WORKSPACE_A,
      expectedRevision: snapshot.configuration.revision,
    });
    assert.equal(secondDirectorySelection.status, 'updated');
    snapshot = secondDirectorySelection.snapshot;
    assert.equal(snapshot.configuration.revision, 5);
    assert.equal(snapshot.configuration.workingDirectory.displayPath, canonicalSecondDirectory);

    snapshot = await manager.restart({
      workspaceId: WORKSPACE_A,
      sessionId: firstId,
    });
    assert.equal(
      requiredSession(snapshot, firstId).profileId,
      preferred[0].id,
      'Restart must retain the session profile frozen at creation.',
    );
    const restartedMarker = 'DAILY_WORKBENCH_TERMINAL_RESTART_FROZEN_CWD_OK';
    manager.write({
      workspaceId: WORKSPACE_A,
      sessionId: firstId,
      data: cwdMarkerCommand(preferred[0], restartedMarker, FIRST_CWD_SENTINEL),
    });
    await waitForMarker(firstId, restartedMarker, output, waiters);

    snapshot = await manager.create({
      workspaceId: WORKSPACE_A,
      configurationRevision: snapshot.configuration.revision,
    });
    const thirdId = requiredActiveSession(snapshot);
    assert.equal(
      requiredSession(snapshot, thirdId).profileId,
      preferred[1].id,
      'A new session must use the latest persisted profile.',
    );
    const latestMarker = 'DAILY_WORKBENCH_TERMINAL_LATEST_CWD_OK';
    manager.write({
      workspaceId: WORKSPACE_A,
      sessionId: thirdId,
      data: cwdMarkerCommand(preferred[1], latestMarker, SECOND_CWD_SENTINEL),
    });
    await waitForMarker(thirdId, latestMarker, output, waiters);

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
      [secondId, thirdId],
    );

    const survivorMarker = 'DAILY_WORKBENCH_TERMINAL_SURVIVOR_OK';
    manager.write({
      workspaceId: WORKSPACE_A,
      sessionId: secondId,
      data: cwdMarkerCommand(preferred[1], survivorMarker, FIRST_CWD_SENTINEL),
    });
    await waitForMarker(secondId, survivorMarker, output, waiters);

    manager.setActiveWorkspace(WORKSPACE_B);
    const workspaceB = await manager.getSnapshot({ workspaceId: WORKSPACE_B });
    assert.equal(workspaceB.sessions.length, 0, 'A new workspace must not inherit terminal tabs.');
    manager.setActiveWorkspace(WORKSPACE_A);
    let restored = await manager.getSnapshot({ workspaceId: WORKSPACE_A });
    assert.deepEqual(
      restored.sessions.map(({ id }) => id),
      [secondId, thirdId],
      'Switching back must restore only the owning workspace sessions.',
    );

    restored = await manager.refreshCapabilities({ workspaceId: WORKSPACE_A });
    const wsl = requiredProfile(restored, 'wsl-default');
    if (process.platform === 'win32' && restored.configuration.wsl.status === 'ready') {
      assert.equal(wsl.available, true);
      const distribution = restored.configuration.wsl.distributions[0];
      assert.ok(distribution, 'Ready WSL capability must expose at least one distribution.');
      assert.notEqual(
        distribution.id,
        distribution.label,
        'Renderer-facing WSL selection must use an opaque ID.',
      );
      restored = await manager.updateWslDistribution({
        workspaceId: WORKSPACE_A,
        distributionId: distribution.id,
        capabilityRevision: restored.configuration.wsl.capabilityRevision,
        expectedRevision: restored.configuration.revision,
      });
      assert.equal(restored.configuration.wsl.selectedDistributionId, distribution.id);
      assert.equal(restored.configuration.wsl.selectedDistributionAvailable, true);
      restored = await manager.updateProfile({
        workspaceId: WORKSPACE_A,
        profileId: wsl.id,
        expectedRevision: restored.configuration.revision,
      });
      const wslSnapshot = await manager.create({
        workspaceId: WORKSPACE_A,
        configurationRevision: restored.configuration.revision,
      });
      const wslId = requiredActiveSession(wslSnapshot);
      const wslMarker = 'DAILY_WORKBENCH_WSL_HOME_AND_DISTRIBUTION_OK';
      manager.write({
        workspaceId: WORKSPACE_A,
        sessionId: wslId,
        data: wslHomeMarkerCommand(distribution.label, wslMarker),
      });
      await waitForMarker(wslId, wslMarker, output, waiters);
      restored = await manager.close({ workspaceId: WORKSPACE_A, sessionId: wslId });
      console.log('Packaged WSL opaque-distribution/home-directory smoke test passed.');
    } else if (process.platform === 'win32') {
      assert.equal(
        wsl.available,
        false,
        'Windows without a ready WSL capability must report the profile as unavailable.',
      );
      assert.notEqual(restored.configuration.wsl.status, 'ready');
      console.log(`Packaged WSL capability safely reported ${restored.configuration.wsl.status}.`);
    } else {
      assert.equal(restored.configuration.wsl.status, 'unsupported');
      assert.equal(wsl.available, false);
    }

    restored = await manager.resetWorkingDirectory({
      workspaceId: WORKSPACE_A,
      expectedRevision: restored.configuration.revision,
    });
    assert.equal(restored.configuration.workingDirectory.mode, 'user-home');
    assert.equal(restored.configuration.workingDirectory.displayPath, canonicalRoot);

    await manager.close({ workspaceId: WORKSPACE_A, sessionId: secondId });
    await manager.close({ workspaceId: WORKSPACE_A, sessionId: thirdId });
    console.log(
      `Packaged TerminalManager profile/CWD/frozen-restart/workspace/resize/clear/close smoke test passed ` +
        `(Electron ${process.versions.electron}, Node ${process.versions.node}, platform ${process.platform}).`,
    );
  } finally {
    await manager.shutdown();
    await removeSmokeDirectory(root);
  }
}

type SmokePreferencePatch = Partial<
  Pick<
    StoredTerminalPreferences,
    'preferredProfileId' | 'nativeCwdPlatform' | 'nativeCwdPath' | 'wslDistributionName'
  >
>;

class SmokeTerminalPreferenceStore implements TerminalPreferenceStore {
  readonly #preferences = new Map<string, StoredTerminalPreferences>();

  public getTerminalPreferences(workspaceId: string): Promise<StoredTerminalPreferences> {
    const existing = this.#preferences.get(workspaceId);
    if (existing) return Promise.resolve({ ...existing });
    const initial: StoredTerminalPreferences = {
      workspaceId,
      preferredProfileId: 'system-default',
      nativeCwdPlatform: null,
      nativeCwdPath: null,
      wslDistributionName: null,
      revision: 1,
      updatedAt: new Date(1_700_000_000_001).toISOString(),
    };
    this.#preferences.set(workspaceId, initial);
    return Promise.resolve({ ...initial });
  }

  public updateTerminalProfilePreference(
    input: TerminalProfilePreferenceWrite,
  ): Promise<StoredTerminalPreferences> {
    return this.#update(input.workspaceId, input.expectedRevision, {
      preferredProfileId: input.preferredProfileId,
    });
  }

  public updateTerminalWorkingDirectoryPreference(
    input: TerminalWorkingDirectoryPreferenceWrite,
  ): Promise<StoredTerminalPreferences> {
    return this.#update(input.workspaceId, input.expectedRevision, {
      nativeCwdPlatform: input.nativeCwdPlatform,
      nativeCwdPath: input.nativeCwdPath,
    });
  }

  public updateTerminalWslDistributionPreference(
    input: TerminalWslDistributionPreferenceWrite,
  ): Promise<StoredTerminalPreferences> {
    return this.#update(input.workspaceId, input.expectedRevision, {
      wslDistributionName: input.wslDistributionName,
    });
  }

  async #update(
    workspaceId: string,
    expectedRevision: number,
    patch: SmokePreferencePatch,
  ): Promise<StoredTerminalPreferences> {
    const current = await this.getTerminalPreferences(workspaceId);
    if (current.revision !== expectedRevision) {
      throw new Error('Smoke terminal preference revision conflict.');
    }
    const revision = current.revision + 1;
    const updated: StoredTerminalPreferences = {
      ...current,
      ...patch,
      revision,
      updatedAt: new Date(1_700_000_000_000 + revision).toISOString(),
    };
    this.#preferences.set(workspaceId, updated);
    return { ...updated };
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

function cwdMarkerCommand(profile: TerminalProfile, marker: string, sentinel: string): string {
  if (profile.kind === 'powershell') {
    return `if (Test-Path -LiteralPath './${sentinel}') { Write-Output '${marker}' }\r`;
  }
  if (profile.kind === 'command-prompt') {
    return `if exist ".\\${sentinel}" echo ${marker}\r`;
  }
  return `test -f './${sentinel}' && printf '%s\\n' '${marker}'\n`;
}

function exitCommand(profile: TerminalProfile): string {
  return profile.kind === 'powershell' || profile.kind === 'command-prompt' ? 'exit\r' : 'exit\n';
}

function wslHomeMarkerCommand(distributionName: string, marker: string): string {
  return (
    `if [ "$PWD" = "$HOME" ] && [ "$WSL_DISTRO_NAME" = ${quotePosix(distributionName)} ]; ` +
    `then printf '%s\\n' '${marker}'; fi\n`
  );
}

function quotePosix(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function requiredActiveSession(snapshot: TerminalSnapshot): string {
  assert.ok(snapshot.activeSessionId, 'Terminal mutation did not return an active session.');
  return snapshot.activeSessionId;
}

function requiredSession(
  snapshot: TerminalSnapshot,
  sessionId: string,
): TerminalSnapshot['sessions'][number] {
  const session = snapshot.sessions.find(({ id }) => id === sessionId);
  assert.ok(session, `Terminal snapshot is missing session ${sessionId}.`);
  return session;
}

function requiredProfile(
  snapshot: TerminalSnapshot,
  profileId: TerminalProfileId,
): TerminalProfile {
  const profile = snapshot.profiles.find(({ id }) => id === profileId);
  assert.ok(profile, `Terminal snapshot is missing profile ${profileId}.`);
  return profile;
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

function waitForSessionExit(
  sessionId: string,
  exitedSessions: ReadonlySet<string>,
  waiters: Map<string, Set<() => void>>,
): Promise<void> {
  if (exitedSessions.has(sessionId)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      listeners.delete(check);
      reject(new Error(`Terminal session did not exit: ${sessionId}`));
    }, 15_000);
    const check = () => {
      if (!exitedSessions.has(sessionId)) return;
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
