import { describe, expect, it, vi } from 'vitest';
import type { BrowserBounds } from '../src/shared/contracts';
import { BrowserViewSyncCoordinator } from '../src/renderer/browser-view-sync';

const WORKSPACE_A = '11111111-1111-4111-8111-111111111111';
const WORKSPACE_B = '22222222-2222-4222-8222-222222222222';
const BOUNDS: BrowserBounds = { x: 10, y: 20, width: 640, height: 480 };

describe('browser native view synchronization', () => {
  it('hides before applying bounds and only then shows the view', async () => {
    const calls: string[] = [];
    const coordinator = new BrowserViewSyncCoordinator();

    await expect(
      coordinator.synchronize({
        workspaceId: WORKSPACE_A,
        bounds: BOUNDS,
        setVisible: vi.fn(async (visible) => {
          calls.push(visible ? 'show' : 'hide');
          return true;
        }),
        setBounds: vi.fn(async (bounds) => {
          calls.push(`bounds:${bounds.width}x${bounds.height}`);
          return true;
        }),
      }),
    ).resolves.toBe(true);

    expect(calls).toEqual(['hide', 'bounds:640x480', 'show']);
  });

  it('keeps the native view hidden when applying bounds fails', async () => {
    const calls: string[] = [];
    const coordinator = new BrowserViewSyncCoordinator();

    await expect(
      coordinator.synchronize({
        workspaceId: WORKSPACE_A,
        bounds: BOUNDS,
        setVisible: async (visible) => {
          calls.push(visible ? 'show' : 'hide');
          return true;
        },
        setBounds: async () => {
          calls.push('bounds');
          return false;
        },
      }),
    ).resolves.toBe(false);

    expect(calls).toEqual(['hide', 'bounds']);
  });

  it('drops stale A work before synchronizing and showing the latest B generation', async () => {
    const calls: string[] = [];
    const coordinator = new BrowserViewSyncCoordinator();
    const firstHide = deferred<boolean>();
    const first = coordinator.synchronize({
      workspaceId: WORKSPACE_A,
      bounds: BOUNDS,
      setVisible: async (visible) => {
        calls.push(`A:${visible ? 'show' : 'hide'}`);
        return visible ? true : firstHide.promise;
      },
      setBounds: async () => {
        calls.push('A:bounds');
        return true;
      },
    });
    await vi.waitFor(() => expect(calls).toEqual(['A:hide']));

    const second = coordinator.synchronize({
      workspaceId: WORKSPACE_B,
      bounds: { ...BOUNDS, width: 720 },
      setVisible: async (visible) => {
        calls.push(`B:${visible ? 'show' : 'hide'}`);
        return true;
      },
      setBounds: async (bounds) => {
        calls.push(`B:bounds:${bounds.width}`);
        return true;
      },
    });
    firstHide.resolve(true);

    await expect(first).resolves.toBe(false);
    await expect(second).resolves.toBe(true);
    expect(calls).toEqual(['A:hide', 'B:hide', 'B:bounds:720', 'B:show']);
  });

  it('prevents a cleanup generation from showing after an in-flight bounds update', async () => {
    const calls: string[] = [];
    const coordinator = new BrowserViewSyncCoordinator();
    const boundsApplied = deferred<boolean>();
    const setVisible = async (visible: boolean) => {
      calls.push(visible ? 'show' : 'hide');
      return true;
    };
    const synchronizing = coordinator.synchronize({
      workspaceId: WORKSPACE_A,
      bounds: BOUNDS,
      setVisible,
      setBounds: async () => {
        calls.push('bounds');
        return boundsApplied.promise;
      },
    });
    await vi.waitFor(() => expect(calls).toEqual(['hide', 'bounds']));

    const hiding = coordinator.hide(WORKSPACE_A, setVisible);
    boundsApplied.resolve(true);

    await expect(synchronizing).resolves.toBe(false);
    await expect(hiding).resolves.toBe(true);
    expect(calls).toEqual(['hide', 'bounds', 'hide']);
  });
});

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: (value) => resolvePromise?.(value),
  };
}
