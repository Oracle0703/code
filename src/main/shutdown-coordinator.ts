export async function settleShutdownsBefore(
  shutdowns: Iterable<() => Promise<void>>,
  finalTask: () => Promise<void>,
  onShutdownFailure: (error: unknown) => void,
): Promise<void> {
  const results = await Promise.allSettled(
    [...shutdowns].map((shutdown) => Promise.resolve().then(shutdown)),
  );
  for (const result of results) {
    if (result.status === 'rejected') onShutdownFailure(result.reason);
  }
  await finalTask();
}

export async function runAfterCloseApproval(
  approvals: Iterable<() => Promise<boolean>>,
  approvedTask: () => Promise<void>,
): Promise<boolean> {
  const results = await Promise.allSettled(
    [...approvals].map((requestApproval) => Promise.resolve().then(requestApproval)),
  );
  if (results.some((result) => result.status !== 'fulfilled' || result.value !== true)) {
    return false;
  }
  await approvedTask();
  return true;
}

export interface ApprovedCloseSurface {
  isDestroyed(): boolean;
  setEnabled(enabled: boolean): void;
  hide(): void;
  destroy(): void;
}

export function prepareApprovedCloseSurfaces(
  surfaces: Iterable<ApprovedCloseSurface>,
  onFailure: (error: unknown) => void,
): void {
  for (const surface of surfaces) {
    if (surface.isDestroyed()) continue;
    try {
      surface.setEnabled(false);
    } catch (error) {
      onFailure(error);
    }
    try {
      surface.hide();
    } catch (error) {
      onFailure(error);
    }
  }
}

export function finishApprovedCloseSurfaces(
  surfaces: Iterable<ApprovedCloseSurface>,
  onFailure: (error: unknown) => void,
): void {
  for (const surface of surfaces) {
    if (surface.isDestroyed()) continue;
    try {
      surface.destroy();
    } catch (error) {
      onFailure(error);
    }
  }
}
