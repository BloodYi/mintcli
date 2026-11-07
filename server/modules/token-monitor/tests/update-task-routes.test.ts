import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { tokenMonitorRoutes } from '../token-monitor.routes.js';
import { monitorUpdateTaskService } from '../update-task.service.js';

test('update routes return a tracked task and forward only the authenticated user, not client commands', async t => {
  const originalStart = monitorUpdateTaskService.start; const originalStatus = monitorUpdateTaskService.status;
  let user: unknown;
  const task = { sessionId: 'update-job', targetVersion: '9.0.0', state: 'running' as const, startedAt: 1 };
  monitorUpdateTaskService.start = async id => { user = id; return task; };
  monitorUpdateTaskService.status = async () => task;
  t.after(() => { monitorUpdateTaskService.start = originalStart; monitorUpdateTaskService.status = originalStatus; });
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { Object.assign(req, { user: { id: 7 } }); next(); });
  app.use('/api/token-monitor', tokenMonitorRoutes);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const port = (server.address() as { port: number }).port;
  const response = await fetch(`http://127.0.0.1:${port}/api/token-monitor/update-task`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command: 'untrusted', userId: 99 }) });
  assert.equal(response.status, 202); assert.equal(user, 7);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(((await response.json()) as { task: { sessionId: string } }).task.sessionId, 'update-job');
  const status = await fetch(`http://127.0.0.1:${port}/api/token-monitor/update-task`);
  assert.equal(((await status.json()) as { task: { state: string } }).task.state, 'running');
});
