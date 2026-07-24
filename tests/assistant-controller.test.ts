import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AssistantContextBuilder,
  type ResolvedAssistantContext,
} from '../src/main/assistant/assistant-context-builder';
import {
  ASSISTANT_CANCEL_WAIT_MS,
  AssistantController,
} from '../src/main/assistant/assistant-controller';
import { AssistantProviderError } from '../src/main/assistant/assistant-errors';
import type { AssistantCredentialStore } from '../src/main/assistant/assistant-credential-store';
import type {
  AssistantProvider,
  AssistantProviderStreamInput,
} from '../src/main/assistant/openai-responses-provider';
import {
  DEFAULT_WORKSPACE_PREFERENCES,
  type AssistantCredentialStatus,
} from '../src/shared/contracts';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_WORKSPACE_ID = '22222222-2222-4222-8222-222222222222';
const API_KEY = `sk-proj-${'a'.repeat(48)}`;

afterEach(() => {
  vi.useRealTimers();
});

describe('assistant controller', () => {
  it('streams a single Main-owned run with strictly increasing sequence numbers', async () => {
    const provider = new ControlledProvider();
    const changes: number[] = [];
    const controller = createController(provider, {
      onChanged: (snapshot) => changes.push(snapshot.sequence),
    });

    const started = await controller.start({ prompt: '问题', context: { kind: 'none' } });
    expect(started.phase).toBe('running');
    const run = provider.calls[0];
    if (!run) throw new Error('Provider was not started.');
    run.input.onDelta('部分');
    run.input.onDelta('回答');
    run.resolve();
    await vi.waitFor(() => expect(controller.getSnapshot().phase).toBe('completed'));

    expect(controller.getSnapshot()).toMatchObject({
      runId: started.runId,
      response: '部分回答',
      error: null,
    });
    expect(changes.every((sequence, index) => index === 0 || sequence > changes[index - 1]!)).toBe(
      true,
    );
  });

  it('cancels consecutive runs independently instead of reusing a resolved cancellation', async () => {
    const provider = new ControlledProvider({ settleOnAbort: true });
    const controller = createController(provider);

    const first = await controller.start({ prompt: '第一轮', context: { kind: 'none' } });
    await controller.cancel({ runId: first.runId! });
    expect(controller.getSnapshot().phase).toBe('cancelled');

    const second = await controller.start({ prompt: '第二轮', context: { kind: 'none' } });
    expect(second.runId).not.toBe(first.runId);
    await controller.cancel({ runId: second.runId! });

    expect(provider.calls).toHaveLength(2);
    expect(provider.calls.every(({ input }) => input.signal.aborted)).toBe(true);
    expect(controller.getSnapshot()).toMatchObject({
      runId: second.runId,
      phase: 'cancelled',
    });
  });

  it('bounds cancel waiting but keeps the single-flight lock until a hung provider settles', async () => {
    vi.useFakeTimers();
    const provider = new ControlledProvider();
    const controller = createController(provider);
    const first = await controller.start({ prompt: '挂起', context: { kind: 'none' } });
    const firstRun = provider.calls[0];
    if (!firstRun) throw new Error('Provider was not started.');

    const cancellation = controller.cancel({ runId: first.runId! });
    await vi.advanceTimersByTimeAsync(ASSISTANT_CANCEL_WAIT_MS);
    await expect(cancellation).resolves.toMatchObject({ phase: 'cancelled' });
    await expect(
      controller.start({ prompt: '不得并行', context: { kind: 'none' } }),
    ).rejects.toThrow('Only one assistant response');

    firstRun.input.onDelta('迟到数据');
    firstRun.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.getSnapshot()).toMatchObject({
      phase: 'cancelled',
      response: '',
    });

    await expect(
      controller.start({ prompt: '旧进程结束后允许', context: { kind: 'none' } }),
    ).resolves.toMatchObject({ phase: 'running' });
  });

  it('cancels and gates late events when the authoritative workspace changes', async () => {
    const provider = new ControlledProvider();
    const controller = createController(provider);
    const first = await controller.start({ prompt: '旧工作区', context: { kind: 'none' } });
    const firstRun = provider.calls[0];
    if (!firstRun) throw new Error('Provider was not started.');

    controller.setActiveWorkspace(OTHER_WORKSPACE_ID);
    expect(firstRun.input.signal.aborted).toBe(true);
    expect(controller.getSnapshot()).toMatchObject({
      workspaceId: OTHER_WORKSPACE_ID,
      phase: 'idle',
    });
    firstRun.input.onDelta('跨工作区迟到');
    firstRun.resolve();
    await vi.waitFor(() => expect(controller.getSnapshot().workspaceId).toBe(OTHER_WORKSPACE_ID));
    expect(controller.getSnapshot().response).toBe('');
    expect(first.phase).toBe('running');
  });

  it('cancels an active run before serialized credential replacement and removal', async () => {
    const provider = new ControlledProvider({ settleOnAbort: true });
    const store = credentialStore();
    const controller = createController(provider, { credentialStore: store });
    await controller.start({ prompt: '运行中', context: { kind: 'none' } });

    await controller.configureCredential({ apiKey: `sk-proj-${'b'.repeat(48)}` });
    expect(provider.calls[0]?.input.signal.aborted).toBe(true);
    expect(store.save).toHaveBeenCalledTimes(1);

    await controller.start({ prompt: '再次运行', context: { kind: 'none' } });
    await controller.removeCredential();
    expect(provider.calls[1]?.input.signal.aborted).toBe(true);
    expect(store.remove).toHaveBeenCalledTimes(1);
  });

  it('records a missing credential as a bounded setup failure without calling the provider', async () => {
    const provider = new ControlledProvider();
    const store = credentialStore();
    store.read.mockResolvedValueOnce(null);
    const controller = createController(provider, { credentialStore: store });

    await expect(
      controller.start({ prompt: '问题', context: { kind: 'none' } }),
    ).resolves.toMatchObject({
      phase: 'failed',
      response: '',
      error: { code: 'not-configured' },
    });
    expect(provider.calls).toHaveLength(0);
  });

  it('preserves bounded partial text while mapping provider failures to sanitized state', async () => {
    const provider = new ControlledProvider();
    const controller = createController(provider);
    await controller.start({ prompt: '问题', context: { kind: 'none' } });
    const run = provider.calls[0];
    if (!run) throw new Error('Provider was not started.');
    run.input.onDelta('已生成部分');
    run.reject(
      new AssistantProviderError(
        'provider-rate-limited',
        'OpenAI is temporarily rate limiting assistant requests.',
      ),
    );

    await vi.waitFor(() => expect(controller.getSnapshot().phase).toBe('failed'));
    expect(controller.getSnapshot()).toMatchObject({
      response: '已生成部分',
      error: {
        code: 'provider-rate-limited',
        message: 'OpenAI is temporarily rate limiting assistant requests.',
      },
    });
  });

  it('stops an active run and permanently rejects new starts', async () => {
    const provider = new ControlledProvider({ settleOnAbort: true });
    const controller = createController(provider);
    await controller.start({ prompt: '运行', context: { kind: 'none' } });

    await controller.stop();

    expect(provider.calls[0]?.input.signal.aborted).toBe(true);
    await expect(controller.start({ prompt: '停止后', context: { kind: 'none' } })).rejects.toThrow(
      'controller is stopped',
    );
  });

  it('never starts the provider when stopped during context resolution', async () => {
    vi.useFakeTimers();
    const provider = new ControlledProvider();
    const pendingContext = deferred<ResolvedAssistantContext>();
    const contextBuilder = createContextBuilder();
    const resolveSpy = vi
      .spyOn(contextBuilder, 'resolve')
      .mockReturnValueOnce(pendingContext.promise);
    const controller = createController(provider, { contextBuilder });

    const starting = controller.start({ prompt: '关停竞态', context: { kind: 'none' } });
    await vi.waitFor(() => expect(contextBuilder.resolve).toHaveBeenCalledTimes(1));
    const rejected = expect(starting).rejects.toThrow('controller is stopped');
    const stopping = controller.stop();
    expect(resolveSpy.mock.calls[0]?.[1].aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(ASSISTANT_CANCEL_WAIT_MS);
    await stopping;
    expect(provider.calls).toHaveLength(0);
    pendingContext.resolve({
      ...resolvedNoneContext(),
    });

    await rejected;
    expect(provider.calls).toHaveLength(0);
    expect(controller.getSnapshot().phase).toBe('idle');
  });

  it('never starts the provider when stopped during credential retrieval', async () => {
    vi.useFakeTimers();
    const provider = new ControlledProvider();
    const store = credentialStore();
    const pendingCredential = deferred<string | null>();
    store.read.mockReturnValueOnce(pendingCredential.promise);
    const contextBuilder = createContextBuilder();
    const resolveSpy = vi.spyOn(contextBuilder, 'resolve');
    const controller = createController(provider, { contextBuilder, credentialStore: store });

    const starting = controller.start({ prompt: '关停竞态', context: { kind: 'none' } });
    await vi.waitFor(() => expect(store.read).toHaveBeenCalledTimes(1));
    const rejected = expect(starting).rejects.toThrow('controller is stopped');
    const stopping = controller.stop();
    expect(resolveSpy.mock.calls[0]?.[1].aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(ASSISTANT_CANCEL_WAIT_MS);
    await stopping;
    expect(provider.calls).toHaveLength(0);
    pendingCredential.resolve(API_KEY);

    await rejected;
    expect(provider.calls).toHaveLength(0);
    expect(controller.getSnapshot().phase).toBe('idle');
  });

  it('invalidates a pending context setup when the window cancels active work', async () => {
    const provider = new ControlledProvider();
    const pendingContext = deferred<ResolvedAssistantContext>();
    const contextBuilder = createContextBuilder();
    vi.spyOn(contextBuilder, 'resolve').mockReturnValueOnce(pendingContext.promise);
    const controller = createController(provider, { contextBuilder });

    const starting = controller.start({ prompt: '窗口关闭', context: { kind: 'none' } });
    await vi.waitFor(() => expect(contextBuilder.resolve).toHaveBeenCalledTimes(1));
    await controller.cancelActive();
    expect(contextBuilder.resolve).toHaveBeenCalledWith(
      { kind: 'none' },
      expect.objectContaining({ aborted: true }),
    );
    const rejected = expect(starting).rejects.toThrow('no longer current');
    pendingContext.resolve(resolvedNoneContext());

    await rejected;
    expect(provider.calls).toHaveLength(0);
    expect(controller.getSnapshot().phase).toBe('idle');
  });

  it('keeps a pending setup valid for a same-workspace refresh', async () => {
    const provider = new ControlledProvider();
    const pendingContext = deferred<ResolvedAssistantContext>();
    const contextBuilder = createContextBuilder();
    const resolveSpy = vi
      .spyOn(contextBuilder, 'resolve')
      .mockReturnValueOnce(pendingContext.promise);
    const controller = createController(provider, { contextBuilder });

    const starting = controller.start({ prompt: '同工作区刷新', context: { kind: 'none' } });
    await vi.waitFor(() => expect(resolveSpy).toHaveBeenCalledTimes(1));
    controller.setActiveWorkspace(WORKSPACE_ID);
    expect(resolveSpy.mock.calls[0]?.[1].aborted).toBe(false);
    pendingContext.resolve(resolvedNoneContext());

    await expect(starting).resolves.toMatchObject({ phase: 'running' });
    expect(provider.calls).toHaveLength(1);
    provider.calls[0]?.resolve();
  });

  it('keeps current pending setup valid when discarding another workspace', async () => {
    const provider = new ControlledProvider();
    const pendingContext = deferred<ResolvedAssistantContext>();
    const contextBuilder = createContextBuilder();
    const resolveSpy = vi
      .spyOn(contextBuilder, 'resolve')
      .mockReturnValueOnce(pendingContext.promise);
    const controller = createController(provider, { contextBuilder });

    const starting = controller.start({ prompt: '删除其他工作区', context: { kind: 'none' } });
    await vi.waitFor(() => expect(resolveSpy).toHaveBeenCalledTimes(1));
    controller.discardWorkspace(OTHER_WORKSPACE_ID);
    expect(resolveSpy.mock.calls[0]?.[1].aborted).toBe(false);
    pendingContext.resolve(resolvedNoneContext());

    await expect(starting).resolves.toMatchObject({ phase: 'running' });
    expect(provider.calls).toHaveLength(1);
    provider.calls[0]?.resolve();
  });

  it('keeps a queued new-workspace start valid when discarding its stale predecessor', async () => {
    const provider = new ControlledProvider();
    const pendingOldContext = deferred<ResolvedAssistantContext>();
    const contextBuilder = createContextBuilder();
    const resolveSpy = vi
      .spyOn(contextBuilder, 'resolve')
      .mockReturnValueOnce(pendingOldContext.promise)
      .mockResolvedValueOnce(resolvedNoneContext(OTHER_WORKSPACE_ID));
    const controller = createController(provider, { contextBuilder });

    const oldStart = controller.start({ prompt: '旧工作区', context: { kind: 'none' } });
    await vi.waitFor(() => expect(resolveSpy).toHaveBeenCalledTimes(1));
    controller.setActiveWorkspace(OTHER_WORKSPACE_ID);
    const oldRejected = expect(oldStart).rejects.toThrow('no longer current');
    const newStart = controller.start({ prompt: '新工作区', context: { kind: 'none' } });
    controller.discardWorkspace(WORKSPACE_ID);
    pendingOldContext.resolve(resolvedNoneContext());

    await oldRejected;
    await expect(newStart).resolves.toMatchObject({
      workspaceId: OTHER_WORKSPACE_ID,
      phase: 'running',
    });
    expect(resolveSpy).toHaveBeenCalledTimes(2);
    expect(provider.calls).toHaveLength(1);
    provider.calls[0]?.resolve();
  });

  it('invalidates a pending credential read when the window cancels active work', async () => {
    const provider = new ControlledProvider();
    const store = credentialStore();
    const pendingCredential = deferred<string | null>();
    store.read.mockReturnValueOnce(pendingCredential.promise);
    const controller = createController(provider, { credentialStore: store });

    const starting = controller.start({ prompt: '窗口关闭', context: { kind: 'none' } });
    await vi.waitFor(() => expect(store.read).toHaveBeenCalledTimes(1));
    await controller.cancelActive();
    const rejected = expect(starting).rejects.toThrow('no longer current');
    pendingCredential.resolve(API_KEY);

    await rejected;
    expect(provider.calls).toHaveLength(0);
    expect(controller.getSnapshot().phase).toBe('idle');
  });

  it('invalidates a queued start before it can run after a serialized operation', async () => {
    const provider = new ControlledProvider();
    const store = credentialStore();
    const pendingSave = deferred<AssistantCredentialStatus>();
    store.save.mockReturnValueOnce(pendingSave.promise);
    const contextBuilder = createContextBuilder();
    const contextSpy = vi.spyOn(contextBuilder, 'resolve');
    const controller = createController(provider, { contextBuilder, credentialStore: store });

    const configuring = controller.configureCredential({ apiKey: `sk-proj-${'c'.repeat(48)}` });
    await vi.waitFor(() => expect(store.save).toHaveBeenCalledTimes(1));
    const starting = controller.start({ prompt: '队列中的启动', context: { kind: 'none' } });
    await controller.cancelActive();
    const rejected = expect(starting).rejects.toThrow('no longer current');
    pendingSave.resolve(await store.getStatus());

    await configuring;
    await rejected;
    expect(contextSpy).not.toHaveBeenCalled();
    expect(provider.calls).toHaveLength(0);
    expect(controller.getSnapshot().phase).toBe('idle');
  });
});

class ControlledProvider implements AssistantProvider {
  readonly calls: {
    readonly input: AssistantProviderStreamInput;
    readonly resolve: () => void;
    readonly reject: (error: unknown) => void;
  }[] = [];
  readonly #settleOnAbort: boolean;

  constructor({ settleOnAbort = false }: { settleOnAbort?: boolean } = {}) {
    this.#settleOnAbort = settleOnAbort;
  }

  stream(input: AssistantProviderStreamInput): Promise<void> {
    let resolve: () => void = () => undefined;
    let reject: (error: unknown) => void = () => undefined;
    const promise = new Promise<void>((complete, fail) => {
      resolve = complete;
      reject = fail;
    });
    if (this.#settleOnAbort) {
      input.signal.addEventListener('abort', resolve, { once: true });
    }
    this.calls.push({ input, resolve, reject });
    return promise;
  }
}

function createController(
  provider: AssistantProvider,
  overrides: {
    contextBuilder?: AssistantContextBuilder;
    credentialStore?: ReturnType<typeof credentialStore>;
    onChanged?: ConstructorParameters<typeof AssistantController>[0]['onChanged'];
  } = {},
) {
  let id = 0;
  return new AssistantController({
    initialWorkspaceId: WORKSPACE_ID,
    contextBuilder: overrides.contextBuilder ?? createContextBuilder(),
    credentialStore: overrides.credentialStore ?? credentialStore(),
    provider,
    onChanged: overrides.onChanged,
    now: () => new Date('2026-07-23T10:00:00.000Z'),
    idFactory: () => {
      id += 1;
      return `00000000-0000-4000-8000-${id.toString().padStart(12, '0')}`;
    },
  });
}

function createContextBuilder(): AssistantContextBuilder {
  return new AssistantContextBuilder({
    getWorkspaceSnapshot: vi.fn(async () => ({
      currentWorkspaceId: WORKSPACE_ID,
      workspaces: [
        {
          id: WORKSPACE_ID,
          name: '产品',
          color: '#7b6ee8' as const,
          createdAt: '2026-07-23T10:00:00.000Z',
          updatedAt: '2026-07-23T10:00:00.000Z',
        },
      ],
      preferences: DEFAULT_WORKSPACE_PREFERENCES,
    })),
    getTaskSnapshot: vi.fn(async () => ({
      workspaceId: WORKSPACE_ID,
      todayDate: '2026-07-23',
      tasks: [],
    })),
    getNoteSnapshot: vi.fn(async () => ({ workspaceId: WORKSPACE_ID, notes: [] })),
    getScheduleSnapshot: vi.fn(async () => ({
      workspaceId: WORKSPACE_ID,
      todayDate: '2026-07-23',
      items: [],
    })),
  });
}

function resolvedNoneContext(workspaceId = WORKSPACE_ID): ResolvedAssistantContext {
  return {
    workspaceId,
    reference: { kind: 'none' },
    summary: {
      kind: 'none',
      label: '不附加工作区内容',
      includedCount: 0,
      totalCount: 0,
      truncated: false,
    },
    serialized: JSON.stringify({ context: { kind: 'none' } }),
  };
}

function credentialStore() {
  const status: AssistantCredentialStatus = {
    availability: 'available',
    configured: true,
    removable: true,
    provider: 'OpenAI',
    model: 'gpt-5.6',
    reason: null,
  };
  return {
    getStatus: vi.fn(async () => status),
    read: vi.fn(async (): Promise<string | null> => API_KEY),
    save: vi.fn(async () => status),
    remove: vi.fn(async () => ({ ...status, configured: false, removable: false })),
  } satisfies AssistantCredentialStore;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
