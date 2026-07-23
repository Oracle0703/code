import { describe, expect, it, vi } from 'vitest';
import { TerminalProfileResolver } from '../src/main/terminal/terminal-profile-resolver';
import type { WslDiscoveryLike, WslDiscoverySnapshot } from '../src/main/terminal/wsl-discovery';

describe('terminal profile resolver', () => {
  it('separates Windows shells and exposes WSL only after a real distribution probe', async () => {
    const existing = new Set([
      'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      'C:\\Windows\\System32\\cmd.exe',
      'C:\\Windows\\System32\\wsl.exe',
    ]);
    const wslDiscovery = fakeWslDiscovery({
      status: 'ready',
      capabilityRevision: 1,
      executable: 'C:\\Windows\\System32\\wsl.exe',
      distributions: [
        {
          id: `wsl-${'1'.repeat(64)}`,
          label: 'Ubuntu',
          name: 'Ubuntu',
        },
      ],
    });
    const resolver = new TerminalProfileResolver({
      platform: 'win32',
      environment: {
        SystemRoot: 'C:\\Windows',
        ProgramW6432: 'C:\\Program Files',
      },
      resolveExecutable: (candidates) => candidates.find((candidate) => existing.has(candidate)),
      wslDiscovery,
    });

    const profiles = await resolver.listProfiles();
    expect(wslDiscovery.getSnapshot).toHaveBeenCalledTimes(1);
    expect(
      profiles.slice(0, 5).map(({ profile, executable, args }) => ({
        id: profile.id,
        available: profile.available,
        isDefault: profile.isDefault,
        executable,
        args,
      })),
    ).toMatchObject([
      {
        id: 'system-default',
        available: true,
        isDefault: true,
        executable: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
        args: ['-NoLogo'],
      },
      {
        id: 'powershell-7',
        available: true,
        executable: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
      },
      {
        id: 'windows-powershell',
        available: true,
        executable: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      },
      {
        id: 'command-prompt',
        available: true,
        executable: 'C:\\Windows\\System32\\cmd.exe',
      },
      {
        id: 'wsl-default',
        available: true,
        executable: 'C:\\Windows\\System32\\wsl.exe',
        args: ['~'],
      },
    ]);
    expect(Object.isFrozen(profiles)).toBe(true);
    expect(Object.isFrozen(profiles[0]?.profile)).toBe(true);
  });

  it('treats wsl.exe without a default distribution as unavailable and never guesses Git Bash', async () => {
    const resolver = new TerminalProfileResolver({
      platform: 'win32',
      environment: {
        SystemRoot: 'C:\\Windows',
        ProgramW6432: 'C:\\Program Files',
      },
      resolveExecutable: (candidates) =>
        candidates.find((candidate) =>
          ['C:\\Windows\\System32\\cmd.exe', 'C:\\Windows\\System32\\wsl.exe'].includes(candidate),
        ),
      wslDiscovery: fakeWslDiscovery({
        status: 'no-distributions',
        capabilityRevision: 1,
        executable: 'C:\\Windows\\System32\\wsl.exe',
        distributions: [],
      }),
    });

    const profiles = await resolver.listProfiles();
    expect(profiles.find(({ profile }) => profile.id === 'command-prompt')).toMatchObject({
      profile: { available: true },
      executable: 'C:\\Windows\\System32\\cmd.exe',
    });
    expect(profiles.find(({ profile }) => profile.id === 'wsl-default')).toEqual({
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
    });
    expect(profiles.find(({ profile }) => profile.id === 'bash')?.profile.available).toBe(false);
  });

  it('uses only resolved executable candidates for POSIX profiles and caches discovery', async () => {
    const resolveExecutable = vi.fn((candidates: readonly string[]) =>
      candidates.find((candidate) => ['/usr/bin/fish', '/bin/bash'].includes(candidate)),
    );
    const resolver = new TerminalProfileResolver({
      platform: 'linux',
      environment: { SHELL: '/usr/bin/fish' },
      resolveExecutable,
    });

    const first = await resolver.listProfiles();
    const callsAfterFirstRead = resolveExecutable.mock.calls.length;
    const second = await resolver.listProfiles();

    expect(second).toBe(first);
    expect(resolveExecutable).toHaveBeenCalledTimes(callsAfterFirstRead);
    expect(first.find(({ profile }) => profile.id === 'system-default')).toMatchObject({
      profile: {
        label: '系统默认（fish）',
        kind: 'system',
        isDefault: true,
        available: true,
      },
      executable: '/usr/bin/fish',
      args: ['-l'],
    });
    expect(first.find(({ profile }) => profile.id === 'bash')?.profile.available).toBe(true);
    expect(first.find(({ profile }) => profile.id === 'zsh')?.profile.available).toBe(false);
    expect(first.find(({ profile }) => profile.id === 'command-prompt')?.profile.available).toBe(
      false,
    );
  });

  it('ignores a relative SHELL value instead of executing an environment-controlled command', async () => {
    const resolveExecutable = vi.fn((candidates: readonly string[]) => candidates[0]);
    const resolver = new TerminalProfileResolver({
      platform: 'linux',
      environment: { SHELL: 'malicious-shell' },
      resolveExecutable,
    });

    await resolver.listProfiles();
    expect(resolveExecutable.mock.calls[0]?.[0]).not.toContain('malicious-shell');
  });
});

function fakeWslDiscovery(snapshot: WslDiscoverySnapshot): WslDiscoveryLike & {
  getSnapshot: ReturnType<typeof vi.fn<() => Promise<WslDiscoverySnapshot>>>;
} {
  const getSnapshot = vi.fn(async () => snapshot);
  return {
    getSnapshot,
    refresh: vi.fn(async () => snapshot),
    stop: vi.fn(),
  };
}
