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
