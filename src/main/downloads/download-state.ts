import type { BrowserDownloadState } from '../../shared/contracts';

export type DownloadUpdatedState = 'progressing' | 'interrupted';
export type DownloadDoneState = 'completed' | 'cancelled' | 'interrupted';

export function normalizeDownloadByteCount(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

export function deriveUpdatedDownloadState(
  state: DownloadUpdatedState,
  isPaused: boolean,
  canResume: boolean,
): Pick<{ state: BrowserDownloadState; canResume: boolean }, 'state' | 'canResume'> {
  if (state === 'interrupted') {
    return { state: 'interrupted', canResume };
  }
  return isPaused ? { state: 'paused', canResume } : { state: 'progressing', canResume: false };
}

export function deriveDoneDownloadState(state: DownloadDoneState): BrowserDownloadState {
  return state === 'interrupted' ? 'failed' : state;
}

export function isTerminalDownloadState(state: BrowserDownloadState): boolean {
  return state === 'completed' || state === 'cancelled' || state === 'failed';
}
