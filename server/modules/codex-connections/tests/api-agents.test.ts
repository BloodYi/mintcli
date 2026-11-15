import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { connectionService, resolveCodexConnection } from '../connections.service.js';

test('API engine selection persists independently, retains legacy chat and rejects incompatible configurations', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'api-agents-'));
  const previous = process.env.CODEX_CONNECTIONS_ROOT;
  process.env.CODEX_CONNECTIONS_ROOT = root;
  const entries = ['codex', 'claude', 'antigravity', 'legacy'].map(id => ({ id, name: id, kind: 'api', home: path.join(root, id),
    apiKey: 'saved-key-' + id, baseUrl: 'https://1.1.1.1/v1', protocol: 'chat_completions', model: 'model-' + id, ...(id === 'legacy' ? {} : { agent: id }) }));
  fs.writeFileSync(path.join(root, 'store.json'), JSON.stringify({ activeId: 'legacy', connections: entries }));
  try {
    assert.equal(connectionService.list().connections.find(item => item.id === 'legacy')?.agent, 'chat');
    for (const agent of ['codex', 'claude', 'antigravity'] as const) {
      connectionService.select(agent);
      if (agent === 'codex') assert.equal(resolveCodexConnection('api:codex').id, 'codex');
      else {
        const selected = connectionService.apiForAgent(agent);
        assert.equal(selected?.id, agent);
        assert.equal(selected?.apiKey, 'saved-key-' + agent);
        assert.equal(connectionService.apiForAgent(agent, 'api:' + agent)?.id, agent);
        assert.throws(() => connectionService.apiForAgent(agent, 'api:codex'));
      }
      const saved = await connectionService.save({ id: agent, name: agent, agent, protocol: 'chat_completions', baseUrl: 'https://1.1.1.1/v1', model: 'model-' + agent, apiKey: '' });
      assert.equal(saved.agent, agent); assert.equal(saved.hasApiKey, true);
      assert.ok(!JSON.stringify(saved).includes('saved-key'));
    }
    assert.throws(() => resolveCodexConnection('api:claude'));
    assert.equal(connectionService.apiForAgent('claude', 'official-id'), null);
    connectionService.useNativeAgent('claude');
    assert.equal(connectionService.apiForAgent('claude'), null);
    assert.equal(connectionService.apiForAgent('antigravity')?.id, 'antigravity');
    for (const [agent, protocol] of [['codex', 'anthropic'], ['claude', 'gemini'], ['antigravity', 'responses'], ['__proto__', 'chat_completions']]) {
      await assert.rejects(connectionService.save({ id: 'codex', name: 'invalid', agent, protocol, baseUrl: 'https://1.1.1.1', model: 'test' }));
    }
    await connectionService.save({ id: 'api:claude', name: 'native', agent: 'claude', protocol: 'anthropic', baseUrl: 'https://1.1.1.1/v1/messages', model: 'model' });
    assert.equal(connectionService.list().connections.find(item => item.id === 'claude')?.baseUrl, 'https://1.1.1.1/v1');
    connectionService.remove('api:antigravity');
    assert.equal(connectionService.apiForAgent('antigravity'), null);
  } finally {
    if (previous === undefined) delete process.env.CODEX_CONNECTIONS_ROOT; else process.env.CODEX_CONNECTIONS_ROOT = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('native model discovery uses the matching Anthropic or Gemini authentication and schema', async () => {
  const original = globalThis.fetch;
  const calls: { url: string; headers: Headers }[] = [];
  globalThis.fetch = (async (url, init) => {
    calls.push({ url: String(url), headers: new Headers(init?.headers) });
    return Response.json(String(url).includes('v1beta') ? { models: [{ name: 'models/custom-gemini' }] } : { data: [{ id: 'custom-claude' }] });
  }) as typeof fetch;
  try {
    assert.deepEqual(await connectionService.discoverModels({ baseUrl: 'https://1.1.1.1', apiKey: 'gemini-key', protocol: 'gemini' }), { models: ['custom-gemini'] });
    assert.equal(calls.at(-1)?.url, 'https://1.1.1.1/v1beta/models');
    assert.equal(calls.at(-1)?.headers.get('x-goog-api-key'), 'gemini-key');
    assert.deepEqual(await connectionService.discoverModels({ baseUrl: 'https://1.1.1.1', apiKey: 'claude-key', protocol: 'anthropic' }), { models: ['custom-claude'] });
    assert.equal(calls.at(-1)?.headers.get('x-api-key'), 'claude-key');
    assert.equal(calls.at(-1)?.headers.get('anthropic-version'), '2023-06-01');
  } finally { globalThis.fetch = original; }
});
