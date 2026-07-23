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
