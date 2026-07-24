import { createServer, type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

const MAX_REQUEST_BYTES = 1024 * 1024;
const DEFAULT_WAIT_TIMEOUT_MS = 2_000;

export interface FakeResponsesRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingHttpHeaders;
  readonly bodyText: string;
  readonly body: unknown;
}

export interface FakeResponsesStreamPlan {
  readonly kind: 'stream';
  readonly events?: readonly Readonly<Record<string, unknown>>[];
  /**
   * Sends exact wire chunks instead of encoding `events`. Use this for
   * malformed-stream and arbitrary-boundary tests.
   */
  readonly chunks?: readonly string[];
  readonly delayBetweenChunksMs?: number;
}

export interface FakeResponsesJsonPlan {
  readonly kind: 'json';
  readonly status: number;
  readonly body: unknown;
}

export interface FakeResponsesDisconnectPlan {
  readonly kind: 'disconnect';
}

export type FakeResponsesPlan =
  FakeResponsesStreamPlan | FakeResponsesJsonPlan | FakeResponsesDisconnectPlan;

export interface FakeResponsesServer {
  /** Full, loopback-only `/v1/responses` endpoint. */
  readonly endpoint: string;
  readonly requests: FakeResponsesRequest[];
  enqueue(plan: FakeResponsesPlan): void;
  waitForRequestCount(count: number, timeoutMs?: number): Promise<void>;
  close(): Promise<void>;
}

/**
 * Starts a queue-driven, loopback-only Responses API double.
 *
 * The helper never contacts OpenAI and deliberately exposes only the one
 * endpoint used by the assistant provider. Each accepted request consumes one
 * queued plan, making unexpected retries fail closed.
 */
export async function startFakeResponsesServer(
  initialPlans: readonly FakeResponsesPlan[] = [],
): Promise<FakeResponsesServer> {
  const plans = [...initialPlans];
  const requests: FakeResponsesRequest[] = [];
  const sockets = new Set<Socket>();

  const server = createServer(async (request, response) => {
    try {
      if (request.method !== 'POST' || request.url !== '/v1/responses') {
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'Not found.' } }));
        return;
      }

      const bodyText = await readRequestBody(request);
      requests.push({
        method: request.method,
        url: request.url,
        headers: { ...request.headers },
        bodyText,
        body: parseJson(bodyText),
      });

      const plan = plans.shift();
      if (!plan) {
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'No fake response was queued.' } }));
        return;
      }

      if (plan.kind === 'disconnect') {
        request.socket.destroy();
        return;
      }

      if (plan.kind === 'json') {
        response.writeHead(plan.status, {
          'cache-control': 'no-store',
          'content-type': 'application/json; charset=utf-8',
        });
        response.end(JSON.stringify(plan.body));
        return;
      }

      const chunks = resolveStreamChunks(plan);
      response.writeHead(200, {
        'cache-control': 'no-store',
        connection: 'close',
        'content-type': 'text/event-stream; charset=utf-8',
      });
      for (const chunk of chunks) {
        response.write(chunk);
        if ((plan.delayBetweenChunksMs ?? 0) > 0) {
          await delay(plan.delayBetweenChunksMs ?? 0);
        }
      }
      response.end();
    } catch (error) {
      if (response.destroyed || response.writableEnded) return;
      if (!response.headersSent) {
        response.writeHead(500, { 'content-type': 'application/json' });
      }
      response.end(
        JSON.stringify({
          error: {
            message: error instanceof Error ? error.message : 'Fake Responses server failure.',
          },
        }),
      );
    }
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  let closed = false;
  return {
    endpoint: `http://127.0.0.1:${address.port}/v1/responses`,
    requests,
    enqueue: (plan) => plans.push(plan),
    waitForRequestCount: async (count, timeoutMs = DEFAULT_WAIT_TIMEOUT_MS) => {
      const deadline = Date.now() + timeoutMs;
      while (requests.length < count) {
        if (Date.now() >= deadline) {
          throw new Error(
            `Timed out waiting for ${count} fake Responses request(s); received ${requests.length}.`,
          );
        }
        await delay(5);
      }
    },
    close: async () => {
      if (closed) return;
      closed = true;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        for (const socket of sockets) socket.destroy();
      });
    },
  };
}

function resolveStreamChunks(plan: FakeResponsesStreamPlan): readonly string[] {
  if (plan.chunks && plan.events) {
    throw new Error('A fake stream plan must provide either events or chunks, not both.');
  }
  if (plan.chunks) return plan.chunks;

  return (plan.events ?? []).map(
    (event) => `event: ${String(event.type ?? 'message')}\ndata: ${JSON.stringify(event)}\n\n`,
  );
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > MAX_REQUEST_BYTES) {
      throw new Error(`Request body exceeds ${MAX_REQUEST_BYTES} bytes.`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
