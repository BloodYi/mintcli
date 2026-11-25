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

test('forwards message recall to the authenticated native conversation endpoint', async () => {
  const target = '/api/conversations/fixture/recall';
  const bridge = createAntigravityBridge({ credentialsFile: '/not-present', fetch: async (url, init) => {
    if (new URL(String(url)).pathname === '/api/login') {
      return new Response('{}', { headers: { 'set-cookie': 'agy_session=fixture' } });
    }
    assert.equal(new URL(String(url)).pathname, target);
    assert.equal(init?.method, 'POST');
    assert.deepEqual(JSON.parse(String(init?.body)), { message_id: 'latest' });
    return Response.json({ status: 'recalled' });
  } });
  assert.deepEqual(await (await bridge.request('POST', target, { message_id: 'latest' })).json(), { status: 'recalled' });
});

test('allows authenticated ACP info probes with optional refresh query', async () => {
  const seen: string[] = [];
  const bridge = createAntigravityBridge({ credentialsFile: '/not-present', fetch: async (url) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === '/api/login') {
      return new Response('{}', { headers: { 'set-cookie': 'agy_session=fixture' } });
    }
    seen.push(parsed.pathname + parsed.search);
    return Response.json({ ok: true, acp: { available: true, protocolVersion: 1, serverVersion: '1.5.14' } });
  } });
  const body = await (await bridge.request('GET', '/api/acp-info?refresh=1')).json() as { ok: boolean };
  assert.equal(body.ok, true);
  assert.deepEqual(seen, ['/api/acp-info?refresh=1']);
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
  const requestedAccounts: unknown[] = [];
  const bridge = createAntigravityBridge({ credentialsFile: '/not-present', fetch: async (url, init) => {
    const route = new URL(String(url)).pathname;
    if (route === '/api/login') return new Response('{}', { headers: { 'set-cookie': 'agy_session=fixture' } });
    if (route === '/api/accounts') return Response.json({ accounts: ['a', 'b'].map(id => ({ id, active: id === active })) });
    if (route === '/api/accounts/switch') { await new Promise(resolve => setTimeout(resolve, 5)); active = JSON.parse(String(init?.body)).id; return Response.json({ ok: true }); }
    if (route === '/api/chat') { turns.push(active); requestedAccounts.push(JSON.parse(String(init?.body)).account_id); return Response.json({ ok: true }); }
    return Response.json({ email: active });
  } });
  await Promise.all([bridge.startChatForAccount('a', {}), bridge.startChatForAccount('b', {})]);
  assert.deepEqual(turns, ['a', 'b']);
  assert.deepEqual(requestedAccounts, ['a', 'b']);
  await assert.rejects(bridge.quotaForAccount('a', false));
  assert.equal((await (await bridge.quotaForAccount('b', false)).json() as { email: string }).email, 'b');
});

test('allows authenticated live turn message injection endpoint', async () => {
  const target = '/api/turns/0123456789abcdef0123456789abcdef/messages';
  const bridge = createAntigravityBridge({ credentialsFile: '/not-present', fetch: async (url, init) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === '/api/login') {
      return new Response('{}', { headers: { 'set-cookie': 'agy_session=fixture' } });
    }
    assert.equal(parsed.pathname, target);
    assert.equal(init?.method, 'POST');
    assert.deepEqual(JSON.parse(String(init?.body)), { content: 'follow-up', message_id: 'm2' });
    return Response.json({ ok: true, message_id: 'm2' });
  } });
  assert.deepEqual(
    await (await bridge.request('POST', target, { content: 'follow-up', message_id: 'm2' })).json(),
    { ok: true, message_id: 'm2' },
  );
});

test('allows authenticated agy-fast plugin endpoints and rejects unknown agy-fast paths', async () => {
  const seen: string[] = [];
  const bridge = createAntigravityBridge({ credentialsFile: '/not-present', fetch: async (url) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === '/api/login') {
      return new Response('{}', { headers: { 'set-cookie': 'agy_session=fixture' } });
    }
    seen.push(parsed.pathname);
    return Response.json({ ok: true });
  } });
  for (const [method, endpoint] of [
    ['GET', '/api/agy-fast/status'],
    ['POST', '/api/agy-fast/check-update'],
    ['POST', '/api/agy-fast/update'],
    ['POST', '/api/agy-fast/config'],
  ] as const) {
    assert.equal((await bridge.request(method, endpoint, method === 'POST' ? {} : undefined)).status, 200);
  }
  assert.deepEqual(seen, [
    '/api/agy-fast/status',
    '/api/agy-fast/check-update',
    '/api/agy-fast/update',
    '/api/agy-fast/config',
  ]);
  await assert.rejects(bridge.request('POST', '/api/agy-fast/unknown'));
});
