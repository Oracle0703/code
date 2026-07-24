export type StartupStageResult<T> =
  { readonly status: 'ready'; readonly value: T } | { readonly status: 'cancelled' };

export class AsyncSingleFlight<T> {
  #running: Promise<T> | undefined;

  run(operation: () => Promise<T>): Promise<T> {
    if (this.#running) return this.#running;
    const operationPromise = Promise.resolve().then(operation);
    const running = operationPromise.finally(() => {
      if (this.#running === running) this.#running = undefined;
    });
    this.#running = running;
    return running;
  }
}

export async function settleStartupStage<T>(
  operation: Promise<T>,
  canContinue: () => boolean,
  discard?: (value: T) => Promise<void> | void,
): Promise<StartupStageResult<T>> {
  let value: T;
  try {
    value = await operation;
  } catch (error) {
    if (!canContinue()) return { status: 'cancelled' };
    throw error;
  }
  if (canContinue()) return { status: 'ready', value };
  await discard?.(value);
  return { status: 'cancelled' };
}
