import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import express from 'express';
import { createGithubRouter } from '../github.routes.js';
import { createGithubService } from '../github.service.js';

test('GitHub routes require a mintcli user and validate upload previews before calling the service', async () => {
  let calls = 0;
  const service = createGithubService({ token: () => null });
  service.push = async () => { calls++; return null; };
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { if (req.headers['x-test-user']) (req as typeof req & { user: { id: number } }).user = { id: 7 }; next(); });
  app.use('/api/github', createGithubRouter(service));
  app.use((error: { statusCode?: number; message: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => { res.status(error.statusCode || 500).json({ error: error.message }); });
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/github`;
  try {
    assert.equal((await fetch(url + '/status')).status, 401);
    const connected = await fetch(url + '/status', { headers: { 'x-test-user': '7' } });
    assert.equal(connected.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await connected.json(), { connected: false, account: null });
    const invalid = await fetch(url + '/push', { method: 'POST', headers: { 'x-test-user': '7', 'content-type': 'application/json' }, body: JSON.stringify({ project: '../../outside' }) });
    assert.equal(invalid.status, 400); assert.equal(calls, 0);
    const valid = await fetch(url + '/push', { method: 'POST', headers: { 'x-test-user': '7', 'content-type': 'application/json' }, body: JSON.stringify({ project: 'project-1', expectedHead: 'a'.repeat(40), expectedBranch: 'main' }) });
    assert.equal(valid.status, 200); assert.equal(calls, 1);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
