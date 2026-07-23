import { randomUUID } from 'node:crypto';
import * as nodePty from 'node-pty';
import type {
  TerminalConfigurationRevisionInput,
  TerminalCreateInput,
  TerminalDataEvent,
  TerminalExitEvent,
  TerminalProfilePreferenceInput,
  TerminalResizeInput,
  TerminalSession,
  TerminalSessionTargetInput,
  TerminalSnapshot,
  TerminalWorkingDirectorySelection,
  TerminalWorkspaceInput,
  TerminalWslPreferenceInput,
  TerminalWriteInput,
} from '../../shared/contracts';
import {
  type ResolvedTerminalLaunch,
  type TerminalConfigurationServiceLike,
  type TerminalConfigurationState,
  type TerminalLaunchConfiguration,
} from './terminal-configuration-service';
import { createTerminalEnvironment } from './terminal-environment';

const MAX_SESSIONS_PER_WORKSPACE = 8;
const MAX_SESSIONS_PER_WINDOW = 16;
const MAX_DATA_EVENT_CODE_UNITS = 64 * 1024;
const PROCESS_EXIT_WAIT_MS = 750;
const PROCESS_KILL_ATTEMPTS = 2;

interface ManagedSession {
  info: TerminalSession;
  launch: TerminalLaunchConfiguration;
  process: nodePty.IPty | null;
  dataSubscription: nodePty.IDisposable | null;
  exitSubscription: nodePty.IDisposable | null;
  sequence: number;
  closing: boolean;
  restarting: boolean;
}

interface TerminalEventSink {
  data(event: TerminalDataEvent): void;
  exit(event: TerminalExitEvent): void;
  stateChanged(snapshot: TerminalSnapshot): void;
}

interface TerminalPtyFactory {
  spawn(
    file: string,
    args: string[] | string,
    options: nodePty.IPtyForkOptions | nodePty.IWindowsPtyForkOptions,
  ): nodePty.IPty;
}

export interface TerminalManagerOptions {
  readonly initialWorkspaceId: string;
  readonly eventSink: TerminalEventSink;
  readonly configurationService: TerminalConfigurationServiceLike;
  readonly ptyFactory?: TerminalPtyFactory;
  readonly now?: () => Date;
  readonly idFactory?: () => string;
  readonly platform?: NodeJS.Platform;
  readonly environment?: NodeJS.ProcessEnv;
}

interface WorkspaceToken {
  readonly workspaceId: string;
  readonly generation: number;
}

interface PendingProcessKill {
  readonly process: nodePty.IPty;
  readonly workspaceId: string;
  readonly settled: Promise<void>;
  readonly resolveSettled: () => void;
  exitSubscription: nodePty.IDisposable | null;
  exitObserved: boolean;
  killAccepted: boolean;
}

interface CachedConfigurationState {
  readonly state: TerminalConfigurationState;
  readonly requestSequence: number;
}

export class TerminalManager {
  readonly #sessions = new Map<string, ManagedSession>();
  readonly #pendingProcessKills = new Map<nodePty.IPty, PendingProcessKill>();
  readonly #activeSessionIds = new Map<string, string>();
  readonly #revisions = new Map<string, number>();
  readonly #configurationStates = new Map<string, CachedConfigurationState>();
  readonly #eventSink: TerminalEventSink;
  readonly #configurationService: TerminalConfigurationServiceLike;
  readonly #ptyFactory: TerminalPtyFactory;
  readonly #now: () => Date;
  readonly #idFactory: () => string;
  readonly #platform: NodeJS.Platform;
  readonly #environment: NodeJS.ProcessEnv;
  #activeWorkspaceId: string;
  #workspaceGeneration = 0;
  #configurationRequestSequence = 0;
  #accepting = true;
  #shutdownPromise: Promise<void> | null = null;

  public constructor(options: TerminalManagerOptions) {
    this.#activeWorkspaceId = options.initialWorkspaceId;
    this.#eventSink = options.eventSink;
    this.#configurationService = options.configurationService;
    this.#ptyFactory = options.ptyFactory ?? nodePty;
    this.#now = options.now ?? (() => new Date());
    this.#idFactory = options.idFactory ?? randomUUID;
    this.#platform = options.platform ?? process.platform;
    this.#environment = options.environment ?? process.env;
  }

  public async getSnapshot(input: TerminalWorkspaceInput): Promise<TerminalSnapshot> {
    const token = this.#captureWorkspace(input.workspaceId);
    const requestSequence = this.#beginConfigurationRequest();
    const state = await this.#configurationService.getState(input.workspaceId);
    this.#assertWorkspaceToken(token);
    this.#cacheState(input.workspaceId, state, requestSequence);
    return this.#snapshot(input.workspaceId);
  }

  public async create(input: TerminalCreateInput): Promise<TerminalSnapshot> {
    const token = this.#captureWorkspace(input.workspaceId);
    const requestSequence = this.#beginConfigurationRequest();
    const resolved = await this.#configurationService.resolveLaunch(input);
    this.#assertWorkspaceToken(token);
    this.#cacheResolvedLaunch(input.workspaceId, resolved, requestSequence);
    this.#assertCapacity(input.workspaceId);

    const id = this.#createUniqueId();
    const launch = freezeLaunchConfiguration(resolved.launch);
    const session: ManagedSession = {
      info: {
        id,
        workspaceId: input.workspaceId,
        profileId: launch.profileId,
        label: launch.label,
        status: 'running',
        createdAt: this.#now().toISOString(),
      },
      launch,
      process: null,
      dataSubscription: null,
      exitSubscription: null,
      sequence: 0,
      closing: false,
      restarting: false,
    };
    this.#sessions.set(id, session);
    try {
      this.#spawn(session);
      this.#assertWorkspaceToken(token);
    } catch {
      this.#discardSession(session);
      throw new Error(`Unable to start the ${launch.label} terminal profile`);
    }

    this.#activeSessionIds.set(input.workspaceId, id);
    this.#advanceRevision(input.workspaceId);
    return this.#publishSnapshot(input.workspaceId);
  }

  public async updateProfile(input: TerminalProfilePreferenceInput): Promise<TerminalSnapshot> {
    const token = this.#captureWorkspace(input.workspaceId);
    const requestSequence = this.#beginConfigurationRequest();
    const state = await this.#configurationService.updateProfile(input);
    this.#assertWorkspaceToken(token);
    this.#cacheState(input.workspaceId, state, requestSequence);
    this.#advanceRevision(input.workspaceId);
    return this.#publishSnapshot(input.workspaceId);
  }

  public async updateWslDistribution(input: TerminalWslPreferenceInput): Promise<TerminalSnapshot> {
    const token = this.#captureWorkspace(input.workspaceId);
    const requestSequence = this.#beginConfigurationRequest();
    const state = await this.#configurationService.updateWslDistribution(input);
    this.#assertWorkspaceToken(token);
    this.#cacheState(input.workspaceId, state, requestSequence);
    this.#advanceRevision(input.workspaceId);
    return this.#publishSnapshot(input.workspaceId);
  }

  public async chooseWorkingDirectory(
    input: TerminalConfigurationRevisionInput,
  ): Promise<TerminalWorkingDirectorySelection> {
    const token = this.#captureWorkspace(input.workspaceId);
    const requestSequence = this.#beginConfigurationRequest();
    const selection = await this.#configurationService.chooseWorkingDirectory(input);
    this.#assertWorkspaceToken(token);
    this.#cacheState(input.workspaceId, selection.state, requestSequence);
    if (selection.status === 'cancelled') {
      return Object.freeze({
        status: 'cancelled',
        snapshot: this.#snapshot(input.workspaceId),
      });
    }
    this.#advanceRevision(input.workspaceId);
    return Object.freeze({
      status: 'updated',
      snapshot: this.#publishSnapshot(input.workspaceId),
    });
  }

  public async resetWorkingDirectory(
    input: TerminalConfigurationRevisionInput,
  ): Promise<TerminalSnapshot> {
    const token = this.#captureWorkspace(input.workspaceId);
    const requestSequence = this.#beginConfigurationRequest();
    const state = await this.#configurationService.resetWorkingDirectory(input);
    this.#assertWorkspaceToken(token);
    this.#cacheState(input.workspaceId, state, requestSequence);
    this.#advanceRevision(input.workspaceId);
    return this.#publishSnapshot(input.workspaceId);
  }

  public async refreshCapabilities(input: TerminalWorkspaceInput): Promise<TerminalSnapshot> {
    const token = this.#captureWorkspace(input.workspaceId);
    const requestSequence = this.#beginConfigurationRequest();
    const state = await this.#configurationService.refreshCapabilities(input.workspaceId);
    this.#assertWorkspaceToken(token);
    this.#cacheState(input.workspaceId, state, requestSequence);
    this.#advanceRevision(input.workspaceId);
    return this.#publishSnapshot(input.workspaceId);
  }

  public async activate(input: TerminalSessionTargetInput): Promise<TerminalSnapshot> {
    this.#captureWorkspace(input.workspaceId);
    this.#getOwnedSession(input);
    if (this.#activeSessionIds.get(input.workspaceId) !== input.sessionId) {
      this.#activeSessionIds.set(input.workspaceId, input.sessionId);
      this.#advanceRevision(input.workspaceId);
    }
    return this.#publishSnapshot(input.workspaceId);
  }

  public async restart(input: TerminalSessionTargetInput): Promise<TerminalSnapshot> {
    const token = this.#captureWorkspace(input.workspaceId);
    const requestSequence = this.#beginConfigurationRequest();
    const session = this.#getOwnedSession(input);
    if (session.info.status !== 'exited' || session.process || session.restarting) {
      throw new Error('Only an exited terminal session can be restarted');
    }
    session.restarting = true;
    try {
      await this.#settlePendingProcessKills(input.workspaceId);
      this.#assertWorkspaceToken(token);
      const state = await this.#configurationService.revalidateLaunch(
        input.workspaceId,
        session.launch,
      );
      this.#assertWorkspaceToken(token);
      if (
        this.#sessions.get(input.sessionId) !== session ||
        session.closing ||
        session.info.status !== 'exited' ||
        session.process
      ) {
        throw new Error('The terminal session is no longer available');
      }
      this.#cacheState(input.workspaceId, state, requestSequence);
      this.#assertProcessCapacity(input.workspaceId);

      session.info = {
        ...session.info,
        status: 'running',
      };
      delete (session.info as { exitCode?: number }).exitCode;
      try {
        this.#spawn(session);
        this.#assertWorkspaceToken(token);
      } catch {
        this.#terminateSessionProcess(session);
        session.info = { ...session.info, status: 'exited', exitCode: -1 };
        throw new Error(`Unable to restart the ${session.launch.label} terminal profile`);
      }

      this.#activeSessionIds.set(input.workspaceId, input.sessionId);
      this.#advanceRevision(input.workspaceId);
      return this.#publishSnapshot(input.workspaceId);
    } finally {
      if (this.#sessions.get(input.sessionId) === session) {
        session.restarting = false;
      }
    }
  }

  public write(input: TerminalWriteInput): void {
    const session = this.#getRunningSession(input);
    try {
      session.process?.write(input.data);
    } catch {
      throw new Error('Unable to write to the terminal session');
    }
  }

  public resize(input: TerminalResizeInput): void {
    const session = this.#getRunningSession(input);
    try {
      session.process?.resize(input.columns, input.rows);
    } catch {
      throw new Error('Unable to resize the terminal session');
    }
  }

  public clear(input: TerminalSessionTargetInput): void {
    const session = this.#getOwnedSession(input);
    if (session.info.status !== 'running' || !session.process || session.closing) return;
    try {
      session.process.clear();
    } catch {
      throw new Error('Unable to clear the terminal session');
    }
  }

  public async close(input: TerminalSessionTargetInput): Promise<TerminalSnapshot> {
    this.#captureWorkspace(input.workspaceId);
    const session = this.#getOwnedSession(input);
    const workspaceSessions = this.#workspaceSessions(input.workspaceId);
    const closedIndex = workspaceSessions.indexOf(session);
    this.#discardSession(session);

    if (this.#activeSessionIds.get(input.workspaceId) === input.sessionId) {
      const remaining = this.#workspaceSessions(input.workspaceId);
      const fallback =
        remaining[Math.min(closedIndex, Math.max(0, remaining.length - 1))] ?? remaining[0];
      if (fallback) {
        this.#activeSessionIds.set(input.workspaceId, fallback.info.id);
      } else {
        this.#activeSessionIds.delete(input.workspaceId);
      }
    }
    this.#advanceRevision(input.workspaceId);
    const snapshot = this.#publishSnapshot(input.workspaceId);
    await this.#settlePendingProcessKills(input.workspaceId);
    return snapshot;
  }

  public setActiveWorkspace(workspaceId: string): void {
    if (!this.#accepting || this.#activeWorkspaceId === workspaceId) return;
    this.#activeWorkspaceId = workspaceId;
    this.#workspaceGeneration += 1;
  }

  public discardWorkspace(workspaceId: string): void {
    const sessions = this.#workspaceSessions(workspaceId);
    for (const session of sessions) this.#discardSession(session);
    this.#activeSessionIds.delete(workspaceId);
    if (this.#configurationStates.has(workspaceId)) {
      this.#advanceRevision(workspaceId);
      this.#publishSnapshot(workspaceId);
    }
    this.#configurationStates.delete(workspaceId);
    this.#revisions.delete(workspaceId);
    void this.#settlePendingProcessKills(workspaceId).catch(() => {
      // Retain failed native handles for bounded capacity and the final shutdown retry.
    });
  }

  public shutdown(): Promise<void> {
    if (this.#shutdownPromise) return this.#shutdownPromise;
    this.#accepting = false;
    this.#workspaceGeneration += 1;
    let configurationStopFailed = false;
    try {
      this.#configurationService.stop();
    } catch {
      configurationStopFailed = true;
    }
    for (const session of [...this.#sessions.values()]) this.#discardSession(session);
    this.#activeSessionIds.clear();
    this.#configurationStates.clear();
    this.#shutdownPromise = this.#settlePendingProcessKills().then(() => {
      if (configurationStopFailed) {
        throw new Error('Unable to stop terminal configuration services');
      }
    });
    return this.#shutdownPromise;
  }

  #spawn(session: ManagedSession): void {
    const launch = session.launch;
    const process = this.#ptyFactory.spawn(launch.executable, [...launch.args], {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: launch.cwd,
      env: createTerminalEnvironment(this.#environment, this.#platform),
    });
    session.process = process;
    session.dataSubscription = process.onData((data) => {
      if (
        this.#sessions.get(session.info.id) !== session ||
        session.closing ||
        session.process !== process ||
        session.info.status !== 'running'
      ) {
        return;
      }
      for (const chunk of splitTerminalOutput(data)) {
        session.sequence += 1;
        this.#safeSink(() =>
          this.#eventSink.data({
            workspaceId: session.info.workspaceId,
            sessionId: session.info.id,
            sequence: session.sequence,
            data: chunk,
          }),
        );
      }
    });
    session.exitSubscription = process.onExit((event) => {
      if (
        this.#sessions.get(session.info.id) !== session ||
        session.closing ||
        session.process !== process
      ) {
        return;
      }
      this.#disposeProcessBindings(session);
      session.info = {
        ...session.info,
        status: 'exited',
        exitCode: event.exitCode,
      };
      this.#cleanupExitedProcess(process, session.info.workspaceId);
      this.#advanceRevision(session.info.workspaceId);
      this.#safeSink(() =>
        this.#eventSink.exit({
          workspaceId: session.info.workspaceId,
          sessionId: session.info.id,
          exitCode: event.exitCode,
          ...(event.signal === undefined ? {} : { signal: event.signal }),
        }),
      );
      this.#publishSnapshot(session.info.workspaceId);
    });
  }

  #cleanupExitedProcess(process: nodePty.IPty, workspaceId: string): void {
    if (this.#platform !== 'win32') return;
    // On Windows, node-pty can report the shell exit while ConPTY helper handles remain alive.
    // Retain the old handle before asking node-pty to release those resources; a failed cleanup
    // remains capacity-bounded and must settle before this tab can be restarted.
    this.#retainPendingProcessKill(process, workspaceId, true);
    this.#attemptPendingProcessKill(process);
  }

  #getRunningSession(input: TerminalSessionTargetInput): ManagedSession {
    const session = this.#getOwnedSession(input);
    if (session.info.status !== 'running' || !session.process || session.closing) {
      throw new Error('The terminal session is not running');
    }
    return session;
  }

  #getOwnedSession(input: TerminalSessionTargetInput): ManagedSession {
    this.#assertActiveWorkspace(input.workspaceId);
    const session = this.#sessions.get(input.sessionId);
    if (!session || session.info.workspaceId !== input.workspaceId || session.closing) {
      throw new Error('The terminal session was not found in this workspace');
    }
    return session;
  }

  #captureWorkspace(workspaceId: string): WorkspaceToken {
    this.#assertActiveWorkspace(workspaceId);
    return { workspaceId, generation: this.#workspaceGeneration };
  }

  #assertWorkspaceToken(token: WorkspaceToken): void {
    this.#assertActiveWorkspace(token.workspaceId);
    if (token.generation !== this.#workspaceGeneration) {
      throw new Error('The active workspace changed while the terminal request was pending');
    }
  }

  #assertActiveWorkspace(workspaceId: string): void {
    if (!this.#accepting) throw new Error('Terminal operations are shutting down');
    if (workspaceId !== this.#activeWorkspaceId) {
      throw new Error('Terminal operations are only allowed in the active workspace');
    }
  }

  #assertCapacity(workspaceId: string): void {
    const pendingWorkspaceProcesses = [...this.#pendingProcessKills.values()].filter(
      (pending) => pending.workspaceId === workspaceId,
    ).length;
    if (
      this.#workspaceSessions(workspaceId).length + pendingWorkspaceProcesses >=
      MAX_SESSIONS_PER_WORKSPACE
    ) {
      throw new Error(`A workspace can keep at most ${MAX_SESSIONS_PER_WORKSPACE} terminals`);
    }
    if (this.#sessions.size + this.#pendingProcessKills.size >= MAX_SESSIONS_PER_WINDOW) {
      throw new Error(`The window can keep at most ${MAX_SESSIONS_PER_WINDOW} terminals`);
    }
  }

  #assertProcessCapacity(workspaceId: string): void {
    const workspaceProcessCount =
      this.#workspaceSessions(workspaceId).filter(({ process }) => process !== null).length +
      [...this.#pendingProcessKills.values()].filter(
        (pending) => pending.workspaceId === workspaceId,
      ).length;
    if (workspaceProcessCount >= MAX_SESSIONS_PER_WORKSPACE) {
      throw new Error(
        `A workspace can keep at most ${MAX_SESSIONS_PER_WORKSPACE} terminal processes`,
      );
    }
    const windowProcessCount =
      [...this.#sessions.values()].filter(({ process }) => process !== null).length +
      this.#pendingProcessKills.size;
    if (windowProcessCount >= MAX_SESSIONS_PER_WINDOW) {
      throw new Error(`The window can keep at most ${MAX_SESSIONS_PER_WINDOW} terminal processes`);
    }
  }

  #createUniqueId(): string {
    for (let attempts = 0; attempts < 10; attempts += 1) {
      const id = this.#idFactory();
      if (!this.#sessions.has(id)) return id;
    }
    throw new Error('Unable to allocate a unique terminal session');
  }

  #discardSession(session: ManagedSession): void {
    if (session.closing) return;
    session.closing = true;
    this.#sessions.delete(session.info.id);
    this.#terminateSessionProcess(session);
  }

  #disposeProcessBindings(session: ManagedSession): void {
    const dataSubscription = session.dataSubscription;
    const exitSubscription = session.exitSubscription;
    session.dataSubscription = null;
    session.exitSubscription = null;
    session.process = null;
    try {
      dataSubscription?.dispose();
    } catch {
      // Native subscription teardown is best-effort.
    }
    try {
      exitSubscription?.dispose();
    } catch {
      // Native subscription teardown is best-effort.
    }
  }

  #terminateSessionProcess(session: ManagedSession): void {
    const process = session.process;
    if (!process) {
      this.#disposeProcessBindings(session);
      return;
    }
    this.#retainPendingProcessKill(process, session.info.workspaceId, false);
    this.#disposeProcessBindings(session);
    this.#attemptPendingProcessKill(process);
  }

  #retainPendingProcessKill(
    process: nodePty.IPty,
    workspaceId: string,
    exitObserved: boolean,
  ): PendingProcessKill {
    const existing = this.#pendingProcessKills.get(process);
    if (existing) {
      if (exitObserved) {
        existing.exitObserved = true;
        this.#completePendingProcessKill(process);
      }
      return existing;
    }
    let resolveSettled = (): void => undefined;
    const settled = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });
    const pending: PendingProcessKill = {
      process,
      workspaceId,
      settled,
      resolveSettled,
      exitSubscription: null,
      exitObserved,
      killAccepted: false,
    };
    this.#pendingProcessKills.set(process, pending);
    if (!exitObserved) {
      try {
        pending.exitSubscription = process.onExit(() => {
          pending.exitObserved = true;
          this.#completePendingProcessKill(process);
        });
      } catch {
        // A failed observer keeps the handle retained until bounded shutdown reports failure.
      }
    }
    return pending;
  }

  #attemptPendingProcessKill(process: nodePty.IPty): void {
    const pending = this.#pendingProcessKills.get(process);
    if (!pending) return;
    try {
      process.kill();
      pending.killAccepted = true;
      this.#completePendingProcessKill(process);
    } catch {
      pending.killAccepted = false;
    }
  }

  #completePendingProcessKill(process: nodePty.IPty): void {
    const pending = this.#pendingProcessKills.get(process);
    // A returned kill call alone does not prove native exit, while exit alone does not make
    // node-pty release its Windows ConPTY worker. Both facts are required before dropping the
    // only handle that can finish cleanup.
    if (!pending || !pending.exitObserved || !pending.killAccepted) return;
    this.#pendingProcessKills.delete(process);
    try {
      pending.exitSubscription?.dispose();
    } catch {
      // The process is already gone; listener disposal cannot make cleanup fail.
    }
    pending.exitSubscription = null;
    pending.resolveSettled();
  }

  async #settlePendingProcessKills(workspaceId?: string): Promise<void> {
    for (let round = 0; round < PROCESS_KILL_ATTEMPTS; round += 1) {
      let pending = this.#pendingKillsForWorkspace(workspaceId);
      if (pending.length === 0) return;
      for (const entry of pending) {
        if (!entry.killAccepted) {
          this.#attemptPendingProcessKill(entry.process);
        }
      }
      pending = this.#pendingKillsForWorkspace(workspaceId);
      if (pending.length === 0) return;
      await waitForProcessExits(pending, PROCESS_EXIT_WAIT_MS);
    }
    if (this.#pendingKillsForWorkspace(workspaceId).length > 0) {
      throw new Error(
        workspaceId
          ? 'Unable to stop every terminal process in this workspace'
          : 'Unable to stop every terminal process',
      );
    }
  }

  #pendingKillsForWorkspace(workspaceId?: string): PendingProcessKill[] {
    return [...this.#pendingProcessKills.values()].filter(
      (pending) => workspaceId === undefined || pending.workspaceId === workspaceId,
    );
  }

  #workspaceSessions(workspaceId: string): ManagedSession[] {
    return [...this.#sessions.values()].filter(({ info }) => info.workspaceId === workspaceId);
  }

  #beginConfigurationRequest(): number {
    this.#configurationRequestSequence += 1;
    return this.#configurationRequestSequence;
  }

  #cacheResolvedLaunch(
    workspaceId: string,
    resolved: ResolvedTerminalLaunch,
    requestSequence: number,
  ): void {
    this.#cacheState(workspaceId, resolved.state, requestSequence);
  }

  #cacheState(
    workspaceId: string,
    state: TerminalConfigurationState,
    requestSequence: number,
  ): void {
    const current = this.#configurationStates.get(workspaceId);
    if (current && compareConfigurationStates(state, requestSequence, current) < 0) {
      return;
    }
    this.#configurationStates.set(workspaceId, { state, requestSequence });
  }

  #advanceRevision(workspaceId: string): void {
    this.#revisions.set(workspaceId, (this.#revisions.get(workspaceId) ?? 0) + 1);
  }

  #snapshot(workspaceId: string): TerminalSnapshot {
    const cached = this.#configurationStates.get(workspaceId);
    if (!cached) {
      throw new Error('Terminal configuration has not been loaded for this workspace.');
    }
    const { state } = cached;
    const sessions = this.#workspaceSessions(workspaceId).map(({ info }) => ({ ...info }));
    const activeSessionId = this.#activeSessionIds.get(workspaceId);
    return {
      workspaceId,
      revision: this.#revisions.get(workspaceId) ?? 0,
      activeSessionId:
        activeSessionId && sessions.some(({ id }) => id === activeSessionId)
          ? activeSessionId
          : (sessions[0]?.id ?? null),
      sessions,
      profiles: state.profiles.map(({ profile }) => ({ ...profile })),
      configuration: {
        ...state.configuration,
        workingDirectory: { ...state.configuration.workingDirectory },
        wsl: {
          ...state.configuration.wsl,
          distributions: state.configuration.wsl.distributions.map((distribution) => ({
            ...distribution,
          })),
        },
      },
    };
  }

  #publishSnapshot(workspaceId: string): TerminalSnapshot {
    const snapshot = this.#snapshot(workspaceId);
    this.#safeSink(() => this.#eventSink.stateChanged(snapshot));
    return snapshot;
  }

  #safeSink(send: () => void): void {
    try {
      send();
    } catch {
      // A disappearing Renderer must not corrupt native terminal lifecycle state.
    }
  }
}

function waitForProcessExits(
  pending: readonly PendingProcessKill[],
  milliseconds: number,
): Promise<void> {
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, milliseconds);
    void Promise.all(pending.map(({ settled }) => settled)).then(() => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

function compareConfigurationStates(
  candidate: TerminalConfigurationState,
  requestSequence: number,
  current: CachedConfigurationState,
): number {
  const configurationRevision =
    candidate.configuration.revision - current.state.configuration.revision;
  if (configurationRevision !== 0) return configurationRevision;
  const capabilityRevision =
    candidate.configuration.wsl.capabilityRevision -
    current.state.configuration.wsl.capabilityRevision;
  if (capabilityRevision !== 0) return capabilityRevision;
  return requestSequence - current.requestSequence;
}

function freezeLaunchConfiguration(
  launch: TerminalLaunchConfiguration,
): TerminalLaunchConfiguration {
  return Object.freeze({
    profileId: launch.profileId,
    profileKind: launch.profileKind,
    label: launch.label,
    executable: launch.executable,
    args: Object.freeze([...launch.args]),
    cwd: launch.cwd,
    wslDistributionName: launch.wslDistributionName,
  });
}

function splitTerminalOutput(data: string): string[] {
  const chunks: string[] = [];
  let offset = 0;
  while (offset < data.length) {
    let end = Math.min(offset + MAX_DATA_EVENT_CODE_UNITS, data.length);
    if (
      end < data.length &&
      end > offset &&
      isHighSurrogate(data.charCodeAt(end - 1)) &&
      isLowSurrogate(data.charCodeAt(end))
    ) {
      end -= 1;
    }
    chunks.push(data.slice(offset, end));
    offset = end;
  }
  return chunks;
}

function isHighSurrogate(value: number): boolean {
  return value >= 0xd800 && value <= 0xdbff;
}

function isLowSurrogate(value: number): boolean {
  return value >= 0xdc00 && value <= 0xdfff;
}
