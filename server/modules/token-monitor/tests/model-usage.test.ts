import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { antigravityBridge } from '@/modules/antigravity/index.js';
import { createTokenMonitorService } from '../token-monitor.service.js';

test('Codex request timing excludes post-response tool waits and aggregates per-model usage and tok/s', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'monitor-speed-codex-'));
  const file = path.join(directory, 'codex.jsonl');
  const usage1 = {
    input_tokens: 1000,
    cached_input_tokens: 800,
    output_tokens: 150,
    reasoning_output_tokens: 0,
    total_tokens: 1150,
  };
  const usage2 = {
    input_tokens: 1500,
    cached_input_tokens: 1000,
    output_tokens: 200,
    reasoning_output_tokens: 50,
    total_tokens: 1700,
  };
  await writeFile(
    file,
    [
      { timestamp: '2026-11-25T00:00:00.000Z', type: 'turn_context', payload: { model: 'gpt-6.1-sol' } },
      { timestamp: '2026-11-25T00:00:00.000Z', type: 'event_msg', payload: { type: 'task_started' } },
      { timestamp: '2026-11-25T00:00:05.000Z', type: 'response_item', payload: { id: 'call_1', type: 'custom_tool_call', name: 'bash', model: 'gpt-6.1-sol' } },
      // Model finished at +5.0s (150 output / 5s = 30 tok/s); tool then ran for 25s until +30.0s!
      { timestamp: '2026-11-25T00:00:05.000Z', type: 'token_usage_record', payload: { usage: usage1, model: 'gpt-6.1-sol' } },
      { timestamp: '2026-11-25T00:00:30.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output' } },
      { timestamp: '2026-11-25T00:00:30.010Z', type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: usage1, total_token_usage: usage1 } } },
      // Second turn switches to gpt-6.2-sol; starts after +30.010s and finishes at +34.010s (200 output / 4s = 50 tok/s)
      { timestamp: '2026-11-25T00:00:30.010Z', type: 'turn_context', payload: { model: 'gpt-6.2-sol' } },
      { timestamp: '2026-11-25T00:00:34.010Z', type: 'response_item', payload: { id: 'msg_2', type: 'message', role: 'assistant', model: 'gpt-6.2-sol', content: [{ type: 'output_text', text: 'Done' }] } },
      {
        timestamp: '2026-11-25T00:00:34.010Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            last_token_usage: usage2,
            total_token_usage: {
              input_tokens: 2500,
              cached_input_tokens: 1800,
              output_tokens: 350,
              reasoning_output_tokens: 50,
              total_tokens: 2850,
            },
          },
        },
      },
    ]
      .map(row => JSON.stringify(row))
      .join('\n'),
  );

  const sessions = [{ session_id: 'codex-1', provider: 'codex', model: 'gpt-6.1-sol', jsonl_path: file }];
  const service = createTokenMonitorService({
    getSession: id => sessions.find(s => s.session_id === id) || null,
    listSessions: () => sessions,
  });

  try {
    const snap = await service.snapshot('codex-1');
    assert.equal(snap.usage.length, 2);
    // Latest turn first (reversed): 200 output / 4000 ms = 50 tok/s
    assert.equal(snap.usage[0].durationMs, 4000);
    assert.equal(snap.usage[0].tokensPerSec, 50);
    assert.equal(snap.usage[0].model, 'gpt-6.2-sol');
    // First turn: 150 output / 5000 ms = 30 tok/s (25s tool wait excluded!)
    assert.equal(snap.usage[1].durationMs, 5000);
    assert.equal(snap.usage[1].tokensPerSec, 30);
    assert.equal(snap.usage[1].model, 'gpt-6.1-sol');

    // Session overall: (150 + 200) / 9s = 38.9 tok/s
    assert.equal(snap.timedOutputTokens, 350);
    assert.equal(snap.timedDurationMs, 9000);
    assert.equal(snap.speed, 38.9);
    assert.equal(snap.latestSpeed, 50);

    // Per-session model breakdown reconciles to exact session total (2850)
    assert.equal(snap.modelUsage.length, 2);
    assert.equal(snap.modelUsage[0].model, 'gpt-6.2-sol');
    assert.equal(snap.modelUsage[0].tokens.total, 1700);
    assert.equal(snap.modelUsage[0].speed, 50);
    assert.equal(snap.modelUsage[1].model, 'gpt-6.1-sol');
    assert.equal(snap.modelUsage[1].tokens.total, 1150);
    assert.equal(snap.modelUsage[1].speed, 30);

    // Per-reply annotation carries tok/s for msg_2
    const replyModels = await service.replyModels('codex-1');
    const msg2 = replyModels.models.find(r => r.messageIds.includes('msg_2'));
    assert.equal(msg2?.tokensPerSec, 50);

    // Global summary across sessions
    const all = await service.sessions();
    assert.equal(all.summary.tokens.total, 2850);
    assert.equal(all.summary.speed, 38.9);
    assert.equal(all.models.length, 2);
    assert.equal(all.models[0].model, 'gpt-6.2-sol');
    assert.equal(all.models[1].model, 'gpt-6.1-sol');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Claude split blocks extend duration monotonically while excluding inter-turn tool waits', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'monitor-speed-claude-'));
  const file = path.join(directory, 'claude.jsonl');
  await writeFile(
    file,
    [
      { timestamp: '2026-11-25T01:00:00.000Z', type: 'user', message: { content: 'Build module' } },
      // First block arrives at +1.0s, final split block arrives at +4.0s -> 120 output / 4s = 30 tok/s
      {
        uuid: 'c1',
        timestamp: '2026-11-25T01:00:01.000Z',
        type: 'assistant',
        message: {
          id: 'm1',
          model: 'claude-opus-5-5',
          usage: { input_tokens: 200, output_tokens: 120, cache_read_input_tokens: 500 },
          content: [{ type: 'thinking', thinking: 'secret' }],
        },
      },
      {
        uuid: 'c2',
        timestamp: '2026-11-25T01:00:04.000Z',
        type: 'assistant',
        message: {
          id: 'm1',
          model: 'claude-opus-5-5',
          usage: { input_tokens: 200, output_tokens: 120, cache_read_input_tokens: 500 },
          content: [{ type: 'text', text: 'Done' }],
        },
      },
      // Tool runs for 20s and submits tool_result at +24.0s; next reply finishes at +26.0s -> 80 / 2s = 40 tok/s
      {
        timestamp: '2026-11-25T01:00:24.000Z',
        type: 'user',
        message: { content: [{ type: 'tool_result', content: 'ok' }] },
      },
      {
        uuid: 'c3',
        timestamp: '2026-11-25T01:00:26.000Z',
        type: 'assistant',
        message: {
          id: 'm2',
          model: 'claude-opus-5-5',
          usage: { input_tokens: 300, output_tokens: 80, cache_read_input_tokens: 600 },
          content: [{ type: 'text', text: 'Verified' }],
        },
      },
    ]
      .map(row => JSON.stringify(row))
      .join('\n'),
  );

  const session = { session_id: 'claude-1', provider: 'claude', jsonl_path: file };
  const service = createTokenMonitorService({
    getSession: () => session,
    listSessions: () => [session],
  });

  try {
    const snap = await service.snapshot('claude-1');
    assert.equal(snap.usage.length, 2);
    assert.equal(snap.usage[0].durationMs, 2000);
    assert.equal(snap.usage[0].tokensPerSec, 40);
    assert.equal(snap.usage[1].durationMs, 4000);
    assert.equal(snap.usage[1].tokensPerSec, 30);
    // Combined: 200 output / 6s = 33.3 tok/s
    assert.equal(snap.speed, 33.3);
    assert.equal(snap.totals?.total, 1800);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('AGY parses per-turn timer speed while keeping native session totals non-additive', async t => {
  t.mock.method(antigravityBridge, 'request', async () =>
    Response.json({
      messages: [
        {
          id: 'a1',
          role: 'assistant',
          model: 'gemini-4-carbon-medium',
          content: 'first',
          routeInfo: { returned_models: ['gemini-4-carbon'] },
          metrics: '10,000 tokens (输入 8,000 / 输出 2,000 / 缓存 0) · ⏱️ 40.0s',
        },
        {
          id: 'a2',
          role: 'assistant',
          model: 'gemini-4-hydrogen-high',
          content: 'second',
          routeInfo: { returned_models: ['gemini-4-hydrogen'] },
          metrics: '20,000 tokens (输入 15,000 / 输出 5,000 / 思考 1,000 / 缓存 4,000) · ⏱️ 50.0s',
        },
      ],
    }),
  );

  const session = { session_id: 'agy-speed', provider: 'antigravity', model: 'gemini-4-carbon-medium' };
  const service = createTokenMonitorService({
    getSession: () => session,
    listSessions: () => [session],
  });

  const snap = await service.snapshot('agy-speed');
  // Native non-additive invariant: session total equals latest snapshot (20,000), never 30,000.
  assert.equal(snap.totals?.total, 20000);
  assert.equal(snap.usage[0].tokensPerSec, 100);
  assert.equal(snap.usage[1].tokensPerSec, 50);
  // Session weighted speed: (2000 + 5000) / 90s = 77.8 tok/s
  assert.equal(snap.speed, 77.8);
  assert.equal(snap.latestSpeed, 100);
  // Per-model usage sums to exact native total (20,000)
  const sumAttributed = snap.modelUsage.reduce((sum: number, item: { tokens: { total: number } }) => sum + item.tokens.total, 0);
  assert.equal(sumAttributed, 20000);

  const globalData = await service.sessions();
  assert.equal(globalData.summary.tokens.total, 20000);
  assert.equal(globalData.models.length, 2);
});
