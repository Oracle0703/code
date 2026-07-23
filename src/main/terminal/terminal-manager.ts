import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import * as nodePty from 'node-pty';
import type {
  TerminalCreateInput,
  TerminalDataEvent,
  TerminalExitEvent,
  TerminalResizeInput,
  TerminalSession,
  TerminalSessionTargetInput,
  TerminalSnapshot,
  TerminalWorkspaceInput,
  TerminalWriteInput,
} from '../../shared/contracts';
import { createTerminalEnvironment } from './terminal-environment';
import {
  TerminalProfileResolver,
  type ResolvedTerminalProfile,
  type TerminalProfileResolverLike,
} from './terminal-profile-resolver';

const MAX_SESSIONS_PER_WORKSPACE = 8;
const MAX_SESSIONS_PER_WINDOW = 16;
const MAX_DATA_EVENT_CODE_UNITS = 64 * 1024;

interface ManagedSession {
  info: TerminalSession;
  process: nodePty.IPty | null;
  dataSubscription: nodePty.IDisposable | null;
  exitSubscription: nodePty.IDisposable | null;
  sequence: number;
  closing: boolean;
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

interface TerminalManagerOptions {
  readonly initialWorkspaceId: string;
  readonly eventSink: TerminalEventSink;
  readonly profileResolver?: TerminalProfileResolverLike;
  readonly ptyFactory?: TerminalPtyFactory;
  readonly now?: () => Date;
  readonly idFactory?: () => string;
  readonly workingDirectory?: () => string;
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
  exitSubscription: nodePty.IDisposable | null;
}

export class TerminalManager {
  readonly #sessions = new Map<string, ManagedSession>();
  readonly #pendingProcessKills = new Map<nodePty.IPty, PendingProcessKill>();
  readonly #activeSessionIds = new Map<string, string>();
  readonly #revisions = new Map<string, number>();
  readonly #eventSink: TerminalEventSink;
  readonly #profileResolver: TerminalProfileResolverLike;
  readonly #ptyFactory: TerminalPtyFactory;
  readonly #now: () => Date;
  readonly #idFactory: () => string;
  readonly #workingDirectory: () => string;
  readonly #platform: NodeJS.Platform;
  readonly #environment: NodeJS.ProcessEnv;
  #profiles: readonly ResolvedTerminalProfile[] = [];
  #activeWorkspaceId: string;
  #workspaceGeneration = 0;
  #accepting = true;
  #shutdownPromise: Promise<void> | null = null;

  public constructor(options: TerminalManagerOptions) {
    this.#activeWorkspaceId = options.initialWorkspaceId;
    this.#eventSink = options.eventSink;
    this.#profileResolver = options.profileResolver ?? new TerminalProfileResolver();
    this.#ptyFactory = options.ptyFactory ?? nodePty;
    this.#now = options.now ?? (() => new Date());
    this.#idFactory = options.idFactory ?? randomUUID;
    this.#workingDirectory = options.workingDirectory ?? homedir;
    this.#platform = options.platform ?? process.platform;
    this.#environment = options.environment ?? process.env;
  }

  public async getSnapshot(input: TerminalWorkspaceInput): Promise<TerminalSnapshot> {
    const token = this.#captureWorkspace(input.workspaceId);
    await this.#ensureProfiles();
    this.#assertWorkspaceToken(token);
    return this.#snapshot(input.workspaceId);
  }

  public async create(input: TerminalCreateInput): Promise<TerminalSnapshot> {
    const token = this.#captureWorkspace(input.workspaceId);
    const profiles = await this.#ensureProfiles();
    this.#assertWorkspaceToken(token);
    const profile = profiles.find(({ profile: candidate }) => candidate.id === input.profileId);
    if (!profile?.profile.available || !profile.executable) {
      throw new Error(profile?.profile.unavailableReason ?? 'The terminal profile is unavailable');
    }
    this.#assertCapacity(input.workspaceId);

    const id = this.#createUniqueId();
    const session: ManagedSession = {
      info: {
        id,
        workspaceId: input.workspaceId,
        profileId: profile.profile.id,
        label: profile.profile.label,
        status: 'running',
        createdAt: this.#now().toISOString(),
      },
      process: null,
      dataSubscription: null,
      exitSubscription: null,
      sequence: 0,
      closing: false,
    };
    this.#sessions.set(id, session);
    try {
      this.#spawn(session, profile);
      this.#assertWorkspaceToken(token);
    } catch {
      this.#discardSession(session);
      throw new Error(`Unable to start the ${profile.profile.label} terminal profile`);
    }

    this.#activeSessionIds.set(input.workspaceId, id);
    this.#advanceRevision(input.workspaceId);
    return this.#publishSnapshot(input.workspaceId);
  }

  public async activate(input: TerminalSessionTargetInput): Promise<TerminalSnapshot> {
    const token = this.#captureWorkspace(input.workspaceId);
    await this.#ensureProfiles();
    this.#assertWorkspaceToken(token);
    this.#getOwnedSession(input);
    if (this.#activeSessionIds.get(input.workspaceId) !== input.sessionId) {
      this.#activeSessionIds.set(input.workspaceId, input.sessionId);
      this.#advanceRevision(input.workspaceId);
    }
    return this.#publishSnapshot(input.workspaceId);
  }

  public async restart(input: TerminalSessionTargetInput): Promise<TerminalSnapshot> {
    const token = this.#captureWorkspace(input.workspaceId);
    const session = this.#getOwnedSession(input);
    if (session.info.status !== 'exited' || session.process) {
      throw new Error('Only an exited terminal session can be restarted');
    }
    const profiles = await this.#ensureProfiles();
    this.#assertWorkspaceToken(token);
    if (
      this.#sessions.get(input.sessionId) !== session ||
      session.closing ||
      session.info.status !== 'exited' ||
      session.process
    ) {
      throw new Error('The terminal session is no longer available');
    }
    const profile = profiles.find(
      ({ profile: candidate }) => candidate.id === session.info.profileId,
    );
    if (!profile?.profile.available || !profile.executable) {
      throw new Error(profile?.profile.unavailableReason ?? 'The terminal profile is unavailable');
    }
    this.#assertProcessCapacity(input.workspaceId);

    session.info = {
      ...session.info,
      label: profile.profile.label,
      status: 'running',
    };
    delete (session.info as { exitCode?: number }).exitCode;
    try {
      this.#spawn(session, profile);
      this.#assertWorkspaceToken(token);
    } catch {
      this.#terminateSessionProcess(session);
      session.info = { ...session.info, status: 'exited', exitCode: -1 };
      throw new Error(`Unable to restart the ${profile.profile.label} terminal profile`);
    }

    this.#activeSessionIds.set(input.workspaceId, input.sessionId);
    this.#advanceRevision(input.workspaceId);
    return this.#publishSnapshot(input.workspaceId);
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
    const token = this.#captureWorkspace(input.workspaceId);
    await this.#ensureProfiles();
    this.#assertWorkspaceToken(token);
    const session = this.#getOwnedSession(input);
    const workspaceSessions = this.#workspaceSessions(input.workspaceId);
    const closedIndex = workspaceSessions.indexOf(session);
    this.#discardSession(session);
    this.#retryPendingProcessKills(input.workspaceId);

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
    this.#assertWorkspaceProcessesStopped(input.workspaceId);
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
    this.#retryPendingProcessKills(workspaceId);
    this.#activeSessionIds.delete(workspaceId);
    this.#advanceRevision(workspaceId);
    this.#publishSnapshot(workspaceId);
    this.#assertWorkspaceProcessesStopped(workspaceId);
  }

  public shutdown(): Promise<void> {
    this.#shutdownPromise ??= Promise.resolve().then(() => {
      this.#accepting = false;
      this.#workspaceGeneration += 1;
      for (const session of [...this.#sessions.values()]) this.#discardSession(session);
      this.#activeSessionIds.clear();
      this.#retryPendingProcessKills();
      if (this.#pendingProcessKills.size > 0) {
        throw new Error('Unable to stop every terminal process');
      }
    });
    return this.#shutdownPromise;
  }

  #spawn(session: ManagedSession, profile: ResolvedTerminalProfile): void {
    if (!profile.executable) throw new Error('profile unavailable');
    const process = this.#ptyFactory.spawn(profile.executable, [...profile.args], {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: this.#workingDirectory(),
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

  async #ensureProfiles(): Promise<readonly ResolvedTerminalProfile[]> {
    if (this.#profiles.length > 0) return this.#profiles;
    try {
      this.#profiles = await this.#profileResolver.listProfiles();
      return this.#profiles;
    } catch {
      throw new Error('Unable to discover terminal profiles');
    }
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

  #terminateSessionProcess(session: ManagedSession): boolean {
    const process = session.process;
    if (!process) {
      this.#disposeProcessBindings(session);
      return true;
    }
    if (!this.#pendingProcessKills.has(process)) {
      const pending: PendingProcessKill = {
        process,
        workspaceId: session.info.workspaceId,
        exitSubscription: null,
      };
      this.#pendingProcessKills.set(process, pending);
      try {
        pending.exitSubscription = process.onExit(() => {
          this.#completePendingProcessKill(process);
        });
      } catch {
        // A later explicit retry still retains the native handle.
      }
    }
    this.#disposeProcessBindings(session);
    return this.#attemptPendingProcessKill(process);
  }

  #attemptPendingProcessKill(process: nodePty.IPty): boolean {
    if (!this.#pendingProcessKills.has(process)) return true;
    try {
      process.kill();
      this.#completePendingProcessKill(process);
      return true;
    } catch {
      // Keep the handle reachable and counted until a later retry or native exit succeeds.
      return !this.#pendingProcessKills.has(process);
    }
  }

  #completePendingProcessKill(process: nodePty.IPty): void {
    const pending = this.#pendingProcessKills.get(process);
    if (!pending) return;
    this.#pendingProcessKills.delete(process);
    try {
      pending.exitSubscription?.dispose();
    } catch {
      // The native process is already gone; listener disposal cannot make cleanup fail.
    }
    pending.exitSubscription = null;
  }

  #retryPendingProcessKills(workspaceId?: string): void {
    for (const pending of [...this.#pendingProcessKills.values()]) {
      if (workspaceId && pending.workspaceId !== workspaceId) continue;
      this.#attemptPendingProcessKill(pending.process);
    }
  }

  #assertWorkspaceProcessesStopped(workspaceId: string): void {
    if (
      [...this.#pendingProcessKills.values()].some((pending) => pending.workspaceId === workspaceId)
    ) {
      throw new Error('Unable to stop every terminal process in this workspace');
    }
  }

  #workspaceSessions(workspaceId: string): ManagedSession[] {
    return [...this.#sessions.values()].filter(({ info }) => info.workspaceId === workspaceId);
  }

  #advanceRevision(workspaceId: string): void {
    this.#revisions.set(workspaceId, (this.#revisions.get(workspaceId) ?? 0) + 1);
  }

  #snapshot(workspaceId: string): TerminalSnapshot {
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
      profiles: this.#profiles.map(({ profile }) => ({ ...profile })),
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
