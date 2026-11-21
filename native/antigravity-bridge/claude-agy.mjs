import { randomBytes, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';

const emit = event => process.stdout.write(JSON.stringify(event) + '\n');
const tools = ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'NotebookEdit', 'Bash'];
const limit = 24 * 1024 * 1024;
const TERMINAL_STATUSES = new Set([400, 401, 403, 404, 422]);
const TERMINAL_STREAM_RE = /"type"\s*:\s*"(?:permission_error|authentication_error|invalid_request_error)"/;
const RETRYABLE_STREAM_RE = /"type"\s*:\s*"(?:rate_limit_error|overloaded_error|api_error)"/;
const UUID_RE = /^[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$/;
const ACP_SESSION_RE = /(?:Created conversation|Starting conversation update stream for|Sending user message to conversation)\s+([0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12})\b/g;
const ACP_HTTP_RE = /URL:\s+(https?:\/\/\S+)\s+Trace:\s+([A-Za-z0-9._:-]{1,200})\s+ResponseID:\s+([A-Za-z0-9._:-]{1,200})/g;
const ACP_RESPONSE_ID_RE = /\[streamGenerateContent\] ResponseID:\s+([A-Za-z0-9._:-]{1,200})/g;

function scanAgyAcpLogs(tmpDir, trace) {
  if (!tmpDir) return;
  let entries;
  try {
    entries = fs.readdirSync(tmpDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('magpie-agy-bridge-')) continue;
    const logPath = path.join(tmpDir, entry.name, 'agy-acp.log');
    let text;
    try {
      text = fs.readFileSync(logPath, 'utf8');
    } catch {
      continue;
    }
    for (const match of text.matchAll(ACP_SESSION_RE)) {
      trace.sessions.add(match[1]);
    }
    for (const match of text.matchAll(ACP_HTTP_RE)) {
      trace.upstreamUrls.add(match[1]);
      trace.traceIds.add(match[2]);
      trace.responseIds.add(match[3]);
    }
    for (const match of text.matchAll(ACP_RESPONSE_ID_RE)) {
      trace.responseIds.add(match[1]);
    }
  }
}

function truncateInline(value, max = 72) {
  const clean = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  return clean.length > max ? clean.slice(0, max - 1) + '…' : clean;
}

function formatToolLabel(name, input) {
  const toolName = String(name || 'Tool');
  if (!input || typeof input !== 'object') return toolName;
  let detail = '';
  if (['Read', 'Edit', 'Write', 'NotebookEdit'].includes(toolName)) {
    const target = input.file_path || input.notebook_path || input.path;
    if (typeof target === 'string' && target.trim()) {
      const trimmed = target.trim();
      detail = trimmed.length > 72 ? '…/' + path.basename(trimmed) : trimmed;
    }
  } else if (toolName === 'Glob' || toolName === 'Grep') {
    detail = truncateInline(input.pattern || input.path);
  } else if (toolName === 'Bash') {
    detail = truncateInline(input.description || input.command);
  }
  return detail ? `${toolName}: ${detail}` : toolName;
}

function normalizeUsage(raw) {
  if (!raw || typeof raw !== 'object') return raw;
  const usage = { ...raw };
  const cacheRead = usage.cache_read_tokens ?? usage.cache_read_input_tokens;
  if (typeof cacheRead === 'number' && Number.isFinite(cacheRead)) {
    usage.cache_read_tokens = cacheRead;
  }
  const cacheCreate = usage.cache_creation_tokens ?? usage.cache_creation_input_tokens;
  if (typeof cacheCreate === 'number' && Number.isFinite(cacheCreate)) {
    usage.cache_creation_tokens = cacheCreate;
  }
  if (usage.total_tokens == null && (usage.input_tokens != null || usage.output_tokens != null)) {
    const base = (Number(usage.input_tokens) || 0) + (Number(usage.output_tokens) || 0);
    const cacheExtra = ('cache_read_input_tokens' in raw || 'cache_creation_input_tokens' in raw)
      ? (Number(cacheRead) || 0) + (Number(cacheCreate) || 0)
      : 0;
    usage.total_tokens = base + cacheExtra;
  }
  return usage;
}

function errorResponse(res, status, message) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message } }));
}

function validKey(value, secret) {
  if (typeof value !== 'string' || value.length !== secret.length) return false;
  const received = Buffer.from(value);
  return received.length === secret.length && timingSafeEqual(received, Buffer.from(secret));
}

async function readBody(stream) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > limit) throw new Error('Request too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function run() {
  const input = JSON.parse(await readBody(process.stdin));
  const load = createRequire(path.join(process.env.MINTCLI_REPO, 'package.json'));
  const { query } = await import(pathToFileURL(load.resolve('@anthropic-ai/claude-agent-sdk')));
  const pluginFile = path.join(process.env.MINTCLI_MAGPIE_AGY, 'index.mjs');
  const { default: plugin } = await import(pathToFileURL(pluginFile));
  const host = await plugin.server();
  const adapter = await host.auth.loader(async () => ({ key: 'agy' }));
  const secret = randomBytes(32).toString('hex');
  const controller = new AbortController();
  let terminalError = '';
  let lastUpstreamError = '';
  const agyTrace = {
    sessions: new Set(),
    responseIds: new Set(),
    traceIds: new Set(),
    upstreamUrls: new Set(),
  };
  let lastTraceSignature = '';

  const flushAgyTrace = (force = false) => {
    scanAgyAcpLogs(process.env.TMPDIR, agyTrace);
    if (!agyTrace.sessions.size && !agyTrace.responseIds.size && !agyTrace.traceIds.size && !agyTrace.upstreamUrls.size) {
      return;
    }
    const payload = {
      event: 'agy_trace',
      session_ids: [...agyTrace.sessions],
      response_ids: [...agyTrace.responseIds],
      trace_ids: [...agyTrace.traceIds],
      upstream_urls: [...agyTrace.upstreamUrls],
    };
    const signature = JSON.stringify(payload);
    if (!force && signature === lastTraceSignature) return;
    lastTraceSignature = signature;
    emit(payload);
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (!validKey(req.headers['x-api-key'], secret)) {
      errorResponse(res, 401, 'Invalid local authorization');
      return;
    }
    if (req.method !== 'POST' || !['/v1/messages', '/v1/messages/count_tokens'].includes(url.pathname)) {
      errorResponse(res, 404, 'Unknown local endpoint');
      return;
    }
    const isMessages = url.pathname === '/v1/messages';
    if (isMessages && terminalError) {
      errorResponse(res, 400, terminalError);
      return;
    }
    const request = new AbortController();
    res.once('close', () => { if (!res.writableFinished) request.abort(); });
    try {
      const body = JSON.parse(await readBody(req));
      body.model = input.model;
      const headers = new Headers({ 'content-type': 'application/json' });
      headers.set('x-session-id', input.turnId);
      const result = await adapter.fetch('agy://local' + url.pathname + url.search, {
        method: 'POST', headers, body: JSON.stringify(body),
        signal: AbortSignal.any([request.signal, controller.signal]),
      });
      if (isMessages) {
        const headerSession = String(result.headers.get('x-agy-session-id') || '').trim();
        if (UUID_RE.test(headerSession)) agyTrace.sessions.add(headerSession);
        flushAgyTrace();
      }
      if (isMessages && !result.ok) {
        const msg = 'agy 请求失败（HTTP ' + result.status + '）。请检查模型与账号状态。';
        lastUpstreamError = msg;
        const noRetry = String(result.headers.get('x-should-retry') || '').toLowerCase() === 'false';
        if (noRetry || TERMINAL_STATUSES.has(result.status)) terminalError = msg;
        process.stderr.write(`[claude-agy] upstream ${url.pathname} HTTP ${result.status}\n`);
      } else if (!isMessages && !result.ok) {
        process.stderr.write(`[claude-agy] upstream ${url.pathname} HTTP ${result.status}\n`);
      }
      const outputHeaders = Object.fromEntries(result.headers);
      delete outputHeaders['content-length'];
      res.writeHead(result.status, outputHeaders);
      if (!result.body) {
        if (isMessages && result.ok) lastUpstreamError = '';
        res.end();
        return;
      }
      let sawStreamError = false;
      let streamTail = '';
      await pipeline(Readable.fromWeb(result.body), async function* (source) {
        for await (const chunk of source) {
          if (isMessages) {
            streamTail = (streamTail + Buffer.from(chunk).toString()).slice(-8192);
            if (TERMINAL_STREAM_RE.test(streamTail)) {
              sawStreamError = true;
              terminalError = 'agy 拒绝或未能完成请求。请检查模型与账号状态。';
              lastUpstreamError = terminalError;
            } else if (RETRYABLE_STREAM_RE.test(streamTail)) {
              sawStreamError = true;
              lastUpstreamError = 'agy 暂时不可用或达到限额，请稍后重试。';
            }
          }
          yield chunk;
        }
      }, res);
      if (isMessages) {
        flushAgyTrace();
        if (sawStreamError) {
          process.stderr.write('[claude-agy] upstream stream error: ' + streamTail.slice(-512) + '\n');
        } else if (result.ok) {
          lastUpstreamError = '';
        }
      }
    } catch (err) {
      if (!controller.signal.aborted && !request.signal.aborted) {
        process.stderr.write('[claude-agy] proxy request error: ' + (err?.stack || String(err)) + '\n');
      }
      if (!res.headersSent) errorResponse(res, 502, 'Local agy bridge failed');
      else res.destroy();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const env = {
    PATH: process.env.PATH,
    HOME: input.claudeHome,
    CLAUDE_CONFIG_DIR: input.claudeHome,
    CLAUDE_CODE_ARTIFACT: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1',
    ANTHROPIC_API_KEY: secret,
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:' + server.address().port,
  };
  let finished = false;
  let hasPartialText = false;
  let emittedText = '';
  let needsTextSeparator = false;
  let emittedThinking = false;
  let needsThinkingSeparator = false;

  const emitText = text => {
    if (!text) return;
    if (needsTextSeparator && emittedText) {
      let sep = '';
      if (!emittedText.endsWith('\n\n') && !text.startsWith('\n\n')) {
        sep = emittedText.endsWith('\n') || text.startsWith('\n') ? '\n' : '\n\n';
      }
      if (sep) {
        emittedText += sep;
        emit({ event: 'delta', delta: sep });
      }
      needsTextSeparator = false;
    }
    emittedText += text;
    emit({ event: 'delta', delta: text });
  };

  const emitThinking = thinking => {
    if (!thinking) return;
    if (needsThinkingSeparator && emittedThinking) {
      emit({ event: 'thinking', thinking: '\n\n' });
      needsThinkingSeparator = false;
    }
    emittedThinking = true;
    emit({ event: 'thinking', thinking });
  };

  try {
    const turn = query({
      prompt: input.prompt,
      options: {
        cwd: input.cwd, env, model: input.model, abortController: controller,
        pathToClaudeCodeExecutable: process.env.MINTCLI_CLAUDE_PATH,
        systemPrompt: {
          type: 'preset',
          preset: 'claude_code',
          ...(input.systemAppend ? { append: input.systemAppend } : {}),
        },
        tools, allowedTools: tools, permissionMode: 'dontAsk',
        settingSources: [], includePartialMessages: true, persistSession: false,
        ...(input.sandbox ? { sandbox: {
          enabled: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false,
        } } : {}),
      },
    });
    for await (const item of turn) {
      if (item.type === 'stream_event') {
        if (item.event?.type === 'content_block_start' && item.event.content_block?.type === 'tool_use') {
          if (emittedText) needsTextSeparator = true;
        } else if (item.event?.type === 'content_block_delta') {
          const delta = item.event.delta;
          if (delta?.type === 'text_delta' && delta.text) {
            hasPartialText = true;
            emitText(delta.text);
          } else if (delta?.type === 'thinking_delta' && delta.thinking) {
            emitThinking(delta.thinking);
          }
        }
      } else if (item.type === 'assistant') {
        for (const block of item.message?.content || []) {
          if (block.type === 'tool_use') {
            if (emittedText) needsTextSeparator = true;
            emit({ event: 'tool', tool: formatToolLabel(block.name, block.input) });
          } else if (block.type === 'text' && block.text && !hasPartialText) {
            emitText(block.text);
          }
        }
        if (emittedText) needsTextSeparator = true;
        if (emittedThinking) needsThinkingSeparator = true;
        hasPartialText = false;
      } else if (item.type === 'result') {
        finished = true;
        flushAgyTrace(true);
        if (item.is_error || terminalError) {
          if (item.is_error && item.result) {
            process.stderr.write('[claude-agy] SDK error result: ' + String(item.result).slice(0, 1000) + '\n');
          }
          emit({ event: 'error', error: terminalError || lastUpstreamError || 'Claude Code 未能完成这条回复。' });
        } else {
          const responseText = emittedText || item.result || '';
          emit({ event: 'result', response: responseText, usage: normalizeUsage(item.usage),
            duration_seconds: item.duration_ms / 1000 });
        }
      }
    }
    if (!finished) {
      flushAgyTrace(true);
      emit({ event: 'error', error: 'Claude Code 已退出，未返回生成结果。' });
    }
  } finally {
    controller.abort();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

try {
  await run();
} catch (err) {
  process.stderr.write('[claude-agy] fatal: ' + (err?.stack || String(err)) + '\n');
  emit({ event: 'error', error: 'Claude Code → agy 启动或连接失败，请检查服务状态。' });
}
// The plugin owns an idle process pool. Its exit hook closes it here.
await new Promise(resolve => process.stdout.write('', resolve));
process.exit(0);
