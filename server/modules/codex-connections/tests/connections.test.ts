import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { connectionService, resolveCodexConnection } from '../connections.service.js';

test('account selection captures isolated environments and never exposes saved API secrets', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudcli-connections-'));
  const previous = process.env.CODEX_CONNECTIONS_ROOT;
  process.env.CODEX_CONNECTIONS_ROOT = root;
  try {
    const store = { activeId: 'a', connections: [
      { id: 'a', name: 'A', kind: 'chatgpt', home: path.join(root, 'a') },
      { id: 'b', name: 'B', kind: 'chatgpt', home: path.join(root, 'b') },
      { id: 'api', name: 'API', kind: 'api', home: path.join(root, 'api'), apiKey: 'unit-test-private-key', baseUrl: 'https://example.com/v1', protocol: 'chat_completions' },
    ] };
    fs.writeFileSync(path.join(root, 'store.json'), JSON.stringify(store));
    const first = resolveCodexConnection();
    connectionService.select('b');
    const second = resolveCodexConnection();
    assert.equal(first.id, 'a'); assert.equal(second.id, 'b');
    assert.notEqual(first.env.CODEX_HOME, second.env.CODEX_HOME);
    assert.equal(first.env.CODEX_HOME, path.join(root, 'a'));
    assert.ok(!JSON.stringify(connectionService.list()).includes('unit-test-private-key'));
    assert.equal(resolveCodexConnection('api').apiKey, 'unit-test-private-key');
    const quota = await connectionService.quota('api');
    assert.equal(quota.status, 'unavailable'); assert.deepEqual(quota.windows, []);
    assert.ok(!JSON.stringify(quota).includes('unit-test-private-key'));
    assert.throws(() => connectionService.select('../../escape'));
    await assert.rejects(connectionService.save({ kind: 'chatgpt', name: 'x'.repeat(81) }));
    connectionService.remove('a');
    assert.equal(connectionService.list().connections.length, 2);
    assert.equal(connectionService.list().activeId, 'b');
  } finally {
    if (previous === undefined) delete process.env.CODEX_CONNECTIONS_ROOT; else process.env.CODEX_CONNECTIONS_ROOT = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('account storage accepts more than twenty identities without deleting prior entries', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'unlimited-accounts-'));
  const original = { HOME: process.env.HOME, CODEX_CONNECTIONS_ROOT: process.env.CODEX_CONNECTIONS_ROOT };
  process.env.HOME = root; process.env.CODEX_CONNECTIONS_ROOT = path.join(root, 'connections');
  try {
    for (let index = 0; index < 25; index++) await connectionService.save({ name: 'Account ' + index, kind: 'chatgpt' });
    assert.ok(connectionService.list().connections.length >= 25);
  } finally {
    for (const [key, value] of Object.entries(original)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
