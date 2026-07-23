import type { TerminalProfile, TerminalProfileId, TerminalSnapshot } from '../shared/contracts';

export const MAX_PENDING_TERMINAL_OUTPUT = 256 * 1024;

export interface PendingTerminalOutput {
  readonly value: string;
  readonly truncated: boolean;
}

export function registerTerminalSurface<T>(
  surfaces: Map<string, T>,
  key: string,
  surface: T,
  flushPendingOutput: () => void,
  schedule: (callback: () => void) => void = queueMicrotask,
): () => void {
  let active = true;
  schedule(() => {
    if (!active) return;
    surfaces.set(key, surface);
    flushPendingOutput();
  });
  return () => {
    active = false;
    if (surfaces.get(key) === surface) surfaces.delete(key);
  };
}

export function mergeTerminalSnapshot(
  snapshots: ReadonlyMap<string, TerminalSnapshot>,
  incoming: TerminalSnapshot,
): Map<string, TerminalSnapshot> {
  const current = snapshots.get(incoming.workspaceId);
  if (current && incoming.revision < current.revision) return new Map(snapshots);
  const next = new Map(snapshots);
  next.set(incoming.workspaceId, incoming);
  return next;
}

export function appendPendingTerminalOutput(
  current: PendingTerminalOutput | undefined,
  chunk: string,
): PendingTerminalOutput {
  const combined = `${current?.value ?? ''}${chunk}`;
  if (combined.length <= MAX_PENDING_TERMINAL_OUTPUT) {
    return { value: combined, truncated: current?.truncated ?? false };
  }
  return {
    value: combined.slice(-MAX_PENDING_TERMINAL_OUTPUT),
    truncated: true,
  };
}

export function resolveTerminalProfile(
  profiles: readonly TerminalProfile[],
  selectedProfileId?: TerminalProfileId,
): TerminalProfile | undefined {
  const selected = profiles.find(({ id, available }) => available && id === selectedProfileId);
  return (
    selected ??
    profiles.find(({ available, isDefault }) => available && isDefault) ??
    profiles.find(({ available }) => available)
  );
}

export function resolvePreferredTerminalProfile(
  snapshot: TerminalSnapshot,
): TerminalProfile | undefined {
  return snapshot.profiles.find(({ id }) => id === snapshot.configuration.preferredProfileId);
}

export function terminalConfigurationIssue(snapshot: TerminalSnapshot): string | null {
  const profile = resolvePreferredTerminalProfile(snapshot);
  if (!profile) return '保存的终端 Profile 已不存在，请重新选择。';
  if (!profile.available) {
    return profile.unavailableReason ?? `${profile.label} 当前不可用，请重新选择。`;
  }
  if (profile.kind !== 'wsl') {
    if (!snapshot.configuration.workingDirectory.available) {
      return (
        snapshot.configuration.workingDirectory.unavailableReason ??
        '保存的终端启动目录当前不可用，请重新选择。'
      );
    }
    return null;
  }

  const { wsl } = snapshot.configuration;
  if (wsl.status === 'unsupported') return 'WSL 终端仅可在 Windows 上使用。';
  if (wsl.status === 'not-installed') return '本机尚未启用 Windows Subsystem for Linux。';
  if (wsl.status === 'no-distributions') return '本机尚未检测到可启动的 WSL 发行版。';
  if (wsl.status === 'probe-error') return '暂时无法读取 WSL 发行版，请重新检测。';
  if (!wsl.selectedDistributionAvailable) {
    return wsl.selectedDistributionLabel
      ? `WSL 发行版“${wsl.selectedDistributionLabel}”当前不可用，请重新选择。`
      : '系统默认 WSL 发行版当前不可用，请重新选择。';
  }
  return null;
}

export function terminalSessionAccessibleLabel(
  session: Pick<TerminalSnapshot['sessions'][number], 'label' | 'status'>,
  index: number,
  total: number,
): string {
  const state = session.status === 'running' ? '运行中' : '已退出';
  return `${session.label}，终端 ${index + 1}/${total}，${state}`;
}

export function moveTerminalTab(
  sessionIds: readonly string[],
  activeSessionId: string | null,
  key: 'ArrowLeft' | 'ArrowRight' | 'Home' | 'End',
): string | null {
  if (sessionIds.length === 0) return null;
  if (key === 'Home') return sessionIds[0] ?? null;
  if (key === 'End') return sessionIds.at(-1) ?? null;
  const currentIndex = Math.max(0, sessionIds.indexOf(activeSessionId ?? ''));
  const offset = key === 'ArrowRight' ? 1 : -1;
  return sessionIds[(currentIndex + offset + sessionIds.length) % sessionIds.length] ?? null;
}
