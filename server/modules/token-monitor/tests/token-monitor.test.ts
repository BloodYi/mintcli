import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm, mkdir, appendFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createTokenMonitorService } from '../token-monitor.service.js';

async function fixture(provider: string, rows: unknown[]) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'token-monitor-'));
  const file = path.join(directory, 'session.jsonl');
  await writeFile(file, rows.map(row => JSON.stringify(row)).join('\n'));
  const session = { provider, model: 'requested-model', jsonl_path: file };
  const service = createTokenMonitorService({ getSession: () => session as any });
  return { service, dispose: () => rm(directory, { recursive: true, force: true }) };
}

test('Codex returned identity is never inferred from turn_context and cached/reasoning tokens are not double-counted', async () => {
  const { service, dispose } = await fixture('codex', [
    { type: 'turn_context', payload: { model: 'requested-model' } },
    { type: 'response_item', payload: { role: 'assistant', content: [{ type: 'output_text', text: 'Actual reply' }] } },
    { type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 100, cached_input_tokens: 60, output_tokens: 20, reasoning_output_tokens: 12 }, total_token_usage: { input_tokens: 100, cached_input_tokens: 60, output_tokens: 20, reasoning_output_tokens: 12 } } } },
  ]);
  try {
    const result = await service.snapshot('a');
    assert.equal(result.returnedModel, null);
    assert.equal(result.configuredModel, 'requested-model');
    assert.deepEqual(result.totals, { input: 40, output: 20, cacheRead: 60, cacheWrite: 0, reasoning: 12, total: 120 });
    assert.equal(result.usage[0].tokens?.total, 120);
    assert.equal(result.replies[0].content, 'Actual reply');
  } finally { await dispose(); }
});

test('Claude replay and split blocks count usage once while preserving returned model and text', async () => {
  const row = { uuid: 'one', type: 'assistant', message: { id: 'reply1', model: 'actual-model', usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 30 }, content: [{ type: 'text', text: 'Hello' }, { type: 'thinking', thinking: 'private' }, { type: 'tool_use', input: { key: 'private' } }] } };
  const { service, dispose } = await fixture('claude', [row, row, { ...row, uuid: 'two', message: { ...row.message, content: [{ type: 'text', text: 'World' }] } }]);
  try {
    const result = await service.snapshot('a');
    assert.equal(result.returnedModel, 'actual-model');
    assert.equal(result.totals?.total, 45);
    assert.equal(result.replies.length, 1);
    assert.equal(result.replies[0].content, 'Hello\nWorld');
    assert.ok(!JSON.stringify(result).includes('private'));
  } finally { await dispose(); }
});

test('a latest unreported model is not replaced by an older reported model and API failures produce an update reminder', async () => {
  const { service, dispose } = await fixture('codex', [
    { type: 'response_item', payload: { role: 'assistant', model: 'old-model', content: [{ type: 'output_text', text: 'old' }] } },
    { type: 'response_item', payload: { role: 'assistant', content: [{ type: 'output_text', text: 'latest' }] } },
    { type: 'monitor_error', payload: { message: 'HTTP 401' } },
  ]);
  try { const result = await service.snapshot('a'); assert.equal(result.returnedModel, null); assert.ok(result.alerts.length); }
  finally { await dispose(); }
});

test('unknown sessions reject without reading caller supplied paths', async () => {
  const service = createTokenMonitorService({ getSession: () => null });
  await assert.rejects(service.snapshot('../../etc/passwd'), { code: 'SESSION_NOT_FOUND' });
});

test('upstream release checks coalesce and compare semantic versions instead of strings', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json({ tag_name: 'v1.0.0', html_url: 'https://untrusted.invalid' }); });
  const service = createTokenMonitorService();
  const [a, b] = await Promise.all([service.updates(), service.updates()]);
  assert.equal(a.updateAvailable, true);
  assert.equal(b.latestVersion, '1.0.0');
  assert.equal(calls, 1);
  assert.equal(a.url, 'https://github.com/Javis603/token-monitor/releases/latest');
});

test('history includes archived conversations and distinguishes requested from response models', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'monitor-history-'));
  const file = path.join(directory, 'old.jsonl');
  await writeFile(file, [
    { type: 'turn_context', payload: { model: 'historically-requested' } },
    { type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 10, output_tokens: 2 }, total_token_usage: { input_tokens: 10, output_tokens: 2 } } } },
    { type: 'response_item', payload: { role: 'assistant', model: 'reported-v1' } },
  ].map(row => JSON.stringify(row)).join('\n'));
  const sessions = [{ session_id: 'old', provider: 'codex', model: 'now-selected', isArchived: 1, jsonl_path: file },
    { session_id: 'missing', provider: 'codex', jsonl_path: file + '.missing' }];
  const service = createTokenMonitorService({ getSession: id => sessions.find(s => s.session_id === id) || null, listSessions: () => sessions });
  try {
    const result = await service.sessions();
    assert.equal(result.sessions.length, 2);
    assert.equal(result.sessions[0].archived, true);
    assert.deepEqual(result.sessions[0].recordedModels, ['historically-requested']);
    assert.deepEqual(result.sessions[0].reportedModels, ['reported-v1']);
    assert.equal(result.sessions[0].totals.total, 12);
    assert.equal(result.sessions[1].status, 'unavailable');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('full history totals survive a transcript tail containing no usage, with Claude response deduplication', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'monitor-full-'));
  const file = path.join(directory, 'full.jsonl');
  const row = { type: 'assistant', uuid: 'u1', message: { id: 'm1', model: 'claude-real', usage: { input_tokens: 10, output_tokens: 5 }, content: [] } };
  await writeFile(file, [row, row, { type: 'assistant', uuid: 'u2', message: { ...row.message, content: [{ type: 'text', text: 'split' }] } },
    { type: 'tool_payload', content: 'x'.repeat(4 * 1024 * 1024) },
    { type: 'assistant', uuid: 'u3', message: { id: 'm2', content: [{ type: 'text', text: 'latest' }] } },
  ].map(row => JSON.stringify(row)).join('\n'));
  const service = createTokenMonitorService({ getSession: () => ({ provider: 'claude', jsonl_path: file }) });
  try {
    const result = await service.snapshot('full');
    assert.equal(result.limited, true);
    assert.equal(result.totals?.total, 15);
    assert.equal('totalsScope' in result && result.totalsScope, 'session');
    assert.equal(result.returnedModel, null);
    assert.deepEqual('reportedModels' in result && result.reportedModels, ['claude-real']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('per-reply models cover full history, retain turn requests and never borrow a later model', async () => {
  const rows: unknown[] = [{ type: 'turn_context', payload: { model: 'first-request' } }];
  for (let index = 0; index < 45; index++) {
    if (index === 30) rows.push({ type: 'turn_context', payload: { model: 'second-request' } });
    rows.push({ type: 'response_item', timestamp: new Date(1700000000000 + index * 1000).toISOString(), payload: {
      id: 'reply-' + index, role: 'assistant', ...(index < 44 ? { model: 'actual-' + index } : {}),
      content: [{ type: 'output_text', text: 'private-reply-body' }],
    } });
  }
  const { service, dispose } = await fixture('codex', rows);
  try {
    const result = await service.replyModels('full-model-index');
    assert.equal(result.models.length, 45);
    assert.equal(result.models[0].requestedModel, 'first-request');
    assert.equal(result.models[0].reportedModel, 'actual-0');
    assert.ok(result.models[0].messageIds.includes('reply-0'));
    assert.equal(result.models[44].requestedModel, 'second-request');
    assert.equal(result.models[44].reportedModel, null);
    assert.ok(!JSON.stringify(result).includes('private-reply-body'));
    assert.equal((await service.snapshot('full-model-index')).replies.length, 30);
  } finally { await dispose(); }
});

test('Claude model index retains block aliases while excluding private content and synthetic names', async () => {
  const { service, dispose } = await fixture('claude', [
    { type: 'assistant', uuid: 'row', timestamp: '2026-01-01T00:00:00Z', message: { id: 'native-message', model: 'claude-reported', content: [{ type: 'thinking', thinking: 'secret-thought' }, { type: 'text', text: 'secret-body' }] } },
    { type: 'assistant', uuid: 'synthetic-row', message: { model: '<synthetic>', content: [{ type: 'text', text: 'notice' }] } },
  ]);
  try {
    const result = await service.replyModels('claude-model-index');
    assert.ok(result.models[0].messageIds.includes('row_1'));
    assert.equal(result.models[0].reportedModel, 'claude-reported');
    assert.equal(result.models[1].reportedModel, null);
    assert.ok(!JSON.stringify(result).includes('secret-'));
  } finally { await dispose(); }
});

test('live captured ids gain model labels before transcript replies flush, including same-ms captures', async () => {
  const id = randomUUID();
  const { service, dispose } = await fixture('codex', [{type:'turn_context',timestamp:'2026-01-01T00:00:00Z',payload:{model:'live-request'}}]);
  const file = path.join(os.homedir(), '.claude-code-ui/token-monitor', id + '.jsonl');
  await mkdir(path.dirname(file), {recursive:true});
  const capture = (item: string) => JSON.stringify({kind:'response',turnId:'turn',timestamp:'2026-01-01T00:00:01Z',model:'live-returned',itemIds:[item]}) + '\n';
  try {
    await writeFile(file, capture('live-one'));
    const first = await service.replyModels(id);
    assert.equal(first.models[0].reportedModel, 'live-returned');
    assert.equal(first.models[0].requestedModel, 'live-request');
    await appendFile(file, capture('live-two'));
    const next = await service.replyModels(id);
    assert.ok(next.models.some(record => record.messageIds.includes('live-two')));
    const claude = await fixture('claude', [{type:'assistant',uuid:'claude-row',timestamp:'2026-01-01T00:00:02Z',message:{content:[{type:'text',text:'new engine reply'}]}}]);
    try {
      assert.equal((await claude.service.replyModels(id)).models[0].reportedModel, null);
      const summary = await claude.service.snapshot(id);
      assert.ok('reportedModels' in summary);
      assert.ok(summary.reportedModels?.includes('live-returned'));
    } finally { await claude.dispose(); }

  } finally { await dispose(); await rm(file, {force:true}); }
});
