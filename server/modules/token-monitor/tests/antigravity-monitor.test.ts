import assert from 'node:assert/strict';
import test from 'node:test';
import { antigravityBridge } from '@/modules/antigravity/index.js';
import { createTokenMonitorService } from '../token-monitor.service.js';

test('AGY history reads returned evidence and latest cumulative metrics without adding snapshots', async t => {
  t.mock.method(antigravityBridge, 'request', async () => Response.json({ messages: [
    { id: '1', role: 'assistant', model: 'requested-gemini', content: 'one', routeInfo: { returned_models: ['gemini-real'] }, metrics: '100 tokens (输入 80 / 输出 20 / 思考 5 / 缓存 50)' },
    { id: '2', role: 'assistant', model: 'requested-gemini', content: 'two', routeInfo: { returned_models: ['gemini-real-v2'], evidence: [{ secret: 'private' }] }, metrics: '120 tokens (输入 90 / 输出 30 / 思考 10 / 缓存 60)' },
  ] }));
  const session = { session_id: 'agy', provider: 'antigravity', model: 'selected', provider_session_id: 'native' };
  const service = createTokenMonitorService({ getSession: () => session, listSessions: () => [session] });
  const result = await service.snapshot('agy');
  assert.equal(result.returnedModel, 'gemini-real-v2');
  assert.equal(result.totals?.total, 120);
  assert.equal(result.replies.length, 2);
  assert.ok(!JSON.stringify(result).includes('private'));
  const list = await service.sessions();
  assert.deepEqual(list.sessions[0].reportedModels, ['gemini-real', 'gemini-real-v2']);
  assert.deepEqual(list.sessions[0].recordedModels, ['requested-gemini']);
});

test('AGY per-reply index includes older replies outside the 30-body display limit', async t => {
  t.mock.method(antigravityBridge, 'request', async () => Response.json({ messages: Array.from({length: 40}, (_, index) => ({
    id: 'agy-' + index, role: 'assistant', requestedModel: 'selected-' + index, content: 'private-body',
    routeInfo: { returned_models: index === 39 ? [] : ['returned-' + index] },
  })) }));
  const service = createTokenMonitorService({ getSession: () => ({ session_id: 'agy-full', provider: 'antigravity' }) });
  const result = await service.replyModels('agy-full');
  assert.equal(result.models.length, 40);
  assert.equal(result.models[0].requestedModel, 'selected-0');
  assert.equal(result.models[0].reportedModel, 'returned-0');
  assert.equal(result.models[39].reportedModel, null);
  assert.ok(!JSON.stringify(result).includes('private-body'));
});

test('AGY sums per-turn Claude->agy and ACP usage accurately, exposes safe channel/plugin tags, and recovers Conversation placeholder titles', async t => {
  t.mock.method(antigravityBridge, 'request', async () => Response.json({
    messages: [
      {
        id: 'turn-1',
        role: 'assistant',
        requestedModel: 'gemini-4-carbon-high',
        content: 'step one',
        routeInfo: {
          transport: 'claude_agy',
          returned_models: ['gemini-4-carbon'],
          armor: { enabled: true },
          transam: { enabled: true, tier: '4H' },
          agy_fast: { enabled: true },
          think_lang: { enabled: true, lang: 'zh-CN' },
          evidence: [{ secret: 'do-not-leak' }],
        },
        metrics: '30,000 tokens (输入 10,000 / 输出 2,000 / 缓存 18,000) · ⏱️ 40.0s',
      },
      {
        id: 'turn-2',
        role: 'assistant',
        requestedModel: 'gemini-4-neon-high',
        content: 'step two',
        routeInfo: {
          transport: 'acp',
          returned_models: ['gemini-4-neon'],
          armor: true,
        },
        metrics: '15,000 tokens (输入 4,000 / 输出 1,000 / 思考 400 / 缓存 10,000) · ⏱️ 10.0s',
      },
    ],
  }));

  const session = {
    session_id: 'agy-claude-session',
    provider: 'antigravity',
    provider_session_id: 'mintcli-claude-1',
    custom_name: 'Conversation',
    project_path: '/workspace/mintcli-core',
    model: 'gemini-4-carbon-high',
  };
  const service = createTokenMonitorService({
    getSession: () => session,
    listSessions: () => [session],
  });

  const snap = await service.snapshot('agy-claude-session');
  assert.equal((snap as { totalsScope?: string }).totalsScope, 'session');
  assert.equal(snap.totals?.total, 45000);
  assert.equal(snap.totals?.output, 3000);
  assert.equal(snap.speed, 60);
  assert.ok(!JSON.stringify(snap).includes('do-not-leak'));

  const replies = await service.replyModels('agy-claude-session');
  assert.equal(replies.models[0].transport, 'claude_agy');
  assert.deepEqual(replies.models[0].plugins, ['Armor', 'TRANS-AM 4H', 'agy-fast', '思考跟随']);
  assert.equal(replies.models[1].transport, 'acp');
  assert.deepEqual(replies.models[1].plugins, ['Armor']);

  const list = await service.sessions();
  assert.equal(list.sessions[0].title, 'mintcli-core');
  assert.equal(list.summary.tokens.total, 45000);
  const sumModels = list.models.reduce((acc: number, row: { tokens: { total: number } }) => acc + row.tokens.total, 0);
  assert.equal(sumModels, 45000);
});
