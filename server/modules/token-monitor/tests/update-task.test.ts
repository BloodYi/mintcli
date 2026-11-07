import test from 'node:test';
import assert from 'node:assert/strict';
import { createMonitorUpdateTaskService } from '../update-task.service.js';

function fixture() {
  let saved: Awaited<ReturnType<ReturnType<typeof createMonitorUpdateTaskService>['status']>> = null; let running = false; let created = 0; let prompt = '';
  let finish!: (value: { started: boolean; error: string | null }) => void;
  const release = { status: 'ok', installedVersion: '1.0.0', latestVersion: '1.1.0', updateAvailable: true };
  const service = createMonitorUpdateTaskService({
    read: () => saved, write: value => { saved = value; }, check: async () => release,
    running: () => running, root: () => '/app', create: () => { created++; return 'update-session'; },
    launch: async (_id, _user, content) => { prompt = content; running = true; return new Promise(resolve => { finish = resolve; }); },
  });
  return { service, release, saved: () => saved!, created: () => created, prompt: () => prompt,
    finish(error: string | null = null) { running = false; finish({ started: true, error }); } };
}

test('concurrent update clicks share one tracked conversation with the persisted rules', async () => {
  const f = fixture();
  const [a, b] = await Promise.all([f.service.start(1), f.service.start(1)]);
  assert.equal(a.sessionId, b.sessionId); assert.equal(f.created(), 1);
  assert.match(f.prompt(), /\/app\/plugins\/token-monitor\/UPDATE_RULES.md/);
  assert.match(f.prompt(), /空闲/); assert.match(f.prompt(), /不要调用更新按钮/);
  assert.equal((await f.service.status())?.state, 'running');
  await f.service.start(1); assert.equal(f.created(), 1);
  f.finish(); await new Promise(resolve => setImmediate(resolve));
  assert.equal((await f.service.status())?.state, 'review');
  await f.service.start(1); assert.equal(f.created(), 1);
  f.release.installedVersion = '1.1.0';
  assert.equal((await f.service.status())?.state, 'installed');
  f.release.installedVersion = '1.2.0';
  assert.equal((await f.service.status())?.state, 'installed');
});

test('release failures and no available update never allocate or run a task', async () => {
  const f = fixture(); f.release.updateAvailable = false;
  await assert.rejects(f.service.start(1), /没有可验证/); assert.equal(f.created(), 0);
  f.release.updateAvailable = true; f.release.status = 'unavailable';
  await assert.rejects(f.service.start(1)); assert.equal(f.created(), 0);
});

test('failed agent turns remain failed and a restart cannot claim a running or installed task', async () => {
  const f = fixture(); await f.service.start(1); f.finish('runtime failed');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await f.service.status())?.state, 'failed');
  const restarted = createMonitorUpdateTaskService({ read: () => ({ ...f.saved(), state: 'running' }), check: async () => f.release, running: () => false });
  assert.equal((await restarted.status())?.state, 'interrupted');
});
