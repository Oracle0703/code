import { describe, expect, it, vi } from 'vitest';
import {
  finishApprovedCloseSurfaces,
  prepareApprovedCloseSurfaces,
  runAfterCloseApproval,
  settleShutdownsBefore,
} from '../src/main/shutdown-coordinator';

describe('main shutdown coordinator', () => {
  it('waits for every browser shutdown to settle before closing the database', async () => {
    const first = deferred<void>();
    const second = deferred<void>();
    const order: string[] = [];
    const closeDatabase = vi.fn(async () => {
      order.push('database');
    });
    const reportFailure = vi.fn((error: unknown) => {
      order.push(`failure:${String(error)}`);
    });

    const shutdown = settleShutdownsBefore(
      [
        () => {
          order.push('browser-a');
          return first.promise;
        },
        () => {
          order.push('browser-b');
          return second.promise;
        },
      ],
      closeDatabase,
      reportFailure,
    );

    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(order).toEqual(['browser-a', 'browser-b']);
    expect(closeDatabase).not.toHaveBeenCalled();
    first.resolve();
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(closeDatabase).not.toHaveBeenCalled();
    const failure = new Error('browser-b failed');
    second.reject(failure);

    await expect(shutdown).resolves.toBeUndefined();
    expect(reportFailure).toHaveBeenCalledExactlyOnceWith(failure);
    expect(closeDatabase).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['browser-a', 'browser-b', `failure:${String(failure)}`, 'database']);
  });

  it('still closes the database after a browser shutdown throws synchronously', async () => {
    const failure = new Error('native browser teardown failed');
    const closeDatabase = vi.fn(async () => undefined);
    const reportFailure = vi.fn();

    await expect(
      settleShutdownsBefore(
        [
          () => {
            throw failure;
          },
          async () => undefined,
        ],
        closeDatabase,
        reportFailure,
      ),
    ).resolves.toBeUndefined();

    expect(reportFailure).toHaveBeenCalledExactlyOnceWith(failure);
    expect(closeDatabase).toHaveBeenCalledTimes(1);
  });

  it('leaves browser and database resources usable when close approval is denied', async () => {
    const shutdownBrowser = vi.fn(async () => undefined);
    const closeDatabase = vi.fn(async () => undefined);

    await expect(
      runAfterCloseApproval([async () => false], async () => {
        await shutdownBrowser();
        await closeDatabase();
      }),
    ).resolves.toBe(false);

    expect(shutdownBrowser).not.toHaveBeenCalled();
    expect(closeDatabase).not.toHaveBeenCalled();
  });

  it('disables and hides an approved window before asynchronous shutdown, then force closes it', async () => {
    const shutdown = deferred<void>();
    const order: string[] = [];
    const surface = {
      isDestroyed: () => false,
      setEnabled: (enabled: boolean) => order.push(`enabled:${String(enabled)}`),
      hide: () => order.push('hidden'),
      destroy: () => order.push('destroyed'),
    };

    const closing = runAfterCloseApproval([async () => true], async () => {
      prepareApprovedCloseSurfaces([surface], (error) => {
        throw error;
      });
      order.push('shutdown');
      await shutdown.promise;
      finishApprovedCloseSurfaces([surface], (error) => {
        throw error;
      });
    });

    await vi.waitFor(() => {
      expect(order).toEqual(['enabled:false', 'hidden', 'shutdown']);
    });
    shutdown.resolve();
    await expect(closing).resolves.toBe(true);
    expect(order).toEqual(['enabled:false', 'hidden', 'shutdown', 'destroyed']);
  });

  it('attempts every approved-close action even when a native operation throws', () => {
    const failures: unknown[] = [];
    const surface = {
      isDestroyed: () => false,
      setEnabled: () => {
        throw new Error('disable failed');
      },
      hide: vi.fn(),
      destroy: () => {
        throw new Error('destroy failed');
      },
    };

    prepareApprovedCloseSurfaces([surface], (error) => failures.push(error));
    finishApprovedCloseSurfaces([surface], (error) => failures.push(error));

    expect(surface.hide).toHaveBeenCalledTimes(1);
    expect(failures.map(String)).toEqual(['Error: disable failed', 'Error: destroy failed']);
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
