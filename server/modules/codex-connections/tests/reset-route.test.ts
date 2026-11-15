import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { codexConnectionsRoutes, connectionService } from '../index.js';

test('reset transport requires explicit confirmation and API accounts cannot redeem official cards', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mintcli-reset-route-'));
  const previousRoot = process.env.CODEX_CONNECTIONS_ROOT;
  process.env.CODEX_CONNECTIONS_ROOT = dir;
  fs.writeFileSync(path.join(dir, 'store.json'), JSON.stringify({ activeId: 'api', connections: [{ id: 'api', kind: 'api', home: dir }] }));
  t.after(() => {
    if (previousRoot === undefined) delete process.env.CODEX_CONNECTIONS_ROOT; else process.env.CODEX_CONNECTIONS_ROOT = previousRoot;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await assert.rejects(connectionService.consumeReset('api', '50b918df-cc2c-489b-bd6a-24b16873774c'), /仅用于官方/);
  const app = express(); app.use(express.json()); app.use('/', codexConnectionsRoutes);
  app.use((error: Error & { statusCode?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => { res.status(error.statusCode || 500).json({ error: error.message }); });
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const original = connectionService.consumeReset; const calls: unknown[] = [];
  connectionService.consumeReset = async (...args) => { calls.push(args); return { connectionId: args[0], status: 'completed', resetOutcome: 'reset', windows: [], checkedAt: Date.now() }; };
  t.after(() => { connectionService.consumeReset = original; });
  const url = `http://127.0.0.1:${address.port}/fixture/reset`;
  for (const body of [{}, { confirmed: false, idempotencyKey: 'key' }, { confirmed: true }, { confirmed: true, idempotencyKey: 1 }, { confirmed: true, idempotencyKey: 'key', creditId: {} }]) {
    assert.equal((await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).status, 400);
  }
  assert.equal(calls.length, 0);
  assert.equal((await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirmed: true, idempotencyKey: 'key', creditId: 'card' }) })).status, 200);
  assert.deepEqual(calls, [['fixture', 'key', 'card']]);
});
