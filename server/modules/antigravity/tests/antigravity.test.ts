import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { antigravityBridge, createAntigravityBridge } from '../antigravity.service.js';
import { getThinkTranslateMonitorSummary, thinkTranslateService } from '../think-translate.service.js';

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

test('allows authenticated think-translate endpoints and rejects unknown think-translate paths', async () => {
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
    ['GET', '/api/think-translate/config'],
    ['POST', '/api/think-translate/config'],
    ['POST', '/api/think-translate/translate'],
  ] as const) {
    assert.equal((await bridge.request(method, endpoint, method === 'POST' ? {} : undefined)).status, 200);
  }
  assert.deepEqual(seen, [
    '/api/think-translate/config',
    '/api/think-translate/config',
    '/api/think-translate/translate',
  ]);
  await assert.rejects(bridge.request('POST', '/api/think-translate/unknown'));
});

test('records privacy-safe think-translate telemetry and quota-failover summary without storing reasoning text', async t => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mintcli-think-telemetry-'));
  const prevRoot = process.env.AGENT_CONNECTIONS_ROOT;
  process.env.AGENT_CONNECTIONS_ROOT = tmpRoot;
  t.after(async () => {
    if (prevRoot === undefined) delete process.env.AGENT_CONNECTIONS_ROOT;
    else process.env.AGENT_CONNECTIONS_ROOT = prevRoot;
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  await fs.writeFile(
    path.join(tmpRoot, 'think-translate.json'),
    JSON.stringify({
      account_id: 'agy:user-a@example.com',
      model: 'gemini-4-hydrogen-medium',
      target_lang: 'zh-CN',
      updated_at: '2026-11-25T05:34:42.430Z',
    }),
  );

  t.mock.method(antigravityBridge, 'request', async (_method: string, target: string) => {
    if (target.startsWith('/api/think-translate/translate')) {
      return Response.json({
        ok: true,
        translated: '不应落盘的译文正文',
        account_id: 'ultra-442715d6',
        account_email: 'user-b@example.com',
        model: 'gemini-3.8-flash-low',
        reported_model: 'gemini-3.8-flash-low',
        target_lang: 'zh-CN',
        cached: false,
        fallback_used: true,
        fallback_reason: '翻译模型额度已耗尽（HTTP 429，约 163h9m 后重置）',
        duration_ms: 2000,
        usage: { input: 9000, output: 120, cacheRead: 3000, cacheWrite: 0, reasoning: 0, total: 12120 },
      });
    }
    if (target.startsWith('/api/think-translate/config')) {
      return Response.json({
        account_id: 'user-a@example.com',
        model: 'gemini-4-hydrogen-medium',
        target_lang: 'zh-CN',
        cooldowns: [
          {
            account_id: 'user-a@example.com',
            model: '',
            reason: '翻译模型额度已耗尽（HTTP 429，约 163h9m 后重置）',
            remaining_seconds: 21600,
          },
        ],
      });
    }
    return Response.json({ ok: true });
  });

  const translated = await thinkTranslateService.translate({
    text: 'Private English reasoning text that must not be persisted.',
  });
  assert.equal(translated.account_id, 'agy:ultra-442715d6');

  const summary = await getThinkTranslateMonitorSummary();
  assert.equal(summary.totalCalls, 1);
  assert.equal(summary.fallbackCalls, 1);
  assert.equal(summary.tokens.total, 12120);
  assert.equal(summary.speed, 60);
  assert.equal(summary.models[0]?.model, 'gemini-3.8-flash-low');
  assert.equal(summary.cooldowns[0]?.accountId, 'agy:user-a@example.com');

  const rawTelemetry = await fs.readFile(path.join(tmpRoot, 'think-translate-telemetry.json'), 'utf8');
  assert.ok(!rawTelemetry.includes('Private English reasoning text'));
  assert.ok(!rawTelemetry.includes('不应落盘的译文正文'));
});
