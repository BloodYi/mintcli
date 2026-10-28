import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createSystemUpdateService } from '../system.service.js';
import { createSystemRouter } from '../system.routes.js';
import { AppError } from '@/shared/utils.js';

test('mintcli rejects system updates before any installer can run', async () => {
  await assert.rejects(createSystemUpdateService().updateSystem(), (error: unknown) => error instanceof AppError && error.code === 'SYSTEM_UPDATES_DISABLED' && error.statusCode === 403);
});

test('the system update HTTP endpoint returns 403 for a manual request', async () => {
  const app = express();
  app.use(createSystemRouter(createSystemUpdateService()));
  app.use((error: AppError, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(error.statusCode).json({ code: error.code }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/update`, { method: 'POST' });
    assert.equal(response.status, 403);
    assert.equal((await response.json() as { code: string }).code, 'SYSTEM_UPDATES_DISABLED');
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
