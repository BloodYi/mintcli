import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { once } from 'node:events';

import express from 'express';

import { accessRouteStatus } from '../access-routes.service.js';
import { accessRoutes } from '../access-routes.routes.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'access-routes-'));
const file = path.join(dir, 'entrances.json');
const prior = process.env.MINTCLI_ACCESS_ROUTES_FILE;
process.env.MINTCLI_ACCESS_ROUTES_FILE = file;
const write = (value: unknown) => fs.writeFileSync(file, JSON.stringify(value));

test('website entrances expose only normalized public origins and never modify API routing', () => {
  write({ defaultId: 'de9929', routes: [{ id: 'de9929', name: '德国9929', origin: 'https://codex.example.com/', token: 'must-stay-private' }, { id: 'direct', name: '直连', origin: 'https://direct.example.com' }] });
  const before = fs.readFileSync(file, 'utf8');
  assert.deepEqual(accessRouteStatus(), { defaultId: 'de9929', routes: [{ id: 'de9929', name: '德国9929', origin: 'https://codex.example.com' }, { id: 'direct', name: '直连', origin: 'https://direct.example.com' }] });
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});
test('invalid, credential-bearing and duplicated entrances fail closed', () => {
  for (const origin of ['javascript:alert(1)', 'http://example.com', 'https://user:password@example.com', 'https://example.com/private', 'https://example.com?token=private']) {
    write({ routes: [{ id: 'one', name: 'One', origin }] });
    assert.throws(accessRouteStatus, /配置无效/);
  }
  write({ routes: [{ id: 'one', name: 'One', origin: 'https://example.com' }, { id: 'two', name: 'Two', origin: 'https://example.com/' }] });
  assert.throws(accessRouteStatus, /配置无效/);
});
test('read-only HTTP contract is not cached and accepts no selection mutations', async () => {
  write({ routes: [{ id: 'direct', name: '直连', origin: 'https://direct.example.com' }] });
  const app = express(); app.use('/api/access-routes', accessRoutes);
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/access-routes`;
  try {
    const response = await fetch(url); assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal((await response.json() as { routes: unknown[] }).routes.length, 1);
    assert.equal((await fetch(url, { method: 'PUT', body: JSON.stringify({ target: 'api:first', nodeId: 'de9929' }) })).status, 404);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
test.after(() => { if (prior === undefined) delete process.env.MINTCLI_ACCESS_ROUTES_FILE; else process.env.MINTCLI_ACCESS_ROUTES_FILE = prior; fs.rmSync(dir, { recursive: true, force: true }); });
