import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import { connectionService } from '../connections.service.js';
import { codexConnectionsRoutes } from '../connections.routes.js';

test('model discovery previews unsaved and edited APIs, reuses a saved key, and leaves accounts unchanged', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'api-model-discovery-'));
  const previousRoot = process.env.CODEX_CONNECTIONS_ROOT;
  const originalFetch = globalThis.fetch;
  process.env.CODEX_CONNECTIONS_ROOT = root;
  const store = JSON.stringify({ activeId: 'official', connections: [
    { id: 'official', kind: 'chatgpt', name: 'Official', home: root },
    { id: 'saved', kind: 'api', name: 'Saved', home: root, baseUrl: 'https://1.1.1.1/v1', apiKey: 'saved-private-key', model: 'manual-model' },
  ] });
  fs.writeFileSync(path.join(root, 'store.json'), store);
  const calls: { url: string; authorization: string | null }[] = [];
  globalThis.fetch = (async (url, init) => {
    calls.push({ url: String(url), authorization: new Headers(init?.headers).get('Authorization') });
    assert.equal(init?.redirect, 'error');
    assert.ok(init?.signal);
    return Response.json({ data: [{ id: ' model-b ' }, { id: 'model-a' }, { id: 'model-b' }, null, {}, { id: 42 }, { id: '' }, { id: 'x'.repeat(161) }, { id: 'saved-private-key' }] });
  }) as typeof fetch;
  try {
    assert.deepEqual(await connectionService.discoverModels({ baseUrl: 'https://1.1.1.1/', apiKey: 'new-private-key' }), { models: ['model-b', 'model-a', 'saved-private-key'] });
    assert.deepEqual(calls.at(-1), { url: 'https://1.1.1.1/v1/models', authorization: 'Bearer new-private-key' });
    const saved = await connectionService.discoverModels({ id: 'saved', baseUrl: 'https://1.0.0.1/custom/v1/chat/completions/', apiKey: ' ' });
    assert.deepEqual(saved, { models: ['model-b', 'model-a'] });
    assert.deepEqual(calls.at(-1), { url: 'https://1.0.0.1/custom/v1/models', authorization: 'Bearer saved-private-key' });
    await connectionService.discoverModels({ id: 'saved', baseUrl: 'https://1.1.1.1/v1/responses', apiKey: 'replacement-private-key' });
    assert.equal(calls.at(-1)?.authorization, 'Bearer replacement-private-key');
    assert.deepEqual(await connectionService.models('saved'), { models: ['model-b', 'model-a'] });
    assert.equal(fs.readFileSync(path.join(root, 'store.json'), 'utf8'), store);

    const beforeInvalid = calls.length;
    for (const input of [
      { baseUrl: 'https://1.1.1.1/v1' },
      { baseUrl: 'http://1.1.1.1/v1', apiKey: 'key' },
      { baseUrl: 'https://127.0.0.1/v1', apiKey: 'key' },
      { baseUrl: 'https://169.254.169.254/v1', apiKey: 'key' },
      { baseUrl: 'https://1.1.1.1/v1?key=secret', apiKey: 'key' },
      { baseUrl: 'https://1.1.1.1/v1', id: 'official', apiKey: 'key' },
      { baseUrl: 'https://1.1.1.1/v1', id: 'missing', apiKey: 'key' },
    ]) await assert.rejects(connectionService.discoverModels(input));
    assert.equal(calls.length, beforeInvalid);

    for (const [response, pattern] of [
      [new Response('saved-private-key', { status: 401 }), /HTTP 401/],
      [new Response('saved-private-key', { status: 404 }), /HTTP 404/],
      [new Response('saved-private-key'), /JSON/],
      [Response.json({ data: {} }), /模型列表/],
      [Response.json(null), /模型列表/],
    ] as const) {
      globalThis.fetch = (async () => response) as typeof fetch;
      await assert.rejects(connectionService.models('saved'), error => error instanceof Error && pattern.test(error.message) && !error.message.includes('saved-private-key'));
    }
    globalThis.fetch = (async () => { throw new Error('network failure with saved-private-key'); }) as typeof fetch;
    await assert.rejects(connectionService.models('saved'), error => error instanceof Error && /失败或超时/.test(error.message) && !error.message.includes('saved-private-key'));
    globalThis.fetch = (async () => Response.json({ data: [] })) as typeof fetch;
    assert.deepEqual(await connectionService.models('saved'), { models: [] });
  } finally {
    globalThis.fetch = originalFetch;
    if (previousRoot === undefined) delete process.env.CODEX_CONNECTIONS_ROOT; else process.env.CODEX_CONNECTIONS_ROOT = previousRoot;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('model preview route validates input and passes only discovery fields to its service', async () => {
  const app = express();
  app.use(express.json());
  app.use('/', codexConnectionsRoutes);
  app.use((error: Error & { statusCode?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => { res.status(error.statusCode || 500).json({ error: error.message }); });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const original = connectionService.discoverModels;
  const calls: unknown[] = [];
  connectionService.discoverModels = async input => { calls.push(input); return { models: ['test-model'] }; };
  try {
    const url = `http://127.0.0.1:${address.port}/models`;
    for (const body of [{}, [], { baseUrl: 4 }, { baseUrl: 'https://example.com', id: 4 }, { baseUrl: 'https://example.com', id: '' }, { baseUrl: 'https://example.com', apiKey: {} }]) {
      const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      assert.equal(response.status, 400);
    }
    assert.equal(calls.length, 0);
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ baseUrl: 'https://example.com', id: 'saved', apiKey: '', name: 'ignored' }) });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { models: ['test-model'] });
    assert.deepEqual(calls, [{ baseUrl: 'https://example.com', id: 'saved', apiKey: '' }]);
  } finally {
    connectionService.discoverModels = original;
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
