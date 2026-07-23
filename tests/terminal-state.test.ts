import { describe, expect, it } from 'vitest';
import {
  MAX_PENDING_TERMINAL_OUTPUT,
  appendPendingTerminalOutput,
  mergeTerminalSnapshot,
  moveTerminalTab,
  registerTerminalSurface,
  resolvePreferredTerminalProfile,
  resolveTerminalProfile,
  terminalConfigurationIssue,
  terminalSessionAccessibleLabel,
} from '../src/renderer/terminal-state';
import type { TerminalSnapshot } from '../src/shared/contracts';

const WORKSPACE_A = '11111111-1111-4111-8111-111111111111';

describe('terminal renderer state', () => {
  it('rejects stale workspace snapshots while accepting an equal authoritative replay', () => {
    const current = snapshot(4);
    const stale = snapshot(3);
    const replay = { ...snapshot(4), activeSessionId: 'replayed' };
    const state = new Map([[WORKSPACE_A, current]]);

    expect(mergeTerminalSnapshot(state, stale).get(WORKSPACE_A)).toBe(current);
    expect(mergeTerminalSnapshot(state, replay).get(WORKSPACE_A)).toBe(replay);
  });

  it('keeps only a bounded tail for output that arrives before its xterm surface', () => {
    const first = appendPendingTerminalOutput(undefined, 'a'.repeat(MAX_PENDING_TERMINAL_OUTPUT));
    const second = appendPendingTerminalOutput(first, 'tail');

    expect(first.truncated).toBe(false);
    expect(second.truncated).toBe(true);
    expect(second.value).toHaveLength(MAX_PENDING_TERMINAL_OUTPUT);
    expect(second.value.endsWith('tail')).toBe(true);
  });

  it('flushes pending output only into the stable StrictMode surface', () => {
    const scheduled: Array<() => void> = [];
    const surfaces = new Map<string, { write(value: string): void }>();
    const firstWrites: string[] = [];
    const secondWrites: string[] = [];
    let pending = 'early output';
    const first = { write: (value: string) => firstWrites.push(value) };
    const second = { write: (value: string) => secondWrites.push(value) };
    const register = (surface: typeof first) =>
      registerTerminalSurface(
        surfaces,
        'workspace:session',
        surface,
        () => {
          surface.write(pending);
          pending = '';
        },
        (callback) => scheduled.push(callback),
      );

    const unregisterFirst = register(first);
    unregisterFirst();
    const unregisterSecond = register(second);
    expect(surfaces.size).toBe(0);
    pending += ' then stable';
    for (const callback of scheduled) callback();

    expect(firstWrites).toEqual([]);
    expect(secondWrites).toEqual(['early output then stable']);
    expect(pending).toBe('');
    unregisterSecond();
    expect(surfaces.size).toBe(0);
  });

  it('uses an available selection, then the default, then the first available profile', () => {
    const profiles = snapshot(0).profiles;
    expect(resolveTerminalProfile(profiles, 'command-prompt')?.id).toBe('command-prompt');
    expect(resolveTerminalProfile(profiles, 'wsl-default')?.id).toBe('system-default');
    expect(
      resolveTerminalProfile(
        profiles.map((profile) => ({ ...profile, isDefault: false })),
        'wsl-default',
      )?.id,
    ).toBe('system-default');
  });

  it('keeps an unavailable persisted preference explicit instead of silently falling back', () => {
    const current = snapshot(0);
    const configured = {
      ...current,
      profiles: current.profiles.map((profile) =>
        profile.id === 'wsl-default' ? { ...profile, available: true } : profile,
      ),
      configuration: {
        ...current.configuration,
        preferredProfileId: 'wsl-default' as const,
        wsl: {
          ...current.configuration.wsl,
          status: 'no-distributions' as const,
          selectedDistributionAvailable: false,
        },
      },
    };

    expect(resolvePreferredTerminalProfile(configured)?.id).toBe('wsl-default');
    expect(terminalConfigurationIssue(configured)).toBe('本机尚未检测到可启动的 WSL 发行版。');
  });

  it('reports an unavailable working directory before a terminal can be created', () => {
    const current = snapshot(0);
    expect(
      terminalConfigurationIssue({
        ...current,
        configuration: {
          ...current.configuration,
          workingDirectory: {
            mode: 'selected-directory',
            displayPath: 'D:\\missing',
            available: false,
            unavailableReason: '保存的目录已不存在',
          },
        },
      }),
    ).toBe('保存的目录已不存在');
  });

  it('keeps native directory preferences separate from the WSL distribution home', () => {
    const current = snapshot(0);
    expect(
      terminalConfigurationIssue({
        ...current,
        profiles: current.profiles.map((profile) =>
          profile.id === 'wsl-default' ? { ...profile, available: true } : profile,
        ),
        configuration: {
          ...current.configuration,
          preferredProfileId: 'wsl-default',
          workingDirectory: {
            mode: 'selected-directory',
            displayPath: 'D:\\missing',
            available: false,
            unavailableReason: '保存的目录已不存在',
          },
          wsl: {
            status: 'ready',
            capabilityRevision: 2,
            distributions: [{ id: 'wsl-id', label: 'Ubuntu' }],
            selectedDistributionId: 'wsl-id',
            selectedDistributionLabel: 'Ubuntu',
            selectedDistributionAvailable: true,
          },
        },
      }),
    ).toBeNull();
  });

  it('gives duplicate terminal tabs unique accessible names', () => {
    const session = { label: 'PowerShell 7', status: 'running' as const };
    expect(terminalSessionAccessibleLabel(session, 0, 2)).toBe('PowerShell 7，终端 1/2，运行中');
    expect(terminalSessionAccessibleLabel(session, 1, 2)).toBe('PowerShell 7，终端 2/2，运行中');
  });

  it('wraps arrow navigation and supports Home and End', () => {
    const ids = ['a', 'b', 'c'];
    expect(moveTerminalTab(ids, 'c', 'ArrowRight')).toBe('a');
    expect(moveTerminalTab(ids, 'a', 'ArrowLeft')).toBe('c');
    expect(moveTerminalTab(ids, 'b', 'Home')).toBe('a');
    expect(moveTerminalTab(ids, 'b', 'End')).toBe('c');
    expect(moveTerminalTab([], null, 'Home')).toBeNull();
  });
});

function snapshot(revision: number): TerminalSnapshot {
  return {
    workspaceId: WORKSPACE_A,
    revision,
    activeSessionId: null,
    sessions: [],
    profiles: [
      {
        id: 'system-default',
        label: 'System Shell',
        kind: 'system',
        isDefault: true,
        available: true,
      },
      {
        id: 'command-prompt',
        label: 'Command Prompt',
        kind: 'command-prompt',
        isDefault: false,
        available: true,
      },
      {
        id: 'wsl-default',
        label: 'WSL',
        kind: 'wsl',
        isDefault: false,
        available: false,
        unavailableReason: 'No distribution',
      },
    ],
    configuration: {
      revision: 1,
      preferredProfileId: 'system-default',
      workingDirectory: {
        mode: 'user-home',
        displayPath: '/home/test',
        available: true,
      },
      wsl: {
        status: 'no-distributions',
        capabilityRevision: 1,
        distributions: [],
        selectedDistributionId: null,
        selectedDistributionLabel: null,
        selectedDistributionAvailable: false,
      },
    },
  };
}
