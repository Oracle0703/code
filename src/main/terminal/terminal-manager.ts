import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import * as nodePty from 'node-pty';
import type {
  TerminalCreateOptions,
  TerminalDataEvent,
  TerminalExitEvent,
  TerminalSessionInfo,
  TerminalShell,
} from '../../shared/contracts';
import { createTerminalEnvironment } from './terminal-environment';

interface ResolvedShell {
  executable: string;
  args: string[];
  profile: TerminalShell;
}

interface ManagedSession {
  process: nodePty.IPty;
  dataSubscription: nodePty.IDisposable;
  exitSubscription: nodePty.IDisposable;
}

interface TerminalEventSink {
  data(event: TerminalDataEvent): void;
  exit(event: TerminalExitEvent): void;
}

export class TerminalManager {
  private readonly sessions = new Map<string, ManagedSession>();

  public constructor(private readonly eventSink: TerminalEventSink) {}

  public create(options: TerminalCreateOptions): TerminalSessionInfo {
    const cwd = this.resolveWorkingDirectory(options.cwd);
    const shell = this.resolveShell(options.shell ?? 'default');
    const id = randomUUID();

    let ptyProcess: nodePty.IPty;
    try {
      ptyProcess = nodePty.spawn(shell.executable, shell.args, {
        name: 'xterm-256color',
        cols: 120,
        rows: 30,
        cwd,
        env: createTerminalEnvironment(process.env, process.platform),
      });
    } catch {
      throw new Error(`Unable to start the ${shell.profile} terminal profile`);
    }

    const dataSubscription = ptyProcess.onData((data) => {
      if (this.sessions.has(id)) {
        this.eventSink.data({ id, data });
      }
    });
    const exitSubscription = ptyProcess.onExit((event) => {
      const session = this.sessions.get(id);
      if (!session) {
        return;
      }

      this.sessions.delete(id);
      session.dataSubscription.dispose();
      session.exitSubscription.dispose();
      this.eventSink.exit({
        id,
        exitCode: event.exitCode,
        ...(event.signal === undefined ? {} : { signal: event.signal }),
      });
    });

    this.sessions.set(id, {
      process: ptyProcess,
      dataSubscription,
      exitSubscription,
    });

    return { id, shell: shell.profile, cwd };
  }

  public write(id: string, data: string): void {
    this.getSession(id).process.write(data);
  }

  public resize(id: string, columns: number, rows: number): void {
    this.getSession(id).process.resize(columns, rows);
  }

  public close(id: string): void {
    const session = this.getSession(id);
    try {
      session.process.kill();
    } catch {
      this.disposeSession(id, session);
      throw new Error('Unable to close the terminal session');
    }
  }

  public closeAll(): void {
    for (const [id, session] of this.sessions) {
      this.disposeSession(id, session);
      try {
        session.process.kill();
      } catch {
        // The child process may already have exited while the app is closing.
      }
    }
  }

  private disposeSession(id: string, session: ManagedSession): void {
    this.sessions.delete(id);
    session.dataSubscription.dispose();
    session.exitSubscription.dispose();
  }

  private getSession(id: string): ManagedSession {
    const session = this.sessions.get(id);
    if (!session) {
      throw new Error('Terminal session was not found');
    }
    return session;
  }

  private resolveWorkingDirectory(input?: string): string {
    const home = homedir();
    let candidate = input?.trim() || home;

    if (candidate === '~') {
      candidate = home;
    } else if (candidate.startsWith('~/') || candidate.startsWith('~\\')) {
      candidate = join(home, candidate.slice(2));
    }

    const absolutePath = resolve(candidate);
    try {
      if (!statSync(absolutePath).isDirectory()) {
        throw new Error('not a directory');
      }
    } catch {
      throw new Error('The terminal working directory does not exist');
    }

    return absolutePath;
  }

  private resolveShell(requested: TerminalShell): ResolvedShell {
    return process.platform === 'win32'
      ? this.resolveWindowsShell(requested)
      : this.resolveUnixShell(requested);
  }

  private resolveWindowsShell(requested: TerminalShell): ResolvedShell {
    if (requested === 'bash' || requested === 'zsh') {
      throw new Error(`The ${requested} profile is not available on Windows; use WSL instead`);
    }

    const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
    const programFiles =
      process.env.ProgramW6432 || process.env.ProgramFiles || 'C:\\Program Files';
    const powershell7 = join(programFiles, 'PowerShell', '7', 'pwsh.exe');
    const windowsPowerShell = join(
      systemRoot,
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    );
    const powershell = this.firstExisting([powershell7, windowsPowerShell]);
    const commandPrompt = process.env.ComSpec || join(systemRoot, 'System32', 'cmd.exe');
    const wsl = join(systemRoot, 'System32', 'wsl.exe');

    if (requested === 'wsl') {
      this.assertExecutableExists(wsl, 'WSL');
      return { executable: wsl, args: [], profile: 'wsl' };
    }

    if (requested === 'cmd') {
      this.assertExecutableExists(commandPrompt, 'Command Prompt');
      return { executable: commandPrompt, args: [], profile: 'cmd' };
    }

    if (requested === 'powershell') {
      if (!powershell) {
        throw new Error('PowerShell is not installed');
      }
      return { executable: powershell, args: ['-NoLogo'], profile: 'powershell' };
    }

    if (powershell) {
      return { executable: powershell, args: ['-NoLogo'], profile: 'powershell' };
    }

    this.assertExecutableExists(commandPrompt, 'Command Prompt');
    return { executable: commandPrompt, args: [], profile: 'cmd' };
  }

  private resolveUnixShell(requested: TerminalShell): ResolvedShell {
    if (requested === 'cmd' || requested === 'wsl') {
      throw new Error(`The ${requested} terminal profile is only available on Windows`);
    }

    if (requested === 'powershell') {
      const powershell = this.firstExisting([
        '/opt/homebrew/bin/pwsh',
        '/usr/local/bin/pwsh',
        '/usr/bin/pwsh',
      ]);
      if (!powershell) {
        throw new Error('PowerShell is not installed');
      }
      return { executable: powershell, args: ['-NoLogo'], profile: 'powershell' };
    }

    if (requested === 'bash' || requested === 'zsh') {
      const configuredShell = process.env.SHELL;
      const executable = this.firstExisting([
        ...(configuredShell && basename(configuredShell) === requested ? [configuredShell] : []),
        `/bin/${requested}`,
        `/usr/bin/${requested}`,
      ]);
      if (!executable) {
        throw new Error(`The ${requested} shell is not installed`);
      }
      return { executable, args: ['-l'], profile: requested };
    }

    const configuredShell = process.env.SHELL;
    const executable = this.firstExisting([
      ...(configuredShell ? [configuredShell] : []),
      '/bin/zsh',
      '/bin/bash',
      '/bin/sh',
    ]);
    if (!executable) {
      throw new Error('No supported system shell was found');
    }

    const shellName = basename(executable);
    const profile: TerminalShell =
      shellName === 'zsh' || shellName === 'bash' ? shellName : 'default';
    return { executable, args: ['-l'], profile };
  }

  private assertExecutableExists(path: string, label: string): void {
    if (!existsSync(path)) {
      throw new Error(`${label} is not installed`);
    }
  }

  private firstExisting(candidates: string[]): string | undefined {
    return candidates.find((candidate) => existsSync(candidate));
  }
}
