import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

import { sessionsDb } from '@/modules/database/index.js';
import { createCompleteMessage, createNormalizedMessage } from '@/shared/index.js';
import type { AnyRecord, ProviderRuntimeWriter } from '@/shared/index.js';
import { resolveCodexConnection, validateConnectionEndpoint } from './connections.service.js';

const running = new Map<string, AbortController>();

function textParts(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.map(part => typeof part?.text === 'string' ? part.text : '').join('\n');
}

/** Used by compatible chat and its tests to reconstruct visible native conversation context. */
export function readCompatibleHistory(file: string): { role: string; content: string }[] {
  if (!fs.existsSync(file)) return [];
  const messages: { role: string; content: string }[] = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let row: AnyRecord;
    try { row = JSON.parse(line) as AnyRecord; } catch { continue; }
    const p = row.payload || {};
    if (row.type === 'event_msg' && p.type === 'user_message') messages.push({ role: 'user', content: p.message });
    if (row.type === 'event_msg' && p.type === 'item_completed' && p.item?.type === 'UserMessage') messages.push({ role: 'user', content: textParts(p.item.content) });
    if (row.type === 'response_item' && p.type === 'message' && p.role === 'assistant') messages.push({ role: 'assistant', content: textParts(p.content) });
  }
  return messages.filter(item => item.content?.trim()).slice(-100);
}

function send(writer: ProviderRuntimeWriter, message: unknown): void {
  writer.send(writer.isWebSocketWriter ? message : JSON.stringify(message));
}

/** Used by Codex runtime to stop a Chat Completions request without touching other accounts. */
export function abortCompatibleChat(sessionId: string): boolean {
  const controller = running.get(sessionId);
  if (!controller) return false;
  controller.abort(); return true;
}

/** Used by Codex runtime for providers exposing only Chat Completions; transcripts stay native. */
export async function runCompatibleChat(command: string, options: AnyRecord, writer: ProviderRuntimeWriter, selected: ReturnType<typeof resolveCodexConnection>): Promise<void> {
  const sessionId = String(options.sessionId);
  const session = sessionsDb.getSessionById(sessionId);
  if (!session) throw new Error('会话不存在');
  const controller = new AbortController(); running.set(sessionId, controller);
  const nativeId = session.provider_session_id || randomUUID();
  const stamp = new Date().toISOString();
  const directory = path.join(os.homedir(), '.codex', 'sessions', ...stamp.slice(0, 10).split('-'));
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = session.jsonl_path || path.join(directory, `rollout-${stamp.replace(/:/g, '-')}-${nativeId}.jsonl`);
  const turnId = randomUUID();
  const append = (type: string, payload: unknown) => fs.appendFileSync(file, JSON.stringify({ timestamp: new Date().toISOString(), type, payload }) + '\n', { mode: 0o600 });
  const history = readCompatibleHistory(file);
  const model = options.model || selected.model;
  let output = '', finished = false, terminalError: string | undefined;
  let returnedModel: string | undefined;
  let returnedId: string | undefined;
  let returnedUsage: { prompt_tokens: number; completion_tokens: number; total_tokens: number; cached_input_tokens: number; reasoning_output_tokens: number } | undefined;
  // Preserve cumulative native counters while requesting usage on new streamed responses.
  let previousUsage: Record<string, number> = {};
  if (fs.existsSync(file)) for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    try { const row = JSON.parse(line); if (row.payload?.type === 'token_count' && row.payload.info?.total_token_usage) previousUsage = row.payload.info.total_token_usage; } catch { /* incomplete trailing record */ }
  }
  try {
    await validateConnectionEndpoint(selected.baseUrl!);
    if (!model) throw new Error('请先为第三方 API 填写模型名');
    if (!fs.existsSync(file)) {
      sessionsDb.repointSessionToProviderSession(sessionId, { providerSessionId: nativeId, jsonlPath: file });
      append('session_meta', { id: nativeId, timestamp: stamp, cwd: options.cwd || '/home/ubuntu', originator: 'cloudcli', cli_version: '0.160.1', source: 'cli', model_provider: 'openai' });
    }
    writer.setSessionId?.(nativeId);
    append('turn_context', { model });
    append('event_msg', { type: 'task_started', turn_id: turnId });
    append('event_msg', { type: 'user_message', message: command, images: [] });
    append('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: command }] });
    const request = (includeUsage: boolean) => fetch(selected.baseUrl + '/chat/completions', {
      method: 'POST', redirect: 'error', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + selected.apiKey },
      body: JSON.stringify({ model, stream: true, ...(includeUsage ? { stream_options: { include_usage: true } } : {}), messages: [...history, { role: 'user', content: command }] }),
    });
    let response = await request(true);
    if ([400, 422].includes(response.status) && response.body) {
      // Older compatible APIs may reject the usage option. Retry only an explicit
      // pre-generation schema rejection, never a failed or partially streamed turn.
      const reader = response.body.getReader(); let hint = '';
      try {
        while (hint.length < 8192) { const chunk = await reader.read(); if (chunk.done) break; hint += new TextDecoder().decode(chunk.value); }
      } finally { await reader.cancel(); }
      if (/(?:stream_options|include_usage)/i.test(hint) && /(?:unknown|unsupported|unrecognized|not support|extra|not permitted|invalid)/i.test(hint)) response = await request(false);
    }
    // Do not forward provider response bodies: they may echo keys or private request headers.
    if (!response.ok) throw new Error(`第三方 API 返回 HTTP ${response.status}，请检查地址、密钥与模型名`);
    if (response.headers.get('content-type')?.includes('text/html')) throw new Error('第三方 API 返回了网页，请检查 API 地址是否包含 /v1');
    const accept = (data: AnyRecord) => {
      if (data.error) throw new Error('第三方 API 返回错误，请检查模型或账户余额');
      if (typeof data.model === 'string' && data.model.length <= 256) returnedModel = data.model;
      if (typeof data.id === 'string' && data.id.length <= 256) returnedId = data.id;
      if (data.usage && typeof data.usage.prompt_tokens === 'number' && typeof data.usage.completion_tokens === 'number') {
        const count = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
        returnedUsage = { prompt_tokens: count(data.usage.prompt_tokens), completion_tokens: count(data.usage.completion_tokens),
          total_tokens: count(data.usage.total_tokens), cached_input_tokens: count(data.usage.prompt_tokens_details?.cached_tokens),
          reasoning_output_tokens: count(data.usage.completion_tokens_details?.reasoning_tokens) };
      }
      const choice = data.choices?.[0];
      if (choice?.delta?.tool_calls || choice?.message?.tool_calls) throw new Error('此接口请求执行工具；需要 VPS 工具时请选择 Responses 协议');
      const text = choice?.delta?.content ?? choice?.message?.content;
      if (typeof text === 'string') output += text;
      if (choice?.finish_reason) finished = true;
      if (output.length > 4 * 1024 * 1024) throw new Error('第三方回复超过读取上限');
    };
    if (response.headers.get('content-type')?.includes('application/json')) {
      accept(await response.json() as AnyRecord); finished = true;
    } else {
      if (!response.body) throw new Error('第三方 API 未返回内容');
      const decoder = new TextDecoder(); let pending = '';
      for await (const chunk of response.body) {
        pending += decoder.decode(chunk, { stream: true });
        if (pending.length > 8 * 1024 * 1024) throw new Error('第三方事件超过读取上限');
        const lines = pending.split('\n'); pending = lines.pop() || '';
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') { finished = true; continue; }
          if (data) accept(JSON.parse(data) as AnyRecord);
        }
      }
      const tail = pending.trim();
      if (tail.startsWith('data:')) {
        const value = tail.slice(5).trim();
        if (value === '[DONE]') finished = true; else if (value) accept(JSON.parse(value) as AnyRecord);
      }
    }
    if (!finished) throw new Error('第三方回复流提前断开，已保留收到的内容');
    if (!output.trim()) throw new Error('第三方 API 未返回文字内容');
  } catch (error) {
    terminalError = controller.signal.aborted ? '已停止' : error instanceof Error ? error.message : '第三方 API 请求失败';
    // Only known application errors are exposed. Fetch/JSON errors can contain
    // request URLs or response fragments and are deliberately kept generic.
    if (!/^(第三方|请先|此接口|API 地址|已停止)/.test(terminalError)) terminalError = '第三方 API 连接或返回格式异常';
  } finally {
    if (output) {
      if (selected.apiKey) {
        output = output.replaceAll(selected.apiKey, '[密钥已隐藏]');
        returnedModel = returnedModel?.replaceAll(selected.apiKey, '[密钥已隐藏]');
        returnedId = returnedId?.replaceAll(selected.apiKey, '[密钥已隐藏]');
      }
      append('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: output }],
        ...(returnedId ? { id: returnedId } : {}), ...(returnedModel ? { model: returnedModel } : {}), ...(returnedUsage ? { usage: returnedUsage } : {}) });
      if (returnedUsage) {
        const last = { input_tokens: returnedUsage.prompt_tokens, output_tokens: returnedUsage.completion_tokens,
          cached_input_tokens: returnedUsage.cached_input_tokens, reasoning_output_tokens: returnedUsage.reasoning_output_tokens,
          total_tokens: returnedUsage.prompt_tokens + returnedUsage.completion_tokens };
        const total = Object.fromEntries(Object.entries(last).map(([key, value]) => [key, (Number(previousUsage[key]) || 0) + value]));
        append('event_msg', { type: 'token_count', info: { total_token_usage: total, last_token_usage: last } });
      }
      send(writer, createNormalizedMessage({ kind: 'text', provider: 'codex', sessionId: nativeId, role: 'assistant', content: output }));
    }
    if (terminalError && !controller.signal.aborted) append('monitor_error', { message: terminalError });
    append('event_msg', { type: 'task_complete', turn_id: turnId, last_agent_message: output || null });
    if (terminalError && !controller.signal.aborted) send(writer, createNormalizedMessage({ kind: 'error', provider: 'codex', sessionId: nativeId, content: terminalError }));
    send(writer, createCompleteMessage({ provider: 'codex', sessionId: nativeId, exitCode: terminalError ? 1 : 0, aborted: controller.signal.aborted }));
    running.delete(sessionId);
  }
}
