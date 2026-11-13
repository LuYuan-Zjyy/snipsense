import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { LlmError, streamChat, type LlmConfig } from '../src/core/client';

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

async function startServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

function config(base: string, overrides: Partial<LlmConfig> = {}): LlmConfig {
  return {
    provider: 'custom',
    endpoint: `${base}/v1/chat/completions`,
    model: 'test-model',
    apiKey: 'test-key',
    maxTokens: 64,
    temperature: 0,
    timeoutMs: 5000,
    ...overrides,
  };
}

async function collect(base: string, overrides: Partial<LlmConfig> = {}): Promise<string> {
  let result = '';
  for await (const chunk of streamChat(
    config(base, overrides),
    [{ role: 'user', content: 'hello' }],
    {},
  )) {
    result += chunk;
  }
  return result;
}

describe('streamChat', () => {
  it('streams SSE deltas, including chunks split mid-JSON', async () => {
    let authorization = '';
    let requestedModel = '';
    const base = await startServer((request, response) => {
      authorization = String(request.headers.authorization ?? '');
      const chunks: string[] = [];
      request.on('data', (chunk) => chunks.push(String(chunk)));
      request.on('end', () => {
        requestedModel = (JSON.parse(chunks.join('')) as { model: string }).model;
        response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
        response.write('data: {"choices":[{"delta":{"content":"你"');
        response.write('}}]}\n\n');
        response.write('data: {"choices":[{"delta":{"content":"好"}}]}\n\n');
        response.end('data: [DONE]\n\n');
      });
    });

    await expect(collect(base)).resolves.toBe('你好');
    expect(authorization).toBe('Bearer test-key');
    expect(requestedModel).toBe('test-model');
  });

  it('accepts a non-streaming JSON response', async () => {
    const base = await startServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }));
    });
    await expect(collect(base)).resolves.toBe('OK');
  });

  it('turns a 401 into a friendly LlmError', async () => {
    const base = await startServer((_request, response) => {
      response.writeHead(401, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'invalid api key' } }));
    });

    await expect(collect(base)).rejects.toMatchObject({
      name: 'LlmError',
      status: 401,
    });
    await expect(collect(base)).rejects.toThrow(/API Key/);
  });

  it('throws when the model returns no content', async () => {
    const base = await startServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.end('data: [DONE]\n\n');
    });
    await expect(collect(base)).rejects.toBeInstanceOf(LlmError);
  });

  it('aborts an in-flight request', async () => {
    const base = await startServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write('data: {"choices":[{"delta":{"content":"A"}}]}\n\n');
      // Keep the connection open so the abort path is exercised.
    });
    const abort = new AbortController();
    const iterator = streamChat(config(base), [{ role: 'user', content: 'hello' }], {
      signal: abort.signal,
    });
    const first = await iterator.next();
    expect(first.value).toBe('A');
    abort.abort();
    await expect(iterator.next()).rejects.toMatchObject({ name: 'AbortError' });
  });
});
