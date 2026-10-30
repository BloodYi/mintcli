import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { startResponseCapture, readResponseCapture } from '../response-capture.service.js';

test('Responses relay preserves split SSE bytes and auth while recording only response metadata', async () => {
  const sessionId = randomUUID();
  const events = [
    { type: 'response.created', response: { id: 'resp1', model: 'actual-model', private: 'must-not-store' } },
    { type: 'response.output_text.delta', delta: '你好' },
    { type: 'response.completed', response: { id: 'resp1', output: [{ id: 'msg1', content: 'must-not-store' }] } },
  ].map(value => 'data: ' + JSON.stringify(value) + '\r\n\r\n').join('');
  const upstream = createServer(async (req, res) => {
    assert.ok(['/v1/responses', '/v1/responses/compact', '/v1/responses/input_tokens'].includes(req.url!));
    assert.equal(req.headers.authorization, 'Bearer private-key');
    let body = ''; for await (const chunk of req) body += chunk;
    assert.equal(JSON.parse(body).model, 'requested-alias');
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const bytes = Buffer.from(events);
    for (let index = 0; index < bytes.length; index += 7) res.write(bytes.subarray(index, index + 7));
    res.end();
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const address = upstream.address() as { port: number };
  const capture = await startResponseCapture(`http://127.0.0.1:${address.port}/v1`, sessionId);
  try {
    const result = await fetch(capture.baseUrl + '/responses', { method: 'POST', headers: { Authorization: 'Bearer private-key' }, body: JSON.stringify({ model: 'requested-alias' }) });
    assert.equal(await result.text(), events);
    const records = await readResponseCapture(sessionId);
    assert.equal(records.at(-1)?.model, 'actual-model');
    assert.deepEqual(records.at(-1)?.itemIds, ['msg1']);
    assert.ok(!JSON.stringify(records).includes('private-key'));
    assert.ok(!JSON.stringify(records).includes('must-not-store'));
    for (const suffix of ['/responses/compact', '/responses/input_tokens']) {
      const compact = await fetch(capture.baseUrl + suffix, { method: 'POST', headers: { Authorization: 'Bearer private-key' }, body: JSON.stringify({ model: 'requested-alias' }) });
      assert.equal(await compact.text(), events);
    }
    assert.equal((await fetch(capture.baseUrl + '/elsewhere')).status, 404);
    assert.equal((await fetch(capture.baseUrl.replace(/\/[^/]+$/, '/wrong') + '/responses')).status, 404);
  } finally {
    await capture.close(); upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve()));
    await rm(path.join(os.homedir(), '.claude-code-ui/token-monitor', sessionId + '.jsonl'), { force: true });
  }
});

test('capture joins actual HTTP model to native reply and clears older model on an unreported response', async () => {
  const { createTokenMonitorService } = await import('../token-monitor.service.js');
  const { mkdtemp, writeFile } = await import('node:fs/promises');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'monitor-capture-'));
  const sessionId = randomUUID();
  const upstream = createServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ object: 'response', id: 'resp', model: 'real-returned', output: [{ id: 'msg' }] })); });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const capture = await startResponseCapture(`http://127.0.0.1:${(upstream.address() as { port: number }).port}`, sessionId);
  const file = path.join(directory, 'session.jsonl');
  try {
    await (await fetch(capture.baseUrl + '/responses', { method: 'POST', body: '{}' })).text();
    await writeFile(file, JSON.stringify({ timestamp: new Date().toISOString(), type: 'response_item', payload: { role: 'assistant', id: 'msg', content: 'reply' } }));
    const service = createTokenMonitorService({ getSession: () => ({ provider: 'codex', jsonl_path: file, model: 'alias' }) as any });
    const snapshot = await service.snapshot(sessionId);
    assert.equal(snapshot.returnedModel, 'real-returned');
    assert.equal(snapshot.replies[0].model, 'real-returned');
    assert.equal(snapshot.replies[0].raw.model, 'real-returned');
    await new Promise(resolve => setTimeout(resolve, 5));
    const next = await startResponseCapture('http://127.0.0.1:1', sessionId);
    await next.close();
    assert.equal((await service.snapshot(sessionId)).returnedModel, null);
  } finally {
    await capture.close(); upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
    await rm(path.join(os.homedir(), '.claude-code-ui/token-monitor', sessionId + '.jsonl'), { force: true });
  }
});


test('a later compatible reply without model never inherits a completed native turn label', async () => {
  const { createTokenMonitorService } = await import('../token-monitor.service.js');
  const { mkdtemp, writeFile, mkdir } = await import('node:fs/promises');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'monitor-switch-'));
  const sessionId = randomUUID();
  const metadata = path.join(os.homedir(), '.claude-code-ui/token-monitor', sessionId + '.jsonl');
  const file = path.join(directory, 'session.jsonl');
  try {
    await mkdir(path.dirname(metadata), { recursive: true });
    await writeFile(metadata, [
      { kind: 'response', timestamp: '2026-10-30T12:00:00Z', model: 'native-model', itemIds: ['native-message'] },
      { kind: 'end', timestamp: '2026-10-30T12:00:02Z', model: null },
    ].map(value => JSON.stringify(value)).join('\n'));
    await writeFile(file, JSON.stringify({ timestamp: '2026-10-30T12:00:03Z', type: 'response_item', payload: { role: 'assistant', content: 'compatible reply without model' } }));
    const service = createTokenMonitorService({ getSession: () => ({ provider: 'codex', jsonl_path: file }) as any });
    const result = await service.snapshot(sessionId);
    assert.equal(result.returnedModel, null);
    assert.equal(result.replies[0].model, null);
  } finally { await rm(directory, { recursive: true, force: true }); await rm(metadata, { force: true }); }
});

for (const format of ['sse', 'json'] as const) {
  test(`response capture detects ${format} when upstream omits Content-Type`, async () => {
    const sessionId = randomUUID();
    const response = { object: 'response', id: 'headerless', model: 'actual-headerless-model', output: [] };
    const body = format === 'sse' ? 'data: ' + JSON.stringify({ type: 'response.created', response }) + '\n\n' : JSON.stringify(response);
    const upstream = createServer((_req, res) => {
      res.writeHead(200);
      res.write(body.slice(0, 2));
      setTimeout(() => res.end(body.slice(2)), 10);
    });
    upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
    const capture = await startResponseCapture(`http://127.0.0.1:${(upstream.address() as { port: number }).port}`, sessionId);
    try {
      const result = await fetch(capture.baseUrl + '/responses', { method: 'POST', body: '{}' });
      assert.equal(result.headers.get('content-type'), null);
      assert.equal(await result.text(), body);
      assert.equal((await readResponseCapture(sessionId)).at(-1)?.model, 'actual-headerless-model');
    } finally {
      await capture.close(); upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve()));
      await rm(path.join(os.homedir(), '.claude-code-ui/token-monitor', sessionId + '.jsonl'), { force: true });
    }
  });
}
