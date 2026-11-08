import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import express from 'express';
import { egressEnvironment, egressFetch, egressService } from '../egress.service.js';
import { egressRoutes } from '../egress.routes.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'egress-test-'));
process.env.MINTCLI_EGRESS_ROOT = root;
const inventory = (nodes: unknown[]) => fs.writeFileSync(path.join(root, 'inventory.json'), JSON.stringify({ updatedAt: null, nodes }));

test('routing stays independent, persists and removes every inherited proxy for explicit direct', () => {
  inventory([{ id: 'node-a', name: 'A', port: 18200 }]);
  egressService.save('codex', 'node-a'); egressService.save('api:first', 'direct'); egressService.save('claude', 'legacy');
  const source = { HTTPS_PROXY: 'http://old:1', all_proxy: 'socks://old:1', WSS_PROXY: 'http://old:1', NO_PROXY: '*', NODE_USE_ENV_PROXY: '1', CREDENTIAL_HOME: 'keep' };
  const native = egressEnvironment('codex', source);
  const direct = egressEnvironment('api:first', source);
  assert.equal(native.HTTPS_PROXY, 'http://127.0.0.1:18200');
  for (const key of ['HTTPS_PROXY', 'all_proxy', 'WSS_PROXY']) assert.equal(direct[key], undefined);
  assert.equal(direct.NODE_USE_ENV_PROXY, '0'); assert.equal(direct.CREDENTIAL_HOME, 'keep');
  assert.equal(egressEnvironment('claude', source).HTTPS_PROXY, 'http://127.0.0.1:17890');
  assert.equal(source.NO_PROXY, '*');
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'selection.json'), 'utf8')).selections.codex, 'node-a');
  assert.equal(fs.statSync(path.join(root, 'selection.json')).mode & 0o777, 0o600);
  assert.throws(() => egressService.save('api:bad/path', 'direct'));
  assert.throws(() => egressService.save('codex', 'http://127.0.0.1:1'));
  inventory([]); assert.throws(() => egressEnvironment('codex'), /不可用/);
});

test('real HTTP requests use separate captured proxies, survive choice changes and fail closed', async () => {
  const proxies = ['A', 'B'].map(label => {
    const server = createServer();
    server.on('connect', (_req, socket) => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      socket.once('data', () => socket.end(`HTTP/1.1 200 OK\r\nContent-Length: 1\r\nConnection: close\r\n\r\n${label}`));
    });
    return server;
  });
  for (const proxy of proxies) { proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening'); }
  const ports = proxies.map(proxy => (proxy.address() as { port: number }).port);
  inventory(ports.map((port, i) => ({ id: 'node-' + i, name: String(i), port })));
  try {
    egressService.save('codex', 'node-0'); egressService.save('api:first', 'node-1');
    const oldRun = egressFetch('codex');
    egressService.save('codex', 'node-1');
    const [old, fresh, api] = await Promise.all([oldRun('http://no-dns-needed.invalid'), egressFetch('codex')('http://no-dns-needed.invalid'), egressFetch('api:first')('http://no-dns-needed.invalid')]);
    assert.deepEqual(await Promise.all([old.text(), fresh.text(), api.text()]), ['A', 'B', 'B']);
    await new Promise<void>(resolve => proxies[0].close(() => resolve()));
    await assert.rejects(oldRun('http://no-dns-needed.invalid', { signal: AbortSignal.timeout(2000) }));
  } finally { for (const proxy of proxies) proxy.close(); }
});

test('authenticated router contract rejects malformed writes and returns no secrets', async () => {
  const app = express();app.use(express.json());app.use('/api/egress', egressRoutes);
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/egress`;
  try {
    for (const body of [{}, { target: 'invalid', nodeId: 'direct' }, { target: 'codex', nodeId: {} }]) {
      assert.equal((await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).status, 400);
    }
    const response = await fetch(url); assert.equal(response.headers.get('cache-control'), 'no-store');
    const text = await response.text();assert.ok(!/password|uuid|subscription_url|secret/.test(text));
  } finally { server.closeAllConnections();await new Promise<void>(resolve => server.close(() => resolve())); }
});

test.after(() => { delete process.env.MINTCLI_EGRESS_ROOT; fs.rmSync(root, { recursive: true, force: true }); });
