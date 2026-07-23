import { describe, expect, it, vi } from 'vitest';
import { WindowCloseCoordinator } from '../src/main/window-close-coordinator';

const REQUEST_A = '11111111-1111-4111-8111-111111111111';
const REQUEST_B = '22222222-2222-4222-8222-222222222222';

describe('WindowCloseCoordinator', () => {
  it('allows an unprotected renderer to close without sending a request', async () => {
    const sendRequest = vi.fn();
    const coordinator = new WindowCloseCoordinator({
      sendRequest,
      idFactory: () => REQUEST_A,
    });

    await expect(coordinator.requestApproval('window')).resolves.toBe(true);
    expect(sendRequest).not.toHaveBeenCalled();
  });

  it('waits for the matching protected-renderer response and preserves a denial', async () => {
    const sendRequest = vi.fn();
    const coordinator = new WindowCloseCoordinator({
      sendRequest,
      idFactory: () => REQUEST_A,
    });
    coordinator.markReady();

    const first = coordinator.requestApproval('window');
    const concurrent = coordinator.requestApproval('application');
    expect(concurrent).toBe(first);
    expect(sendRequest).toHaveBeenCalledExactlyOnceWith({
      requestId: REQUEST_A,
      reason: 'window',
    });

    coordinator.respond({ requestId: REQUEST_B, approved: true });
    let settled = false;
    void first.finally(() => {
      settled = true;
    });
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(settled).toBe(false);

    coordinator.respond({ requestId: REQUEST_A, approved: false });
    await expect(first).resolves.toBe(false);
  });

  it('fails closed when a protected renderer cannot receive the request', async () => {
    const coordinator = new WindowCloseCoordinator({
      sendRequest: () => {
        throw new Error('renderer unavailable');
      },
      idFactory: () => REQUEST_A,
    });
    coordinator.markReady();

    await expect(coordinator.requestApproval('application')).resolves.toBe(false);
  });

  it('releases a pending request when the renderer becomes unavailable', async () => {
    const coordinator = new WindowCloseCoordinator({
      sendRequest: vi.fn(),
      idFactory: () => REQUEST_A,
    });
    coordinator.markReady();

    const approval = coordinator.requestApproval('window');
    coordinator.markUnavailable();

    await expect(approval).resolves.toBe(true);
    await expect(coordinator.requestApproval('window')).resolves.toBe(true);
  });
});
