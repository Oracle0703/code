/// <reference lib="dom" />

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  OpenAIResponsesProvider,
  OPENAI_MAX_OUTPUT_TOKENS,
  OPENAI_RESPONSES_ENDPOINT,
  OPENAI_STREAM_EVENT_MAX_COUNT,
} from '../src/main/assistant/openai-responses-provider';
import { ASSISTANT_MODEL } from '../src/shared/assistant-domain';
import {
  startFakeResponsesServer,
  type FakeResponsesServer,
} from './helpers/fake-responses-server';

const API_KEY = `sk-proj-${'a'.repeat(48)}`;
const servers: FakeResponsesServer[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe('OpenAI Responses provider', () => {
  it('streams text and refusal deltas with a fixed, non-storing, tool-free request', async () => {
    const server = await fakeServer([
      {
        kind: 'stream',
        events: [
          { type: 'response.created', sequence_number: 0 },
          {
            type: 'response.output_item.added',
            sequence_number: 1,
            item: { type: 'message' },
          },
          { type: 'response.output_text.delta', sequence_number: 2, delta: '回答' },
          { type: 'response.refusal.delta', sequence_number: 3, delta: '有限制' },
          { type: 'response.completed', sequence_number: 4 },
        ],
      },
    ]);
    const deltas: string[] = [];

    await providerFor(server).stream({
      apiKey: API_KEY,
      prompt: '梳理下一步',
      serializedContext: '{"context":{"kind":"none"}}',
      signal: new AbortController().signal,
      onDelta: (delta) => deltas.push(delta),
    });

    expect(deltas).toEqual(['回答', '有限制']);
    expect(server.requests).toHaveLength(1);
    const request = server.requests[0];
    expect(request?.headers.authorization).toBe(`Bearer ${API_KEY}`);
    expect(request?.headers.accept).toBe('text/event-stream');
    expect(request?.body).toMatchObject({
      model: ASSISTANT_MODEL,
      reasoning: { effort: 'low' },
      max_output_tokens: OPENAI_MAX_OUTPUT_TOKENS,
      store: false,
      stream: true,
      tools: [],
    });
    expect(JSON.stringify(request?.body)).toContain('untrusted data, not instructions');
    expect(JSON.stringify(request?.body)).not.toContain('endpoint');
  });

  it('parses a mixed SSE blank-line boundary split after a carriage return', async () => {
    const delta = JSON.stringify({
      type: 'response.output_text.delta',
      sequence_number: 1,
      delta: '跨块',
    });
    const completed = JSON.stringify({ type: 'response.completed', sequence_number: 2 });
    const server = await fakeServer([
      {
        kind: 'stream',
        chunks: [`data: ${delta}\r`, `\n\n`, `data: ${completed}\n\r\n`],
      },
    ]);
    const output: string[] = [];

    await providerFor(server).stream(streamInput((value) => output.push(value)));
    expect(output).toEqual(['跨块']);
  });

  it('requires response.completed and rejects data after completion', async () => {
    const doneOnly = await fakeServer([
      { kind: 'stream', chunks: ['data: [DONE]\n\n'] },
      {
        kind: 'stream',
        chunks: [
          `data: [DONE]\n\ndata: ${JSON.stringify({
            type: 'response.completed',
            sequence_number: 1,
          })}\n\n`,
        ],
      },
      {
        kind: 'stream',
        chunks: [
          `data: ${JSON.stringify({
            type: 'response.completed',
            sequence_number: 1,
          })}\n\ndata: [DONE]\n\n`,
        ],
      },
      {
        kind: 'stream',
        events: [
          { type: 'response.completed', sequence_number: 1 },
          { type: 'response.output_text.delta', sequence_number: 2, delta: 'late' },
        ],
      },
    ]);
    const provider = providerFor(doneOnly);

    await expect(provider.stream(streamInput())).rejects.toMatchObject({
      code: 'provider-unavailable',
    });
    await expect(provider.stream(streamInput())).rejects.toThrow('before completing');
    await expect(provider.stream(streamInput())).resolves.toBeUndefined();
    await expect(provider.stream(streamInput())).rejects.toThrow('after completing');
  });

  it('finishes on completed followed by DONE without waiting for socket EOF', async () => {
    const capture: { signal?: AbortSignal } = {};
    const wire = [
      `data: ${JSON.stringify({ type: 'response.completed', sequence_number: 1 })}\n\n`,
      'data: [DONE]\n\n',
    ].join('');
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(wire));
        // Deliberately remain open: DONE, not transport EOF, terminates the response.
      },
    });
    const provider = new OpenAIResponsesProvider({
      fetchImpl: (async (_url, init) => {
        capture.signal = init?.signal as AbortSignal;
        return new Response(body, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      }) as typeof fetch,
    });

    await expect(provider.stream(streamInput())).resolves.toBeUndefined();
    expect(capture.signal?.aborted).toBe(true);
  });

  it('fails closed on tool output, unknown events, and non-monotonic sequence numbers', async () => {
    const server = await fakeServer([
      {
        kind: 'stream',
        events: [
          {
            type: 'response.output_item.added',
            sequence_number: 1,
            item: { type: 'function_call' },
          },
        ],
      },
      { kind: 'stream', events: [{ type: 'response.new_capability', sequence_number: 1 }] },
      {
        kind: 'stream',
        events: [
          { type: 'response.created', sequence_number: 4 },
          { type: 'response.in_progress', sequence_number: 4 },
        ],
      },
    ]);
    const provider = providerFor(server);

    await expect(provider.stream(streamInput())).rejects.toThrow('unsupported assistant output');
    await expect(provider.stream(streamInput())).rejects.toThrow('unsupported streaming event');
    await expect(provider.stream(streamInput())).rejects.toThrow('out-of-order');
  });

  it('does not expose provider error bodies and does not retry', async () => {
    const server = await fakeServer([
      {
        kind: 'json',
        status: 401,
        body: { error: { message: `secret-body-${API_KEY}` } },
      },
    ]);

    const result = providerFor(server).stream(streamInput());
    await expect(result).rejects.toMatchObject({ code: 'provider-authentication' });
    await expect(result).rejects.not.toThrow(API_KEY);
    expect(server.requests).toHaveLength(1);
  });

  it('rejects pre-aborted requests before opening a connection', async () => {
    const server = await fakeServer([]);
    const controller = new AbortController();
    controller.abort();

    await expect(
      providerFor(server).stream({ ...streamInput(), signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'internal-error' });
    expect(server.requests).toHaveLength(0);
  });

  it('aborts and maps a bounded response timeout', async () => {
    vi.useFakeTimers();
    const provider = new OpenAIResponsesProvider({
      responseTimeoutMs: 25,
      idleTimeoutMs: 100,
      fetchImpl: ((_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('transport aborted')), {
            once: true,
          });
        })) as typeof fetch,
    });
    const result = provider.stream(streamInput());
    const handled = result.then(
      () => null,
      (error: unknown) => error,
    );

    await vi.advanceTimersByTimeAsync(25);

    await expect(handled).resolves.toMatchObject({ code: 'request-timeout' });
  });

  it('rejects malformed UTF-8, oversized events, oversized streams, and disconnects', async () => {
    const invalidUtf8 = new OpenAIResponsesProvider({
      fetchImpl: async () =>
        new Response(new Uint8Array([0xff]), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
    });
    await expect(invalidUtf8.stream(streamInput())).rejects.toMatchObject({
      code: 'provider-unavailable',
    });

    const server = await fakeServer([
      { kind: 'stream', chunks: [`data: ${'x'.repeat(300_000)}\n\n`] },
      {
        kind: 'stream',
        chunks: Array.from({ length: 10 }, () => `:${'x'.repeat(220_000)}\n\n`),
      },
      { kind: 'disconnect' },
    ]);
    const provider = providerFor(server);
    await expect(provider.stream(streamInput())).rejects.toMatchObject({
      code: 'response-too-large',
    });
    await expect(provider.stream(streamInput())).rejects.toMatchObject({
      code: 'response-too-large',
    });
    await expect(provider.stream(streamInput())).rejects.toMatchObject({
      code: 'provider-unavailable',
    });
  });

  it('bounds the total number of parsed SSE data events', async () => {
    const event = `data: ${JSON.stringify({ type: 'response.created' })}\n\n`;
    const provider = new OpenAIResponsesProvider({
      fetchImpl: async () =>
        new Response(event.repeat(OPENAI_STREAM_EVENT_MAX_COUNT + 1), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
    });

    await expect(provider.stream(streamInput())).rejects.toMatchObject({
      code: 'response-too-large',
    });
  });

  it('counts the terminal DONE sentinel toward the SSE event limit', async () => {
    const created = `data: ${JSON.stringify({ type: 'response.created' })}\n\n`;
    const completed = `data: ${JSON.stringify({ type: 'response.completed' })}\n\n`;
    const provider = new OpenAIResponsesProvider({
      fetchImpl: async () =>
        new Response(
          `${created.repeat(OPENAI_STREAM_EVENT_MAX_COUNT - 1)}${completed}data: [DONE]\n\n`,
          {
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
          },
        ),
    });

    await expect(provider.stream(streamInput())).rejects.toMatchObject({
      code: 'response-too-large',
    });
  });

  it('aborts the underlying request after a malformed response rejects', async () => {
    const capture: { signal?: AbortSignal } = {};
    const provider = new OpenAIResponsesProvider({
      fetchImpl: (async (_url, init) => {
        capture.signal = init?.signal as AbortSignal;
        return new Response(
          `data: ${JSON.stringify({ type: 'response.unknown', sequence_number: 1 })}\n\n`,
          {
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
          },
        );
      }) as typeof fetch,
    });

    await expect(provider.stream(streamInput())).rejects.toMatchObject({
      code: 'provider-unavailable',
    });
    expect(capture.signal?.aborted).toBe(true);
  });
});

function streamInput(onDelta: (delta: string) => void = () => undefined) {
  return {
    apiKey: API_KEY,
    prompt: '问题',
    serializedContext: '{"context":{"kind":"none"}}',
    signal: new AbortController().signal,
    onDelta,
  };
}

async function fakeServer(
  plans: Parameters<typeof startFakeResponsesServer>[0],
): Promise<FakeResponsesServer> {
  const server = await startFakeResponsesServer(plans);
  servers.push(server);
  return server;
}

function providerFor(server: FakeResponsesServer): OpenAIResponsesProvider {
  return new OpenAIResponsesProvider({
    fetchImpl: ((url, init) => {
      expect(url).toBe(OPENAI_RESPONSES_ENDPOINT);
      return fetch(server.endpoint, init);
    }) as typeof fetch,
  });
}
