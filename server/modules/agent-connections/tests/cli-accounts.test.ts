import assert from 'node:assert/strict';
import test from 'node:test';
import { createCliAccountService } from '../cli-accounts.service.js';
import type { ProviderAuthStatus } from '@/shared/types.js';

const authorized = (provider: 'cursor' | 'opencode'): ProviderAuthStatus => ({ provider, installed: true, installedVersion: 'fixture', authenticated: true, email: `${provider}@example.test`, method: 'cli' });

test('Cursor and OpenCode expose CLI-owned accounts without returning credential data', async () => {
  const service = createCliAccountService(async provider => authorized(provider));
  const rows = await service.list();
  assert.deepEqual(rows.map(row => row.id), ['cursor:default', 'opencode:default']);
  assert.ok(rows.every(row => row.authorized && row.accountId === 'default'));
  assert.equal(JSON.stringify(rows).includes('token'), false);
});

test('catalog polling shares in-flight status checks, while manual quota refresh rechecks login', async () => {
  let calls = 0;
  const service = createCliAccountService(async provider => { calls++; await new Promise(resolve => setTimeout(resolve, 5)); return authorized(provider); });
  await Promise.all([service.list(), service.list()]);
  assert.equal(calls, 2);
  await service.list();
  assert.equal(calls, 2);
  await service.quota('cursor', true);
  assert.equal(calls, 3);
});

test('unavailable quota is distinct from a zero balance even for an authenticated account', async () => {
  const service = createCliAccountService(async provider => authorized(provider));
  const snapshot = await service.quota('opencode', false);
  assert.equal(snapshot.status, 'unavailable');
  assert.deepEqual(snapshot.windows, []);
  assert.equal(snapshot.dashboardUrl, 'https://opencode.ai/console');
  assert.match(snapshot.reason, /官方控制台/);
});

test('native accounts accept only the CLI-owned default identity', () => {
  const service = createCliAccountService();
  service.validate('cursor', 'default');
  assert.throws(() => service.validate('cursor', 'another-account'));
  assert.throws(() => service.validate('opencode', '../secrets'));
});
