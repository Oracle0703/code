import { describe, expect, it, vi } from 'vitest';
import { AsyncSingleFlight, settleStartupStage } from '../src/main/startup-coordinator';

describe('startup coordinator', () => {
  it('discards a completed stage if shutdown won the asynchronous boundary', async () => {
    let resolveStage: ((value: string) => void) | undefined;
    const stage = new Promise<string>((resolve) => {
      resolveStage = resolve;
    });
    let canContinue = true;
    const discard = vi.fn(async () => undefined);
    const result = settleStartupStage(stage, () => canContinue, discard);

    canContinue = false;
    resolveStage?.('controller');

    await expect(result).resolves.toEqual({ status: 'cancelled' });
    expect(discard).toHaveBeenCalledWith('controller');
  });

  it('treats a rejection after shutdown as cancellation instead of startup failure', async () => {
    await expect(
      settleStartupStage(Promise.reject(new Error('database is closing')), () => false),
    ).resolves.toEqual({ status: 'cancelled' });
  });

  it('preserves a real startup failure while the stage is current', async () => {
    const failure = new Error('migration failed');
    await expect(settleStartupStage(Promise.reject(failure), () => true)).rejects.toBe(failure);
  });

  it('runs one window creation at a time and releases the slot after success or failure', async () => {
    const singleFlight = new AsyncSingleFlight<string>();
    let resolveFirst: ((value: string) => void) | undefined;
    const firstOperation = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveFirst = resolve;
        }),
    );
    const duplicateOperation = vi.fn(async () => 'duplicate');

    const first = singleFlight.run(firstOperation);
    const duplicate = singleFlight.run(duplicateOperation);
    await Promise.resolve();
    expect(firstOperation).toHaveBeenCalledOnce();
    expect(duplicateOperation).not.toHaveBeenCalled();
    resolveFirst?.('created');
    await expect(Promise.all([first, duplicate])).resolves.toEqual(['created', 'created']);

    const failure = new Error('load failed');
    await expect(singleFlight.run(async () => Promise.reject(failure))).rejects.toBe(failure);
    await expect(singleFlight.run(async () => 'recovered')).resolves.toBe('recovered');
  });
});
