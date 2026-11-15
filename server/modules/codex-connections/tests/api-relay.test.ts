import assert from 'node:assert/strict';
import test from 'node:test';
import { startApiRelay } from '../api-relay.service.js';
import type { AnyRecord } from '@/shared/types.js';

const stream = (tool = false) => new Response([
  { choices: [{ delta: tool ? { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'run', arguments: '{"command":' } }] } : { content: 'tool ' } }] },
  { choices: [{ delta: tool ? { tool_calls: [{ index: 0, function: { arguments: '"printf marker"}' } }] } : { content: 'finished' }, finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 4 } },
].map(row => 'data: ' + JSON.stringify(row) + '\n\n').join('') + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });

for (const agent of ['codex', 'claude', 'antigravity'] as const) {
  test(`${agent} converts streaming tool calls and a subsequent tool result through Chat Completions`, async () => {
    const original = globalThis.fetch;
    const calls: AnyRecord[] = [];
    globalThis.fetch = (async (input, init) => {
      if (String(input).startsWith('http://127.0.0.1')) return original(input, init);
      assert.equal(String(input), 'https://1.1.1.1/v1/chat/completions');
      assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer upstream-private-key');
      assert.equal(init?.redirect, 'error');
      const body = JSON.parse(String(init?.body)); calls.push(body);
      assert.equal(body.model, 'model-for-test');
      assert.equal(body.tools[0].function.name, 'run');
      assert.equal(body.tools[0].function.parameters.type, 'object');
      if (calls.length === 1) return stream(true);
      const result = body.messages.find((row: AnyRecord) => row.role === 'tool');
      assert.equal(result.tool_call_id, 'call_1');
      assert.ok(result.content.includes('marker'));
      return stream();
    }) as typeof fetch;
    const relay = await startApiRelay(agent, { id: 'test', baseUrl: 'https://1.1.1.1/v1', apiKey: 'upstream-private-key', model: 'model-for-test', env: {} });
    try {
      const parameters = { type: 'object', properties: { command: { type: 'string' } } };
      const request = agent === 'codex' ? { stream: true, input: [{ role: 'user', content: 'run marker' }], tools: [{ type: 'function', name: 'run', parameters }] }
        : agent === 'claude' ? { stream: true, max_tokens: 1000, messages: [{ role: 'user', content: 'run marker' }], tools: [{ name: 'run', input_schema: parameters }] }
          : { contents: [{ role: 'user', parts: [{ text: 'run marker' }] }], tools: [{ functionDeclarations: [{ name: 'run', parameters: { ...parameters, type: 'OBJECT' } }] }] };
      const endpoint = agent === 'codex' ? '/v1/responses' : agent === 'claude' ? '/v1/messages' : '/v1beta/models/model-for-test:streamGenerateContent?alt=sse';
      const send = (body: unknown) => original(relay.baseUrl + endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + relay.apiKey, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      assert.equal((await original(relay.baseUrl + endpoint, { method: 'POST' })).status, 401);
      const first = await send(request);
      assert.equal(first.status, 200);
      const received = await first.text();
      assert.ok(received.includes('call_1'));
      assert.ok(!received.includes('upstream-private-key'));
      assert.ok(!received.includes(relay.apiKey));
      const next = agent === 'codex' ? { ...request, input: [...request.input!, { type: 'function_call', call_id: 'call_1', name: 'run', arguments: '{"command":"printf marker"}' }, { type: 'function_call_output', call_id: 'call_1', output: 'marker' }] }
        : agent === 'claude' ? { ...request, messages: [...request.messages!, { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'run', input: { command: 'printf marker' } }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'marker' }] }] }
          : { ...request, contents: [...request.contents!, { role: 'model', parts: [{ functionCall: { id: 'call_1', name: 'run', args: { command: 'printf marker' } } }] }, { role: 'model', parts: [{ functionResponse: { id: 'call_1', name: 'run', response: { output: 'marker' } } }] }] };
      const second = await send(next);
      const done = await second.text();
      assert.ok(done.includes('finished'));
      assert.ok(done.includes(agent === 'codex' ? 'response.completed' : agent === 'claude' ? 'message_stop' : 'finishReason'));
      assert.equal(calls.length, 2);
    } finally { await relay.close(); globalThis.fetch = original; }
  });
}

test('Responses custom tools and images translate without losing the freeform input', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    if (String(input).startsWith('http://127.0.0.1')) return original(input, init);
    const body = JSON.parse(String(init?.body));
    assert.equal(body.messages[0].content[0].type, 'image_url');
    assert.equal(body.tools[0].function.parameters.properties.input.type, 'string');
    return Response.json({ choices: [{ message: { tool_calls: [{ id: 'patch', function: { name: 'apply_patch', arguments: JSON.stringify({ input: '*** Begin Patch\n*** End Patch' }) } }] }, finish_reason: 'tool_calls' }] });
  }) as typeof fetch;
  const relay = await startApiRelay('codex', { id: 'test', baseUrl: 'https://1.1.1.1/v1', apiKey: 'private-key', model: 'test-model', env: {} });
  try {
    const response = await original(relay.baseUrl + '/v1/responses', { method: 'POST', headers: { Authorization: 'Bearer ' + relay.apiKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,AA==' }] }], tools: [{ type: 'custom', name: 'apply_patch' }] }) });
    const body = await response.json() as AnyRecord;
    assert.equal(body.output[0].type, 'custom_tool_call');
    assert.equal(body.output[0].input, '*** Begin Patch\n*** End Patch');
  } finally { await relay.close(); globalThis.fetch = original; }
});

test('upstream errors, invalid tools and unfinished streams do not become successful agent replies', async () => {
  const original = globalThis.fetch;
  let upstream = () => new Response('private-key', { status: 401 });
  globalThis.fetch = (async (input, init) => String(input).startsWith('http://127.0.0.1') ? original(input, init) : upstream()) as typeof fetch;
  const relay = await startApiRelay('claude', { id: 'test', baseUrl: 'https://1.1.1.1/v1', apiKey: 'private-key', model: 'test-model', env: {} });
  const send = () => original(relay.baseUrl + '/v1/messages', { method: 'POST', headers: { 'x-api-key': relay.apiKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ stream: true, messages: [{ role: 'user', content: 'hi' }] }) });
  try {
    const denied = await send();
    assert.equal(denied.status, 502);
    const error = await denied.text();
    assert.ok(error.includes('HTTP 401') && !error.includes('private-key'));
    upstream = () => new Response('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
    const broken = await (await send()).text();
    assert.ok(broken.includes('error') && !broken.includes('message_stop'));
    upstream = () => Response.json({ choices: [{ message: { tool_calls: [{ function: { name: 'run', arguments: 'not JSON' } }] }, finish_reason: 'tool_calls' }] });
    const invalid = await (await send()).text();
    assert.ok(invalid.includes('工具参数') && !invalid.includes('message_stop'));
  } finally { await relay.close(); globalThis.fetch = original; }
});
