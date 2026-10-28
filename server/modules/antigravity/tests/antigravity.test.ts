import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAntigravityBridge } from '../antigravity.service.js';

test('native backend login is shared, its cookie never goes in the public response, and SSE stays unchanged', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-bridge-'));
  const file = path.join(root, '.env');
  await fs.writeFile(file, 'BASIC_AUTH_USER=fixture\nBASIC_AUTH_PASS="fixture-password"\n');
  let logins = 0;
  const fetcher: typeof fetch = async (input, init) => {
    if (String(input).endsWith('/api/login')) {
      logins += 1;
      assert.deepEqual(JSON.parse(String(init?.body)), { username: 'fixture', password: 'fixture-password' });
      return new Response('{}', { headers: { 'set-cookie': 'agy_session=fixture-cookie; HttpOnly; Secure' } });
    }
    assert.equal(new Headers(init?.headers).get('Cookie'), 'agy_session=fixture-cookie');
    assert.equal(new Headers(init?.headers).get('Authorization'), null);
    return new Response('data: {"event":"delta","delta":"原生回复"}\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
  };
  try {
    const bridge = createAntigravityBridge({ credentialsFile: file, fetch: fetcher });
    const responses = await Promise.all([bridge.request('GET', '/api/models'), bridge.request('POST', '/api/chat', { messages: [] })]);
    assert.equal(logins, 1);
    assert.equal(await responses[1].text(), 'data: {"event":"delta","delta":"原生回复"}\n\n');
    assert.equal(responses[1].headers.get('set-cookie'), null);
    await assert.rejects(bridge.request('GET', '/api/updates/install'));
    await assert.rejects(bridge.request('GET', '/api/accounts/../../secrets'));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('account switch must name a stored account, and an expired backend session is retried only after reauthentication', async () => {
  let logins = 0;
  let expire = true;
  const fetcher: typeof fetch = async (input) => {
    if (String(input).endsWith('/api/login')) {
      logins += 1;
      return new Response('{}', { headers: { 'set-cookie': 'agy_session=cookie' + logins } });
    }
    if (expire) { expire = false; return new Response('{}', { status: 401 }); }
    return new Response(JSON.stringify(String(input).endsWith('/api/accounts')
      ? { accounts: [{ id: 'saved@example.com' }] } : { ok: true }));
  };
  const bridge = createAntigravityBridge({ credentialsFile: '/not-present', fetch: fetcher });
  assert.equal((await bridge.switchAccount({ id: 'saved@example.com' })).status, 200);
  assert.equal(logins, 2);
  await assert.rejects(bridge.switchAccount({ id: '../escape' }));
  await assert.rejects(bridge.switchAccount({ id: 'missing' }));
  assert.throws(() => createAntigravityBridge({ baseUrl: 'https://example.com' }));
});

test('native select/start is atomic and quota never silently measures another account', async () => {
  let active = 'a';
  const turns: string[] = [];
  const bridge = createAntigravityBridge({ credentialsFile: '/not-present', fetch: async (url, init) => {
    const route = new URL(String(url)).pathname;
    if (route === '/api/login') return new Response('{}', { headers: { 'set-cookie': 'agy_session=fixture' } });
    if (route === '/api/accounts') return Response.json({ accounts: ['a', 'b'].map(id => ({ id, active: id === active })) });
    if (route === '/api/accounts/switch') { await new Promise(resolve => setTimeout(resolve, 5)); active = JSON.parse(String(init?.body)).id; return Response.json({ ok: true }); }
    if (route === '/api/chat') { turns.push(active); return Response.json({ ok: true }); }
    return Response.json({ email: active });
  } });
  await Promise.all([bridge.startChatForAccount('a', {}), bridge.startChatForAccount('b', {})]);
  assert.deepEqual(turns, ['a', 'b']);
  await assert.rejects(bridge.quotaForAccount('a', false));
  assert.equal((await (await bridge.quotaForAccount('b', false)).json() as { email: string }).email, 'b');
});
