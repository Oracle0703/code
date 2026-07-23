import { execFile } from 'node:child_process';
import { constants, accessSync, realpathSync, statSync } from 'node:fs';
import { basename, isAbsolute, win32 } from 'node:path';
import type {
  TerminalProfile,
  TerminalProfileId,
  TerminalProfileKind,
} from '../../shared/contracts';

const WSL_PROBE_TIMEOUT_MS = 3_000;
const WSL_PROBE_MAX_BYTES = 64 * 1024;

export interface ResolvedTerminalProfile {
  readonly profile: TerminalProfile;
  readonly executable?: string;
  readonly args: readonly string[];
}

export interface TerminalProfileResolverLike {
  listProfiles(): Promise<readonly ResolvedTerminalProfile[]>;
}

export interface TerminalProfileResolverOptions {
  readonly platform?: NodeJS.Platform;
  readonly environment?: NodeJS.ProcessEnv;
  readonly resolveExecutable?: (candidates: readonly string[]) => string | undefined;
  readonly probeWsl?: (executable: string) => Promise<boolean>;
}

export class TerminalProfileResolver implements TerminalProfileResolverLike {
  readonly #platform: NodeJS.Platform;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #resolveExecutable: (candidates: readonly string[]) => string | undefined;
  readonly #probeWsl: (executable: string) => Promise<boolean>;
  #profilesPromise: Promise<readonly ResolvedTerminalProfile[]> | null = null;

  public constructor(options: TerminalProfileResolverOptions = {}) {
    this.#platform = options.platform ?? process.platform;
    this.#environment = options.environment ?? process.env;
    this.#resolveExecutable = options.resolveExecutable ?? firstExecutable;
    this.#probeWsl = options.probeWsl ?? probeDefaultWslDistribution;
  }

  public listProfiles(): Promise<readonly ResolvedTerminalProfile[]> {
    this.#profilesPromise ??= this.#discoverProfiles();
    return this.#profilesPromise;
  }

  async #discoverProfiles(): Promise<readonly ResolvedTerminalProfile[]> {
    const profiles =
      this.#platform === 'win32'
        ? await this.#discoverWindowsProfiles()
        : this.#discoverPosixProfiles();
    return Object.freeze(
      profiles.map((profile) =>
        Object.freeze({
          ...profile,
          profile: Object.freeze({ ...profile.profile }),
          args: Object.freeze([...profile.args]),
        }),
      ),
    );
  }

  async #discoverWindowsProfiles(): Promise<ResolvedTerminalProfile[]> {
    const systemRoot = this.#environment.SystemRoot || this.#environment.WINDIR || 'C:\\Windows';
    const programFiles =
      this.#environment.ProgramW6432 || this.#environment.ProgramFiles || 'C:\\Program Files';
    const powershell7 = this.#resolveExecutable([
      win32.join(programFiles, 'PowerShell', '7', 'pwsh.exe'),
    ]);
    const windowsPowerShell = this.#resolveExecutable([
      win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ]);
    const commandPrompt = this.#resolveExecutable([win32.join(systemRoot, 'System32', 'cmd.exe')]);
    const wslExecutable = this.#resolveExecutable([win32.join(systemRoot, 'System32', 'wsl.exe')]);
    const wslAvailable = wslExecutable ? await this.#probeWsl(wslExecutable) : false;
    const systemDefault = powershell7
      ? {
          executable: powershell7,
          args: ['-NoLogo'],
          label: '系统默认（PowerShell 7）',
        }
      : windowsPowerShell
        ? {
            executable: windowsPowerShell,
            args: ['-NoLogo'],
            label: '系统默认（Windows PowerShell）',
          }
        : commandPrompt
          ? {
              executable: commandPrompt,
              args: [],
              label: '系统默认（Command Prompt）',
            }
          : undefined;

    return [
      resolvedProfile(
        'system-default',
        systemDefault?.label ?? '系统默认 Shell',
        'system',
        true,
        systemDefault?.executable,
        systemDefault?.args ?? [],
        '未找到受支持的系统 Shell',
      ),
      resolvedProfile(
        'powershell-7',
        'PowerShell 7',
        'powershell',
        false,
        powershell7,
        ['-NoLogo'],
        '本机未安装 PowerShell 7',
      ),
      resolvedProfile(
        'windows-powershell',
        'Windows PowerShell',
        'powershell',
        false,
        windowsPowerShell,
        ['-NoLogo'],
        '本机未安装 Windows PowerShell',
      ),
      resolvedProfile(
        'command-prompt',
        'Command Prompt',
        'command-prompt',
        false,
        commandPrompt,
        [],
        '本机未提供 Command Prompt',
      ),
      resolvedProfile(
        'wsl-default',
        'WSL 默认发行版',
        'wsl',
        false,
        wslAvailable ? wslExecutable : undefined,
        [],
        wslExecutable ? '未检测到可启动的 WSL 发行版' : '本机未启用 Windows Subsystem for Linux',
      ),
      unavailableProfile('bash', 'Bash', 'posix', '此配置仅在 macOS 或 Linux 可用'),
      unavailableProfile('zsh', 'Zsh', 'posix', '此配置仅在 macOS 或 Linux 可用'),
    ];
  }

  #discoverPosixProfiles(): ResolvedTerminalProfile[] {
    const configuredShell =
      typeof this.#environment.SHELL === 'string' && isAbsolute(this.#environment.SHELL)
        ? this.#environment.SHELL
        : undefined;
    const systemShell = this.#resolveExecutable([
      ...(configuredShell ? [configuredShell] : []),
      '/bin/zsh',
      '/usr/bin/zsh',
      '/bin/bash',
      '/usr/bin/bash',
      '/bin/sh',
      '/usr/bin/sh',
    ]);
    const bash = this.#resolveExecutable(['/bin/bash', '/usr/bin/bash']);
    const zsh = this.#resolveExecutable(['/bin/zsh', '/usr/bin/zsh']);
    const powershell7 = this.#resolveExecutable([
      '/opt/homebrew/bin/pwsh',
      '/usr/local/bin/pwsh',
      '/usr/bin/pwsh',
    ]);
    const defaultLabel = systemShell
      ? `系统默认（${displayExecutableName(systemShell)}）`
      : '系统默认 Shell';

    return [
      resolvedProfile(
        'system-default',
        defaultLabel,
        'system',
        true,
        systemShell,
        ['-l'],
        '未找到可执行的系统 Shell',
      ),
      resolvedProfile(
        'powershell-7',
        'PowerShell 7',
        'powershell',
        false,
        powershell7,
        ['-NoLogo'],
        '本机未安装 PowerShell 7',
      ),
      unavailableProfile(
        'windows-powershell',
        'Windows PowerShell',
        'powershell',
        '此配置仅在 Windows 可用',
      ),
      unavailableProfile(
        'command-prompt',
        'Command Prompt',
        'command-prompt',
        '此配置仅在 Windows 可用',
      ),
      unavailableProfile('wsl-default', 'WSL 默认发行版', 'wsl', '此配置仅在 Windows 可用'),
      resolvedProfile('bash', 'Bash', 'posix', false, bash, ['-l'], '本机未安装 Bash'),
      resolvedProfile('zsh', 'Zsh', 'posix', false, zsh, ['-l'], '本机未安装 Zsh'),
    ];
  }
}

function resolvedProfile(
  id: TerminalProfileId,
  label: string,
  kind: TerminalProfileKind,
  isDefault: boolean,
  executable: string | undefined,
  args: readonly string[],
  unavailableReason: string,
): ResolvedTerminalProfile {
  return {
    profile: {
      id,
      label,
      kind,
      isDefault,
      available: executable !== undefined,
      ...(executable ? {} : { unavailableReason }),
    },
    executable,
    args,
  };
}

function unavailableProfile(
  id: TerminalProfileId,
  label: string,
  kind: TerminalProfileKind,
  unavailableReason: string,
): ResolvedTerminalProfile {
  return resolvedProfile(id, label, kind, false, undefined, [], unavailableReason);
}

function firstExecutable(candidates: readonly string[]): string | undefined {
  for (const candidate of candidates) {
    if (!isAbsolute(candidate)) continue;
    try {
      const realPath = realpathSync(candidate);
      if (!statSync(realPath).isFile()) continue;
      accessSync(realPath, constants.X_OK);
      return realPath;
    } catch {
      // Continue through the fixed candidate list.
    }
  }
  return undefined;
}

function displayExecutableName(executable: string): string {
  const name = basename(executable);
  return name.length > 40 ? 'Shell' : name;
}

function probeDefaultWslDistribution(executable: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      executable,
      ['--list', '--quiet'],
      {
        encoding: 'utf8',
        maxBuffer: WSL_PROBE_MAX_BYTES,
        timeout: WSL_PROBE_TIMEOUT_MS,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) {
          resolve(false);
          return;
        }
        const distributions = stdout
          .replaceAll('\u0000', '')
          .replace(/^\uFEFF/u, '')
          .split(/\r?\n/u)
          .map((entry) => entry.trim())
          .filter(Boolean);
        resolve(distributions.length > 0);
      },
    );
  });
}
