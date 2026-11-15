import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { agentConnectionsService } from '../connections.service.js';
import { cliAccounts } from '../cli-accounts.service.js';
import { antigravityBridge } from '@/modules/antigravity/index.js';
import { connectionService } from '@/modules/codex-connections/index.js';
import { sessionsService } from '@/modules/providers/index.js';

test('selecting an API dispatches the chosen engine and keeps API quota separate from native subscriptions', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-api-selection-'));
  const previous = { CODEX_CONNECTIONS_ROOT: process.env.CODEX_CONNECTIONS_ROOT, CLAUDE_ACCOUNTS_ROOT: process.env.CLAUDE_ACCOUNTS_ROOT, AGENT_CONNECTIONS_ROOT: process.env.AGENT_CONNECTIONS_ROOT };
  process.env.CODEX_CONNECTIONS_ROOT = root;
  process.env.CLAUDE_ACCOUNTS_ROOT = path.join(root, 'claude');
  process.env.AGENT_CONNECTIONS_ROOT = path.join(root, 'selection');
  fs.writeFileSync(path.join(root, 'store.json'), JSON.stringify({ activeId: 'codex', connections: ['codex', 'claude', 'antigravity'].map(agent => ({
    id: agent, kind: 'api', name: agent, agent, protocol: 'chat_completions', model: agent + '-model', baseUrl: 'https://1.1.1.1/v1', apiKey: 'private-' + agent, home: root,
  })) }));
  const original = { request: antigravityBridge.request, switchAccount: antigravityBridge.switchAccount, list: cliAccounts.list, switchSession: sessionsService.switchSessionProvider };
  let nativeSwitches = 0;
  const switched: string[] = [];
  antigravityBridge.request = async () => Response.json({ accounts: [] });
  antigravityBridge.switchAccount = async () => { nativeSwitches++; return Response.json({ ok: true }); };
  cliAccounts.list = async () => [];
  sessionsService.switchSessionProvider = async (_id, provider, select) => { switched.push(provider); await select(); };
  try {
    for (const agent of ['codex', 'claude', 'antigravity']) {
      const result = await agentConnectionsService.select('api:' + agent, 'chat-id');
      const row = result.connections.find(item => item.id === 'api:' + agent);
      assert.equal(row?.provider, agent); assert.equal(row?.accountId, 'api:' + agent);
      assert.equal(result.activeId, 'api:' + agent);
      assert.ok(!JSON.stringify(result).includes('private-'));
      const quota = await agentConnectionsService.quota('api:' + agent, false);
      assert.ok('status' in quota && 'windows' in quota);
      assert.equal(quota.status, 'unavailable'); assert.deepEqual(quota.windows, []);
    }
    assert.deepEqual(switched, ['codex', 'claude', 'antigravity']);
    assert.equal(nativeSwitches, 0);
    await agentConnectionsService.select('codex:claude', 'chat-id');
    assert.equal(switched.at(-1), 'claude', 'old account links resolve the actual configured engine');
    assert.equal(connectionService.apiForAgent('claude')?.id, 'claude');
  } finally {
    antigravityBridge.request = original.request; antigravityBridge.switchAccount = original.switchAccount;
    cliAccounts.list = original.list; sessionsService.switchSessionProvider = original.switchSession;
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
