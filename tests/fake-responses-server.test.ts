import { describe, expect, it } from 'vitest';

import { startFakeResponsesServer } from './helpers/fake-responses-server';

describe('fake Responses server', () => {
  it('captures a request and sends queued SSE events on loopback', async () => {
    const server = await startFakeResponsesServer([
      {
        kind: 'stream',
        events: [
          { type: 'response.output_text.delta', delta: '你好' },
          { type: 'response.completed', response: { id: 'resp_test' } },
        ],
      },
    ]);

    try {
      const response = await fetch(server.endpoint, {
        method: 'POST',
        headers: {
          authorization: 'Bearer test-only-key',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'gpt-5.6',
          stream: true,
          store: false,
          tools: [],
        }),
      });

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
      expect(await response.text()).toBe(
        'event: response.output_text.delta\n' +
          'data: {"type":"response.output_text.delta","delta":"你好"}\n\n' +
          'event: response.completed\n' +
          'data: {"type":"response.completed","response":{"id":"resp_test"}}\n\n',
      );
      await server.waitForRequestCount(1);
      expect(server.requests).toHaveLength(1);
      expect(server.requests[0]).toMatchObject({
        method: 'POST',
        url: '/v1/responses',
        body: {
          model: 'gpt-5.6',
          stream: true,
          store: false,
          tools: [],
        },
      });
      expect(server.requests[0]?.headers.authorization).toBe('Bearer test-only-key');
    } finally {
      await server.close();
    }
  });

  it('preserves exact chunks and fails closed on an unexpected retry', async () => {
    const server = await startFakeResponsesServer([
      {
        kind: 'stream',
        chunks: [
          'event: response.output_text.delta\nda',
          'ta: {"type":"response.output_text.delta","delta":"split"}\n\n',
        ],
      },
    ]);

    try {
      const firstResponse = await fetch(server.endpoint, {
        method: 'POST',
        body: '{}',
      });
      expect(await firstResponse.text()).toContain('"delta":"split"');

      const unexpectedRetry = await fetch(server.endpoint, {
        method: 'POST',
        body: '{}',
      });
      expect(unexpectedRetry.status).toBe(500);
      await expect(unexpectedRetry.json()).resolves.toEqual({
        error: { message: 'No fake response was queued.' },
      });
      expect(server.requests).toHaveLength(2);
    } finally {
      await server.close();
    }
  });
});
