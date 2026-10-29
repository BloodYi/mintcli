import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('Chat Completions persists native history, carries follow-up context, and masks provider failures', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudcli-api-chat-'));
  process.env.DATABASE_PATH = path.join(root, 'auth.db');
  const { initializeDatabase, sessionsDb, closeConnection } = await import('@/modules/database/index.js');
  const { runCompatibleChat, readCompatibleHistory } = await import('../compatible-chat.service.js');
  await initializeDatabase();
  const file = path.join(root, 'thread.jsonl');
  fs.writeFileSync(file, JSON.stringify({ type: 'session_meta', payload: { id: 'test-native', cwd: root } }) + '\n');
  sessionsDb.createSession('test-native', 'codex', root, 'API test', undefined, undefined, file);
  const selected = { id: 'test-api', kind: 'api' as const, name: 'API', home: root, apiKey: 'unit-test-key', baseUrl: 'https://example.com/v1', protocol: 'chat_completions' as const, model: 'test-model', env: {} };
  // Use a public literal address so validation is deterministic and no DNS request is needed.
  selected.baseUrl = 'https://1.1.1.1/v1';
  const bodies: { messages: { content: string }[] }[] = [];
  let mode = 'success';
  t.mock.method(globalThis, 'fetch', async (_input: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    if (mode === 'legacy' && JSON.parse(String(init?.body)).stream_options) return Response.json({ error: 'unknown stream_options field' }, { status: 400 });
    if (mode === 'error') return new Response('private-provider-body unit-test-key', { status: 401 });
    if (mode === 'truncated') return new Response('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n', { headers: { 'content-type': 'text/event-stream' } });
    return new Response('data: {"id":"response-1","model":"returned-real-model","choices":[{"delta":{"content":"HELLO"}}]}\n\ndata: {"choices":[{"delta":{"content":" WORLD"},"finish_reason":"stop"}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":20,"prompt_tokens_details":{"cached_tokens":60},"completion_tokens_details":{"reasoning_tokens":12}}}\n\ndata: [DONE]', { headers: { 'content-type': 'text/event-stream' } });
  });
  const frames: unknown[] = [];
  const writer = { isWebSocketWriter: true, send: (value: unknown) => frames.push(value) };
  try {
    await runCompatibleChat('first question', { sessionId: 'test-native' }, writer, selected);
    assert.deepEqual(readCompatibleHistory(file).map(item => item.content), ['first question', 'HELLO WORLD']);
    assert.ok(frames.some((item: any) => item.kind === 'complete' && item.exitCode === 0));
    await runCompatibleChat('follow-up question', { sessionId: 'test-native' }, writer, selected);
    assert.deepEqual(bodies[1].messages.map(item => item.content), ['first question', 'HELLO WORLD', 'follow-up question']);
    const records = fs.readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const replies = records.filter(row => row.type === 'response_item' && row.payload.role === 'assistant');
    assert.equal(replies.at(-1).payload.model, 'returned-real-model');
    const lastUsage = records.filter(row => row.payload?.type === 'token_count').at(-1).payload.info;
    assert.equal(lastUsage.last_token_usage.input_tokens, 100);
    assert.equal(lastUsage.total_token_usage.total_tokens, 240);
    assert.equal(lastUsage.total_token_usage.cached_input_tokens, 120);
    mode = 'error'; frames.length = 0;
    await runCompatibleChat('unauthorized', { sessionId: 'test-native' }, writer, selected);
    assert.ok(frames.some((item: any) => item.kind === 'error' && item.content.includes('401')));
    assert.ok(!JSON.stringify(frames).includes('unit-test-key'));
    assert.ok(!JSON.stringify(frames).includes('private-provider-body'));
    mode = 'truncated'; frames.length = 0;
    await runCompatibleChat('interrupted', { sessionId: 'test-native' }, writer, selected);
    assert.ok(frames.some((item: any) => item.kind === 'complete' && item.exitCode === 1));
    assert.equal(readCompatibleHistory(file).at(-1)?.content, 'partial');
    mode = 'legacy'; frames.length = 0;
    await runCompatibleChat('legacy usage option', { sessionId: 'test-native' }, writer, selected);
    assert.ok(JSON.parse(JSON.stringify(bodies.at(-2))).stream_options);
    assert.equal(JSON.parse(JSON.stringify(bodies.at(-1))).stream_options, undefined);
    assert.ok(frames.some((item: any) => item.kind === 'complete' && item.exitCode === 0));
  } finally {
    closeConnection(); fs.rmSync(root, { recursive: true, force: true });
  }
});
