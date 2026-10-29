import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
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
