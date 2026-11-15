import { createServer } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import { egressFetch } from '@/modules/egress/index.js';
import { AppError } from '@/shared/index.js';
import type { AnyRecord, ApiAgent } from '@/shared/types.js';
import { validateConnectionEndpoint } from './connections.service.js';

type Tool = { id: string; name: string; arguments: string };
type Reply = { text: string; tools: Tool[]; usage: AnyRecord; finish: string; model: string };
type Prepared = { body: AnyRecord; custom: Set<string>; messages: AnyRecord[] };
const MAX_BODY = 16 * 1024 * 1024;

function text(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return value === undefined ? '' : JSON.stringify(value);
  return value.map(part => typeof part === 'string' ? part : part?.text ?? JSON.stringify(part)).join('\n');
}

function content(parts: unknown): string | AnyRecord[] {
  if (typeof parts === 'string') return parts;
  if (!Array.isArray(parts)) return '';
  const result: AnyRecord[] = [];
  for (const part of parts) {
    if (!part || typeof part !== 'object') continue;
    if (typeof part.text === 'string') result.push({ type: 'text', text: part.text });
    else if (part.type === 'input_image' || part.type === 'image_url') {
      const value = part.image_url;
      if (value) result.push({ type: 'image_url', image_url: typeof value === 'string' ? { url: value } : value });
    } else if (part.type === 'image' && part.source) {
      const source = part.source;
      const url = source.type === 'base64' ? `data:${source.media_type};base64,${source.data}` : source.url;
      if (url) result.push({ type: 'image_url', image_url: { url } });
    } else if (part.inlineData || part.inline_data) {
      const inline = part.inlineData || part.inline_data;
      result.push({ type: 'image_url', image_url: { url: `data:${inline.mimeType || inline.mime_type};base64,${inline.data}` } });
    }
  }
  return result.every(part => part.type === 'text') ? result.map(part => part.text).join('\n') : result;
}

function assistantTool(messages: AnyRecord[], tool: Tool): void {
  const last = messages.at(-1);
  const call = { id: tool.id, type: 'function', function: { name: tool.name, arguments: tool.arguments } };
  if (last?.role === 'assistant' && last.tool_calls) last.tool_calls.push(call);
  else messages.push({ role: 'assistant', content: null, tool_calls: [call] });
}

function schema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(schema);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, key === 'type' && typeof item === 'string' ? item.toLowerCase() : schema(item)]));
}

function prepare(agent: ApiAgent, request: AnyRecord, fallback: string, cached?: AnyRecord[]): Prepared {
  const messages: AnyRecord[] = cached ? [...cached] : [];
  const tools: AnyRecord[] = [];
  const custom = new Set<string>();
  let choice: unknown;
  if (agent === 'codex') {
    if (request.instructions) messages.unshift({ role: 'system', content: text(request.instructions) });
    const input = typeof request.input === 'string' ? [{ role: 'user', content: request.input }] : request.input || [];
    for (const item of input) {
      if (item.type === 'function_call' || item.type === 'custom_tool_call') assistantTool(messages, {
        id: item.call_id || item.id, name: item.name,
        arguments: item.type === 'custom_tool_call' ? JSON.stringify({ input: item.input }) : item.arguments || '{}',
      });
      else if (item.type === 'function_call_output' || item.type === 'custom_tool_call_output') messages.push({ role: 'tool', tool_call_id: item.call_id, content: text(item.output) });
      else if (item.role) messages.push({ role: item.role === 'developer' ? 'system' : item.role, content: content(item.content) });
    }
    for (const tool of request.tools || []) {
      if (tool.type === 'function') tools.push({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters || { type: 'object', properties: {} } } });
      else if (tool.type === 'custom') {
        custom.add(tool.name);
        tools.push({ type: 'function', function: { name: tool.name, description: tool.description,
          parameters: { type: 'object', properties: { input: { type: 'string', description: 'The complete freeform tool input, following the tool description.' } }, required: ['input'], additionalProperties: false } } });
      }
    }
    choice = typeof request.tool_choice === 'string' ? request.tool_choice
      : request.tool_choice?.name ? { type: 'function', function: { name: request.tool_choice.name } } : undefined;
  } else if (agent === 'claude') {
    if (request.system) messages.push({ role: 'system', content: text(request.system) });
    for (const message of request.messages || []) {
      const parts = Array.isArray(message.content) ? message.content : [{ type: 'text', text: message.content }];
      const visible = parts.filter((part: AnyRecord) => !['tool_use', 'tool_result', 'thinking', 'redacted_thinking'].includes(part.type));
      if (message.role === 'assistant') {
        const calls = parts.filter((part: AnyRecord) => part.type === 'tool_use').map((part: AnyRecord) => ({ id: part.id, type: 'function', function: { name: part.name, arguments: JSON.stringify(part.input || {}) } }));
        messages.push({ role: 'assistant', content: content(visible) || null, ...(calls.length ? { tool_calls: calls } : {}) });
      } else {
        for (const part of parts.filter((part: AnyRecord) => part.type === 'tool_result')) messages.push({ role: 'tool', tool_call_id: part.tool_use_id, content: text(part.content) });
        if (visible.length) messages.push({ role: 'user', content: content(visible) });
      }
    }
    for (const tool of request.tools || []) if (tool.name) tools.push({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.input_schema || { type: 'object', properties: {} } } });
    choice = request.tool_choice?.type === 'tool' ? { type: 'function', function: { name: request.tool_choice.name } }
      : request.tool_choice?.type === 'any' ? 'required' : request.tool_choice?.type;
  } else {
    const system = request.systemInstruction || request.system_instruction;
    if (system) messages.push({ role: 'system', content: content(system.parts) });
    const pending: { name: string; id: string }[] = [];
    for (const message of request.contents || []) {
      const parts: AnyRecord[] = message.parts || [];
      const visible = parts.filter(part => !part.functionCall && !part.functionResponse && !part.function_call && !part.function_response);
      // agy can label function-response contents as `model`; the part determines
      // its meaning, otherwise successful tool output silently disappears.
      for (const part of parts) {
        const result = part.functionResponse || part.function_response;
        if (!result) continue;
        const index = pending.findIndex(call => result.id ? call.id === result.id : call.name === result.name);
        const matched = index >= 0 ? pending.splice(index, 1)[0] : undefined;
        messages.push({ role: 'tool', tool_call_id: result.id || matched?.id || result.name, content: text(result.response) });
      }
      if (message.role === 'model') {
        const calls = parts.flatMap(part => {
          const call = part.functionCall || part.function_call;
          if (!call) return [];
          const id = call.id || `call_${pending.length}_${call.name}`;
          pending.push({ name: call.name, id });
          return [{ id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args || {}) } }];
        });
        if (visible.length || calls.length) messages.push({ role: 'assistant', content: content(visible) || null, ...(calls.length ? { tool_calls: calls } : {}) });
      } else {
        if (visible.length) messages.push({ role: 'user', content: content(visible) });
      }
    }
    for (const group of request.tools || []) for (const tool of group.functionDeclarations || group.function_declarations || []) {
      tools.push({ type: 'function', function: { name: tool.name, description: tool.description, parameters: schema(tool.parametersJsonSchema || tool.parameters || { type: 'object', properties: {} }) } });
    }
    const config = request.toolConfig?.functionCallingConfig || request.tool_config?.function_calling_config;
    choice = config?.mode === 'NONE' ? 'none' : config?.mode === 'ANY' ? 'required' : undefined;
  }
  const generation = request.generationConfig || request.generation_config || {};
  const max = request.max_output_tokens || request.max_tokens || generation.maxOutputTokens || generation.max_output_tokens;
  return { custom, messages, body: {
    model: request.model || fallback, messages, stream: true, stream_options: { include_usage: true },
    ...(tools.length ? { tools, ...(choice ? { tool_choice: choice } : {}) } : {}),
    ...(max ? { max_tokens: max } : {}),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : generation.temperature !== undefined ? { temperature: generation.temperature } : {}),
    ...(request.parallel_tool_calls === false || request.tool_choice?.disable_parallel_tool_use ? { parallel_tool_calls: false } : {}),
  } };
}

function toolInput(tool: Tool): AnyRecord {
  try { return JSON.parse(tool.arguments || '{}'); }
  catch { throw new AppError('第三方模型返回了无效的工具参数，请重试或更换模型', { statusCode: 502, code: 'INVALID_TOOL_ARGUMENTS' }); }
}

async function complete(upstream: Response, onText: (delta: string) => void): Promise<Reply> {
  const reply: Reply = { text: '', tools: [], usage: {}, finish: '', model: '' };
  const calls = new Map<number, Tool>();
  let bytes = 0;
  const accept = (data: AnyRecord) => {
    if (data.error) throw new AppError('第三方 Chat API 返回生成错误，请检查模型和账户额度', { statusCode: 502 });
    if (data.model) reply.model = data.model;
    if (data.usage) reply.usage = data.usage;
    const choice = data.choices?.[0];
    const delta = choice?.delta || choice?.message;
    if (typeof delta?.content === 'string') { reply.text += delta.content; onText(delta.content); }
    for (const [offset, call] of (delta?.tool_calls || []).entries()) {
      const index = call.index ?? offset;
      const current = calls.get(index) || { id: '', name: '', arguments: '' };
      if (call.id) current.id = call.id;
      if (call.function?.name) current.name += call.function.name;
      if (typeof call.function?.arguments === 'string') current.arguments += call.function.arguments;
      calls.set(index, current);
    }
    if (choice?.finish_reason) reply.finish = choice.finish_reason;
  };
  if (upstream.headers.get('content-type')?.includes('application/json')) accept(await upstream.json() as AnyRecord);
  else {
    if (!upstream.body) throw new AppError('第三方 Chat API 回复为空', { statusCode: 502 });
    const decoder = new TextDecoder();
    let buffer = '';
    let ended = false;
    const block = (value: string) => {
      const data = value.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      if (!data) return;
      if (data === '[DONE]') { ended = true; return; }
      try { accept(JSON.parse(data)); } catch (error) {
        if (error instanceof AppError) throw error;
        throw new AppError('第三方 Chat API 流格式无效', { statusCode: 502 });
      }
    };
    for await (const chunk of upstream.body) {
      bytes += chunk.length;
      if (bytes > MAX_BODY) throw new AppError('第三方 Chat API 回复超过读取上限', { statusCode: 502 });
      buffer += decoder.decode(chunk, { stream: true });
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) { block(buffer.slice(0, boundary.index)); buffer = buffer.slice(boundary.index + boundary[0].length); }
    }
    if (buffer.trim()) block(buffer);
    if (!ended && !reply.finish) throw new AppError('第三方 Chat API 回复流提前断开', { statusCode: 502 });
  }
  reply.tools = [...calls.values()].map(call => ({ ...call, id: call.id || 'call_' + randomUUID() }));
  if (!reply.text && !reply.tools.length) throw new AppError('第三方 Chat API 没有返回文字或工具调用', { statusCode: 502 });
  for (const call of reply.tools) {
    if (!call.name) throw new AppError('第三方模型没有返回工具名称', { statusCode: 502 });
    toolInput(call);
  }
  return reply;
}

/** Used by all three API runtimes to translate their native tool loop to one Chat Completions endpoint. A per-run loopback credential keeps the upstream key inside this server. */
export async function startApiRelay(agent: Exclude<ApiAgent, 'chat'>, selected: {
  id: string; baseUrl?: string; apiKey?: string; model?: string; env: Record<string, string>;
}) {
  await validateConnectionEndpoint(selected.baseUrl!);
  const key = randomUUID();
  const fetcher = egressFetch('api:' + selected.id, selected.env);
  const controllers = new Set<AbortController>();
  const continuations = new Map<string, AnyRecord[]>();
  const redact = (value: string) => selected.apiKey ? value.replaceAll(selected.apiKey, '[密钥已隐藏]').replaceAll(key, '[密钥已隐藏]') : value.replaceAll(key, '[密钥已隐藏]');
  const safeJson = (value: unknown) => JSON.stringify(value, (_name, field) => typeof field === 'string' ? redact(field) : field);
  const server = createServer(async (req, res) => {
    const controller = new AbortController();
    controllers.add(controller);
    res.once('close', () => controller.abort());
    let streaming = false;
    let sequence = 0;
    const sse = (event: string, payload: AnyRecord) => {
      if (res.destroyed) return;
      if (!res.headersSent) res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
      streaming = true;
      res.write((agent === 'antigravity' ? '' : `event: ${event}\n`) + 'data: ' + safeJson(agent === 'codex' ? { ...payload, type: event, sequence_number: sequence++ } : payload) + '\n\n');
    };
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      const credential = String(req.headers['x-api-key'] || req.headers['x-goog-api-key'] || req.headers.authorization?.replace(/^Bearer /, '') || url.searchParams.get('key') || '');
      if (credential.length !== key.length || !timingSafeEqual(Buffer.from(credential), Buffer.from(key))) { res.writeHead(401).end(); return; }
      if (req.method === 'GET' && url.pathname.endsWith('/models')) {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(url.pathname.includes('v1beta') ? { models: [{ name: 'models/' + selected.model, supportedGenerationMethods: ['generateContent'] }] } : { data: [{ id: selected.model, object: 'model' }] })); return;
      }
      const gemini = url.pathname.match(/\/models\/(.+):(streamGenerateContent|generateContent)$/);
      if (req.method !== 'POST' || !(agent === 'codex' && url.pathname.endsWith('/responses') || agent === 'claude' && /\/messages(?:\/count_tokens)?$/.test(url.pathname) || agent === 'antigravity' && gemini)) { res.writeHead(404).end(); return; }
      let raw = '';
      for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw) > MAX_BODY) throw new AppError('Agent 请求超过读取上限', { statusCode: 413 }); }
      let body: AnyRecord;
      try { body = JSON.parse(raw); } catch { throw new AppError('Agent 请求格式无效', { statusCode: 400 }); }
      if (agent === 'claude' && url.pathname.endsWith('/count_tokens')) {
        // The gateway has no upstream tokenizer. Claude Code can use its local estimate instead.
        res.writeHead(404).end(); return;
      }
      if (gemini) body.model = decodeURIComponent(gemini[1]);
      const prepared = prepare(agent, body, selected.model || '', body.previous_response_id ? continuations.get(body.previous_response_id) : undefined);
      // The caller pins the user's actual model. agy accepts a built-in Gemini id on its CLI,
      // while this gateway routes that native wire format to the user's Chat API model.
      if (selected.model) prepared.body.model = selected.model;
      if (!prepared.body.model) throw new AppError('请先填写第三方 API 的默认模型', { statusCode: 400 });
      const upstreamRequest = (usage: boolean) => fetcher(selected.baseUrl!.replace(/\/$/, '') + '/chat/completions', {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { Authorization: 'Bearer ' + selected.apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...prepared.body, ...(usage ? {} : { stream_options: undefined }) }),
      });
      let upstream = await upstreamRequest(true);
      if ([400, 422].includes(upstream.status)) {
        const hint = (await upstream.text()).slice(0, 8192);
        if (/stream_options|include_usage/i.test(hint) && /unknown|unsupported|unrecognized|not support|extra|not permitted|invalid/i.test(hint)) upstream = await upstreamRequest(false);
      }
      if (!upstream.ok) throw new AppError(`第三方 Chat API 返回 HTTP ${upstream.status}，请检查地址、密钥和模型`, { statusCode: 502 });
      const id = (agent === 'codex' ? 'resp_' : 'msg_') + randomUUID().replaceAll('-', '');
      const wantsStream = agent === 'antigravity' ? gemini?.[2] === 'streamGenerateContent' : body.stream === true;
      const created = Math.floor(Date.now() / 1000);
      const messageId = 'msg_' + randomUUID().replaceAll('-', '');
      let textStarted = false;
      if (wantsStream && agent === 'codex') sse('response.created', { response: { id, object: 'response', created_at: created, status: 'in_progress', model: prepared.body.model, output: [] } });
      if (wantsStream && agent === 'claude') sse('message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model: prepared.body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });
      const reply = await complete(upstream, delta => {
        if (!wantsStream) return;
        if (agent === 'codex') {
          if (!textStarted) {
            sse('response.output_item.added', { output_index: 0, item: { id: messageId, type: 'message', role: 'assistant', status: 'in_progress', content: [] } });
            sse('response.content_part.added', { item_id: messageId, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
          }
          sse('response.output_text.delta', { item_id: messageId, output_index: 0, content_index: 0, delta });
        } else if (agent === 'claude') {
          if (!textStarted) sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
          sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: delta } });
        } else sse('', { candidates: [{ index: 0, content: { role: 'model', parts: [{ text: delta }] } }], modelVersion: replyModel(prepared.body.model) });
        textStarted = true;
      });
      const usage = reply.usage;
      const input = Number(usage.prompt_tokens || 0), output = Number(usage.completion_tokens || 0);
      let final: AnyRecord;
      if (agent === 'codex') {
        const items: AnyRecord[] = [];
        if (reply.text) {
          const part = { type: 'output_text', text: reply.text, annotations: [] };
          const item = { id: messageId, type: 'message', role: 'assistant', status: 'completed', content: [part] };
          items.push(item);
          if (wantsStream) {
            sse('response.output_text.done', { item_id: messageId, output_index: 0, content_index: 0, text: reply.text });
            sse('response.content_part.done', { item_id: messageId, output_index: 0, content_index: 0, part });
            sse('response.output_item.done', { output_index: 0, item });
          }
        }
        for (const tool of reply.tools) {
          const custom = prepared.custom.has(tool.name);
          const value = custom ? toolInput(tool).input : tool.arguments;
          if (custom && typeof value !== 'string') throw new AppError('第三方模型没有返回有效的自定义工具输入', { statusCode: 502 });
          const item = { id: 'fc_' + randomUUID().replaceAll('-', ''), type: custom ? 'custom_tool_call' : 'function_call', call_id: tool.id, name: tool.name, status: 'completed', ...(custom ? { input: value } : { arguments: value }) };
          const index = items.length;
          items.push(item);
          if (wantsStream) {
            sse('response.output_item.added', { output_index: index, item: { ...item, status: 'in_progress', ...(custom ? { input: '' } : { arguments: '' }) } });
            sse(custom ? 'response.custom_tool_call_input.delta' : 'response.function_call_arguments.delta', { item_id: item.id, output_index: index, delta: value });
            sse(custom ? 'response.custom_tool_call_input.done' : 'response.function_call_arguments.done', { item_id: item.id, output_index: index, ...(custom ? { input: value } : { arguments: value }) });
            sse('response.output_item.done', { output_index: index, item });
          }
        }
        final = { id, object: 'response', created_at: created, status: reply.finish === 'length' ? 'incomplete' : 'completed', model: prepared.body.model, output: items,
          usage: { input_tokens: input, output_tokens: output, total_tokens: input + output, input_tokens_details: { cached_tokens: usage.prompt_tokens_details?.cached_tokens || 0 }, output_tokens_details: { reasoning_tokens: usage.completion_tokens_details?.reasoning_tokens || 0 } } };
        const assistant: AnyRecord = { role: 'assistant', content: reply.text || null, ...(reply.tools.length ? { tool_calls: reply.tools.map(tool => ({ id: tool.id, type: 'function', function: { name: tool.name, arguments: tool.arguments } })) } : {}) };
        continuations.set(id, [...prepared.messages, assistant]);
        if (continuations.size > 32) continuations.delete(continuations.keys().next().value!);
        if (wantsStream) sse(reply.finish === 'length' ? 'response.incomplete' : 'response.completed', { response: final });
      } else if (agent === 'claude') {
        const blocks: AnyRecord[] = reply.text ? [{ type: 'text', text: reply.text }] : [];
        if (wantsStream && textStarted) sse('content_block_stop', { type: 'content_block_stop', index: 0 });
        for (const tool of reply.tools) {
          const index = blocks.length;
          blocks.push({ type: 'tool_use', id: tool.id, name: tool.name, input: toolInput(tool) });
          if (wantsStream) {
            sse('content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: tool.id, name: tool.name, input: {} } });
            sse('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: tool.arguments || '{}' } });
            sse('content_block_stop', { type: 'content_block_stop', index });
          }
        }
        const stop = reply.tools.length ? 'tool_use' : reply.finish === 'length' ? 'max_tokens' : 'end_turn';
        final = { id, type: 'message', role: 'assistant', model: prepared.body.model, content: blocks, stop_reason: stop, stop_sequence: null, usage: { input_tokens: input, output_tokens: output } };
        if (wantsStream) {
          sse('message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: final.usage });
          sse('message_stop', { type: 'message_stop' });
        }
      } else {
        const parts = [...(reply.text && !wantsStream ? [{ text: reply.text }] : []), ...reply.tools.map(tool => ({ functionCall: { id: tool.id, name: tool.name, args: toolInput(tool) } }))];
        final = { candidates: [{ index: 0, content: { role: 'model', parts }, finishReason: reply.finish === 'length' ? 'MAX_TOKENS' : 'STOP' }], modelVersion: replyModel(prepared.body.model),
          usageMetadata: { promptTokenCount: input, candidatesTokenCount: output, totalTokenCount: input + output } };
        if (wantsStream) sse('', final);
      }
      if (!wantsStream) { res.setHeader('Content-Type', 'application/json'); res.end(safeJson(final)); }
      else res.end();
    } catch (error) {
      if (!res.destroyed) {
        const message = error instanceof AppError ? error.message : '第三方 Chat API 连接或协议转换失败，请检查服务商兼容性';
        if (streaming) { sse(agent === 'claude' ? 'error' : agent === 'codex' ? 'error' : '', { type: 'error', error: { type: 'api_error', code: 'API_RELAY_ERROR', message } }); res.end(); }
        else { res.writeHead(error instanceof AppError ? error.statusCode : 502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { type: 'api_error', message } })); }
      }
    } finally { controllers.delete(controller); }
  });
  // Gemini consumers accept the gateway model id even when it isn't a built-in Google model.
  function replyModel(model: string) { return model; }
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('API relay did not bind');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`, apiKey: key,
    async close() { for (const controller of controllers) controller.abort(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); continuations.clear(); },
  };
}
