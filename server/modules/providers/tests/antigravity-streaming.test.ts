import assert from 'node:assert/strict';
import test from 'node:test';

import { antigravityBridge } from '@/modules/antigravity/index.js';
import { connectionService } from '@/modules/codex-connections/index.js';
import { sessionsDb } from '@/modules/database/index.js';
import {
  AntigravityProvider,
  applyAgyStreamEvent,
  normalizeAgy,
} from '@/modules/providers/list/antigravity/antigravity.provider.js';
import type { AnyRecord, NormalizedMessage } from '@/shared/types.js';

function sseStream(events: AnyRecord[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      }
      controller.close();
    },
  });
}

test('applyAgyStreamEvent and normalizeAgy interleave thinking, tools, tool results, and text in order', () => {
  const state = { stepSeq: 0 };
  let message: AnyRecord = { id: 'msg-1', role: 'assistant', content: '', status: 'streaming', steps: [] };

  message = applyAgyStreamEvent(message, { event: 'thinking', thinking: 'Let me inspect the repo', step_id: 'msg-1:thinking:1' }, state);
  let rows = normalizeAgy(message, 'app-1', { streaming: true });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'thinking');
  assert.equal(rows[0].id, 'msg-1:thinking:1');
  assert.equal(rows[0].isStreaming, true);

  message = applyAgyStreamEvent(message, {
    event: 'tool',
    step_id: 'msg-1:tool:tool-1',
    tool_id: 'tool-1',
    tool_name: 'Read',
    tool: 'Read: /src/app.ts',
    tool_input: { file_path: '/src/app.ts' },
    status: 'running',
  }, state);
  rows = normalizeAgy(message, 'app-1', { streaming: true });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].isStreaming, undefined);
  assert.equal(rows[1].kind, 'tool_use');
  assert.equal(rows[1].toolId, 'tool-1');
  assert.equal(rows[1].toolName, 'Read');
  assert.equal(rows[1].status, 'in_progress');
  assert.deepEqual(rows[1].toolInput, { file_path: '/src/app.ts' });

  // Partial update with generic tool name must keep the original specific toolName
  message = applyAgyStreamEvent(message, {
    event: 'tool',
    tool_id: 'tool-1',
    tool: 'tool',
    tool_name: 'tool',
    status: 'completed',
    tool_output: 'const x = 1;',
  }, state);
  rows = normalizeAgy(message, 'app-1', { streaming: true });
  assert.equal(rows[1].toolName, 'Read');
  assert.equal(rows[1].status, 'completed');
  assert.deepEqual(rows[1].toolResult, { content: 'const x = 1;', isError: false });

  message = applyAgyStreamEvent(message, { event: 'delta', delta: 'Done checking.', step_id: 'msg-1:text:2' }, state);
  rows = normalizeAgy(message, 'app-1', { streaming: true });
  assert.equal(rows.length, 3);
  assert.equal(rows[2].kind, 'text');
  assert.equal(rows[2].role, 'assistant');
  assert.equal(rows[2].content, 'Done checking.');
  assert.equal(rows[2].isStreaming, true);

  message = applyAgyStreamEvent(message, { event: 'done', status: 'complete' }, state);
  rows = normalizeAgy(message, 'app-1', { streaming: false });
  assert.equal(rows[2].isStreaming, undefined);
});

test('applyAgyStreamEvent segment_reset clears trailing text after the last tool while preserving prior steps', () => {
  const state = { stepSeq: 0 };
  let message: AnyRecord = { id: 'msg-sr', role: 'assistant', content: '', status: 'streaming', steps: [] };
  message = applyAgyStreamEvent(message, { event: 'delta', delta: 'Kept intro.', step_id: 'msg-sr:text:1' }, state);
  message = applyAgyStreamEvent(message, { event: 'tool', step_id: 'msg-sr:tool:1', tool_id: 't1', tool_name: 'Read', status: 'completed' }, state);
  message = applyAgyStreamEvent(message, { event: 'delta', delta: 'Discarded fragment', step_id: 'msg-sr:text:2' }, state);
  assert.equal(normalizeAgy(message, 'app-1', { streaming: true }).length, 3);

  message = applyAgyStreamEvent(message, { event: 'segment_reset' }, state);
  const rows = normalizeAgy(message, 'app-1', { streaming: true });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].content, 'Kept intro.');
  assert.equal(rows[1].kind, 'tool_use');
  assert.equal(message.content, 'Kept intro.');
});

test('AntigravityProvider.runtime.run streams thinking, tools, and text inline without status-bar tool events or redundant resends', async () => {
  const provider = new AntigravityProvider();
  const originalApiForAgent = connectionService.apiForAgent;
  const originalStartChat = antigravityBridge.startChatForAccount;
  const originalGetSession = sessionsDb.getSessionById;
  const originalCreateSession = sessionsDb.createSession;

  const sent: NormalizedMessage[] = [];
  const events: AnyRecord[] = [
    {
      cursor: 1,
      event: 'snapshot',
      conversation_id: 'conv-live-1',
      message: { id: 'asst-1', role: 'assistant', content: '', status: 'streaming', requestedModel: 'gemini-4-neon-high', steps: [] },
    },
    { cursor: 2, event: 'thinking', thinking: 'Checking ', step_id: 'asst-1:thinking:1' },
    { cursor: 3, event: 'thinking', thinking: 'files...', step_id: 'asst-1:thinking:1' },
    {
      cursor: 4,
      event: 'tool',
      step_id: 'asst-1:tool:call-1',
      tool_id: 'call-1',
      tool_name: 'Bash',
      tool: 'Bash: ls -la',
      tool_input: { command: 'ls -la', description: 'List files' },
      status: 'running',
    },
    {
      cursor: 5,
      event: 'tool_result',
      step_id: 'asst-1:tool:call-1',
      tool_id: 'call-1',
      content: 'README.md\nsrc/',
      is_error: false,
    },
    { cursor: 6, event: 'delta', delta: 'Found ', step_id: 'asst-1:text:2' },
    { cursor: 7, event: 'delta', delta: 'the files.', step_id: 'asst-1:text:2' },
    { cursor: 8, event: 'done', status: 'complete' },
  ];

  connectionService.apiForAgent = () => null;
  antigravityBridge.startChatForAccount = async () =>
    new Response(sseStream(events), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  sessionsDb.getSessionById = () => null;
  sessionsDb.createSession = (() => 'app-session-1') as typeof sessionsDb.createSession;

  try {
    await provider.runtime.run(
      'check files',
      { sessionId: 'app-session-1', model: 'gemini-4-neon-high', useClaudeAgy: true, cwd: '/tmp' },
      { send: (msg) => sent.push(msg as NormalizedMessage), setSessionId: () => undefined },
      {
        resolveProviderSessionId: () => null,
        resolveResumeModel: async () => undefined,
        getProviderModels: async () => ({ OPTIONS: [], DEFAULT: '' }),
        normalizeMessage: () => [],
        isProviderInstalled: async () => true,
      },
    );

    // No composer status-bar hijacking for tools
    assert.equal(sent.filter((m) => m.kind === 'status').length, 0);

    // Thinking streamed live, then settled when tool started (not re-emitted on later deltas)
    const thinkingRows = sent.filter((m) => m.kind === 'thinking');
    assert.equal(thinkingRows.length, 3);
    assert.equal(thinkingRows[0].content, 'Checking ');
    assert.equal(thinkingRows[0].isStreaming, true);
    assert.equal(thinkingRows[1].content, 'Checking files...');
    assert.equal(thinkingRows[1].isStreaming, true);
    assert.equal(thinkingRows[2].content, 'Checking files...');
    assert.equal(thinkingRows[2].isStreaming, undefined);

    // Tool call emitted once as in_progress, then updated once as completed with output
    const toolRows = sent.filter((m) => m.kind === 'tool_use');
    assert.equal(toolRows.length, 2);
    assert.equal(toolRows[0].id, 'asst-1:tool:call-1');
    assert.equal(toolRows[0].toolName, 'Bash');
    assert.equal(toolRows[0].status, 'in_progress');
    assert.equal(toolRows[1].id, 'asst-1:tool:call-1');
    assert.equal(toolRows[1].status, 'completed');
    assert.deepEqual(toolRows[1].toolResult, { content: 'README.md\nsrc/', isError: false });

    // Assistant text streamed incrementally, then finalized on done
    const textRows = sent.filter((m) => m.kind === 'text');
    assert.equal(textRows.length, 3);
    assert.equal(textRows[0].content, 'Found ');
    assert.equal(textRows[0].isStreaming, true);
    assert.equal(textRows[1].content, 'Found the files.');
    assert.equal(textRows[1].isStreaming, true);
    assert.equal(textRows[2].content, 'Found the files.');
    assert.equal(textRows[2].isStreaming, undefined);

    // Complete emitted at the end
    assert.equal(sent.at(-1)?.kind, 'complete');
  } finally {
    connectionService.apiForAgent = originalApiForAgent;
    antigravityBridge.startChatForAccount = originalStartChat;
    sessionsDb.getSessionById = originalGetSession;
    sessionsDb.createSession = originalCreateSession;
  }
});

test('AntigravityProvider.runtime.injectMessage injects mid-turn and transitions into new thinking without completing early', async () => {
  const provider = new AntigravityProvider();
  const originalApiForAgent = connectionService.apiForAgent;
  const originalStartChat = antigravityBridge.startChatForAccount;
  const originalRequest = antigravityBridge.request;
  const originalGetSession = sessionsDb.getSessionById;
  const originalCreateSession = sessionsDb.createSession;

  const sent: NormalizedMessage[] = [];
  const encoder = new TextEncoder();
  let streamController!: ReadableStreamDefaultController<Uint8Array>;
  const pushEvent = (event: AnyRecord) => {
    streamController.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
  };
  const liveStream = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
    },
  });

  const injectedRequests: Array<{ target: string; body: AnyRecord }> = [];
  connectionService.apiForAgent = () => null;
  antigravityBridge.startChatForAccount = async () =>
    new Response(liveStream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  antigravityBridge.request = async (method, target, body) => {
    if (method === 'POST' && target.endsWith('/messages')) {
      injectedRequests.push({ target, body: body as AnyRecord });
      return Response.json({ ok: true, message_id: (body as AnyRecord).message_id });
    }
    return Response.json({ messages: [], revision: null });
  };
  sessionsDb.getSessionById = () => null;
  sessionsDb.createSession = (() => 'app-session-inject') as typeof sessionsDb.createSession;

  try {
    const runPromise = provider.runtime.run(
      'first prompt',
      { sessionId: 'app-session-inject', model: 'gemini-4-neon-xhigh', useClaudeAgy: true, cwd: '/tmp' },
      { send: (msg) => sent.push(msg as NormalizedMessage), setSessionId: () => undefined },
      {
        resolveProviderSessionId: () => null,
        resolveResumeModel: async () => undefined,
        getProviderModels: async () => ({ OPTIONS: [], DEFAULT: '' }),
        normalizeMessage: () => [],
        isProviderInstalled: async () => true,
      },
    );

    pushEvent({
      cursor: 1,
      event: 'snapshot',
      conversation_id: 'conv-live-inject',
      message: { id: 'asst-1', role: 'assistant', content: '', status: 'streaming', requestedModel: 'gemini-4-neon-xhigh', steps: [] },
    });
    pushEvent({ cursor: 2, event: 'thinking', thinking: 'Initial thinking...', step_id: 'asst-1:thinking:1' });
    pushEvent({
      cursor: 3,
      event: 'tool',
      step_id: 'asst-1:tool:call-1',
      tool_id: 'call-1',
      tool_name: 'Read',
      tool: 'Read: app.py',
      tool_input: { file_path: 'app.py' },
      status: 'running',
    });

    const accepted = await provider.runtime.injectMessage!('app-session-inject', 'also check tests', {});
    assert.equal(accepted, true);
    assert.equal(injectedRequests.length, 1);
    assert.equal(injectedRequests[0].body.content, 'also check tests');

    // Bridge announces segment switch, then tool from asst-1 completes, then new thinking streams on asst-2.
    pushEvent({
      cursor: 4,
      event: 'user_message_applied',
      user_message_id: injectedRequests[0].body.message_id,
      previous_assistant_id: 'asst-1',
      assistant: { id: 'asst-2', role: 'assistant', content: '', status: 'streaming', requestedModel: 'gemini-4-neon-xhigh', steps: [] },
    });
    pushEvent({
      cursor: 5,
      event: 'tool_result',
      assistant_id: 'asst-1',
      step_id: 'asst-1:tool:call-1',
      tool_id: 'call-1',
      content: 'ok',
      is_error: false,
    });
    pushEvent({ cursor: 6, event: 'thinking', thinking: 'New thinking after follow-up...', step_id: 'asst-2:thinking:1' });
    pushEvent({ cursor: 7, event: 'delta', delta: 'Checked tests too.', step_id: 'asst-2:text:2' });
    pushEvent({ cursor: 8, event: 'done', status: 'complete' });
    streamController.close();

    await runPromise;

    assert.equal(sent.filter((m) => m.kind === 'complete').length, 1);
    const thinkingIds = [...new Set(sent.filter((m) => m.kind === 'thinking').map((m) => m.id))];
    assert.deepEqual(thinkingIds, ['asst-1:thinking:1', 'asst-2:thinking:1']);
    const completedTool = sent.filter((m) => m.kind === 'tool_use' && m.toolId === 'call-1').at(-1);
    assert.equal(completedTool?.status, 'completed');
    assert.deepEqual(completedTool?.toolResult, { content: 'ok', isError: false });
    const finalText = sent.filter((m) => m.kind === 'text').at(-1);
    assert.equal(finalText?.id, 'asst-2:text:2');
    assert.equal(finalText?.content, 'Checked tests too.');
  } finally {
    connectionService.apiForAgent = originalApiForAgent;
    antigravityBridge.startChatForAccount = originalStartChat;
    antigravityBridge.request = originalRequest;
    sessionsDb.getSessionById = originalGetSession;
    sessionsDb.createSession = originalCreateSession;
  }
});
