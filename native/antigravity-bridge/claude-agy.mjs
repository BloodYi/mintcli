import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import { analyzeDeliverable, analyzeRefusal } from './armor/src/layers/refusal.mjs';
import { NON_REFUSAL_TAIL, scoreResponse } from './armor/src/layers/scorer3.mjs';

const emit = event => process.stdout.write(JSON.stringify(event) + '\n');
const tools = ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'NotebookEdit', 'Bash'];
const limit = 24 * 1024 * 1024;
const GEMINI_NEON_CONTEXT_WINDOW = '512000';
const GEMINI_NEON_MODEL_RE = /^gemini-4-neon(?:-(?:low|medium|high|xhigh))?$/;
const TERMINAL_STATUSES = new Set([400, 401, 403, 404, 422]);
const TERMINAL_STREAM_RE = /"type"\s*:\s*"(?:permission_error|authentication_error|invalid_request_error)"/;
const RETRYABLE_STREAM_RE = /"type"\s*:\s*"(?:rate_limit_error|overloaded_error|api_error)"/;
const UUID_RE = /^[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$/;
const ACP_SESSION_RE = /(?:Created conversation|Starting conversation update stream for|Sending user message to conversation)\s+([0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12})\b/g;
const ACP_HTTP_RE = /URL:\s+(https?:\/\/\S+)\s+Trace:\s+([A-Za-z0-9._:-]{1,200})\s+ResponseID:\s+([A-Za-z0-9._:-]{1,200})/g;
const ACP_RESPONSE_ID_RE = /\[streamGenerateContent\] ResponseID:\s+([A-Za-z0-9._:-]{1,200})/g;

function scanAgyAcpLogs(tmpDir, trace, scannedLogs) {
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
      const stat = fs.statSync(logPath, { bigint: true });
      const version = [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join('/');
      if (scannedLogs.get(logPath) === version) continue;
      text = fs.readFileSync(logPath, 'utf8');
      scannedLogs.set(logPath, version);
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

const MAX_TOOL_RESULT_CHARS = 32768;
const ARMOR_GATE_CHARS = 600;
const FAST_DELIVERABLE_HEAD_RE = /^\s*(?:#{1,6}\s+\S|```|~~~)/;
const TAIL_DISCLAIMER_HEADING_RE = /^\s*(?:#{1,6}|>|[-*_]{3,})?\s*(?:\*\*|__)?\s*【?(?:免责声明|安全提示|合规提示|法律声明|合规声明|重要声明|安全与免责(?:提示|声明)|安全与合规(?:提示|声明)|Disclaimer|Safety\s+Notice|Legal\s+Disclaimer)】?\s*(?:\*\*|__)?\s*[：:]?\s*$/i;
const TAIL_DISCLAIMER_BODY_RE = /(?:(?:以上|上述|本)(?:代码|脚本|内容|方案|实现|示例|工具)[\s\S]{0,60}?(?:仅供|仅用于|只用于)(?:安全研究|学习|教学|学术|授权测试|本地测试)|请(?:勿|切勿|不要)用于(?:任何)?(?:未授权|非法|恶意)|请遵守(?:当地|相关)?法律法规|(?:solely|strictly|only)?\s*for\s+(?:educational|authorized\s+(?:security\s+)?testing|research)\s+purposes|do\s+not\s+use\s+(?:this|it)\s+against\s+unauthorized)/i;
const TAIL_DISCLAIMER_LINE_RE = /^\s*(?:[>*_\-#]+\s*)*(?:【?(?:免责声明|安全提示|合规提示|法律声明|合规声明|重要声明|安全与免责(?:提示|声明))】?[：:\s]|注[：:]\s*(?:以上|上述|本)(?:代码|脚本|内容|方案|实现|示例)[^\n]{0,24}(?:仅供|仅用于|请勿|切勿)|请注意[：:，,]\s*(?:以上|上述|本)(?:代码|脚本|内容|方案|实现|示例)[^\n]{0,24}(?:仅供|仅用于|请勿|切勿)|(?:以上|上述|本)(?:代码|脚本|内容|方案|实现|示例)(?:仅供|仅用于)(?:安全研究|学习|教学|学术|授权测试|本地测试)[^\n]*(?:请勿|切勿|不得|严禁|遵守)|(?:\*\*)?Disclaimer(?:\*\*)?\s*:\s*(?:The above|This (?:code|script|example|information))[^\n]*(?:educational|authorized|research)|(?:\*\*)?Note(?:\*\*)?\s*:\s*(?:The above|This (?:code|script|example)) is provided (?:solely |strictly |only )?for (?:educational|authorized))/i;

function isSuspectDisclaimerBlock(block, requireComplete = false) {
  let cleaned = String(block || '').trim();
  if (!cleaned || cleaned.length >= 420 || cleaned.includes('```') || cleaned.includes('~~~')) return false;
  cleaned = cleaned.replace(/^(?:---+|\*\*\*+)\s*\n+/, '').trim();
  if (!cleaned) return false;
  const lines = cleaned.split('\n').map(l => l.trim()).filter(Boolean);
  if (!lines.length || lines.length > 6) return false;
  const first = lines[0];
  if (TAIL_DISCLAIMER_LINE_RE.test(first)) {
    if (lines.length === 1) return true;
    return TAIL_DISCLAIMER_BODY_RE.test(lines.slice(1).join('\n')) || !requireComplete;
  }
  if (TAIL_DISCLAIMER_HEADING_RE.test(first)) {
    if (lines.length === 1) return true;
    const rest = lines.slice(1).join('\n');
    return TAIL_DISCLAIMER_BODY_RE.test(rest) || (!requireComplete && rest.length < 80);
  }
  return false;
}

function isArmorRefusal(text) {
  if (!text) return false;
  const s3 = scoreResponse(text);
  if (s3.verdict === 'blocked') return true;
  const v = analyzeRefusal(text);
  if (!v.isRefusal) return false;
  // Exempt pure technical statements exempted by scorer3 NON_REFUSAL_TAIL (e.g. '该接口无法提供此字段')
  if (s3.verdict === 'pass' && v.effectiveScore <= 3) {
    const lower = String(text).toLowerCase();
    if (NON_REFUSAL_TAIL.some(term => lower.includes(term.toLowerCase()))) return false;
  }
  return true;
}

function armorGateDecision(text, force = false) {
  if (isArmorRefusal(text)) return 'retry';
  const deliv = analyzeDeliverable(text);
  if (deliv.hasDeliverable) return 'flush';
  if (FAST_DELIVERABLE_HEAD_RE.test(text) && analyzeRefusal(text).effectiveScore < 2) return 'flush';
  if (force || String(text || '').length >= ARMOR_GATE_CHARS) return 'flush';
  return 'hold';
}

function splitTailDisclaimer(streamedPrefix, pendingTail) {
  if (!pendingTail) return ['', ''];
  if (((streamedPrefix.match(/```/g) || []).length % 2) === 1) return [pendingTail, ''];
  if (isSuspectDisclaimerBlock(pendingTail, false)) return ['', pendingTail];
  const candidates = [];
  const paraIdx = pendingTail.lastIndexOf('\n\n');
  if (paraIdx >= 0) candidates.push(paraIdx + 2);
  const lineIdx = pendingTail.lastIndexOf('\n');
  if (lineIdx >= 0 && !candidates.includes(lineIdx + 1)) candidates.push(lineIdx + 1);
  for (const splitAt of candidates) {
    const before = pendingTail.slice(0, splitAt);
    const after = pendingTail.slice(splitAt);
    if (after.trim() && isSuspectDisclaimerBlock(after, false)) {
      return [before, after];
    }
  }
  return [pendingTail, ''];
}

function stripFinalTailDisclaimer(text) {
  if (!text || text.trim().length < 80 || ((text.match(/```/g) || []).length % 2) === 1) return [text, false];
  const r = text.trimEnd();
  const paraIdx = r.lastIndexOf('\n\n');
  if (paraIdx > 40) {
    let head = r.slice(0, paraIdx).trimEnd();
    const tailBlock = r.slice(paraIdx + 2).trim();
    if (isSuspectDisclaimerBlock(tailBlock, true)) {
      head = head.replace(/\n\s*(?:---+|\*\*\*+)\s*$/, '').trimEnd();
      if (head.length >= 40) return [head, true];
    }
  }
  const lines = r.split('\n');
  for (const take of [2, 1]) {
    if (lines.length > take) {
      const tailCandidate = lines.slice(-take).join('\n').trim();
      let headCandidate = lines.slice(0, -take).join('\n').trimEnd();
      if (headCandidate.length >= 40 && isSuspectDisclaimerBlock(tailCandidate, true)) {
        headCandidate = headCandidate.replace(/\n\s*(?:---+|\*\*\*+)\s*$/, '').trimEnd();
        if (headCandidate.length >= 40) return [headCandidate, true];
      }
    }
  }
  return [text, false];
}

function formatToolResultContent(content) {
  let text = '';
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .map(part => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object') {
          if (typeof part.text === 'string') return part.text;
          if (typeof part.content === 'string') return part.content;
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  } else if (content && typeof content === 'object') {
    try {
      text = JSON.stringify(content, null, 2);
    } catch {
      text = String(content);
    }
  } else if (content != null) {
    text = String(content);
  }
  if (text.length > MAX_TOOL_RESULT_CHARS) {
    return text.slice(0, MAX_TOOL_RESULT_CHARS) + '\n…[输出过长已截断]';
  }
  return text;
}

function sanitizeToolUseResult(value) {
  if (value === undefined || value === null) return undefined;
  try {
    const serialized = JSON.stringify(value);
    if (serialized && serialized.length <= MAX_TOOL_RESULT_CHARS) {
      return value;
    }
  } catch {
    return undefined;
  }
  return undefined;
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

async function* readJsonLines(stream) {
  let buffer = '';
  let bufferedBytes = 0;
  for await (const chunk of stream) {
    const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bufferedBytes += piece.length;
    if (bufferedBytes > limit) throw new Error('Input line too large');
    buffer += piece.toString('utf8');
    let newlineIndex;
    while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      bufferedBytes = Buffer.byteLength(buffer, 'utf8');
      if (line) yield line;
    }
  }
  const trailing = buffer.trim();
  if (trailing) yield trailing;
}

function createHeldPromptStream(initialMessages) {
  const queue = [...initialMessages];
  let closed = false;
  let notify = null;
  const wake = () => {
    if (notify) {
      const resolve = notify;
      notify = null;
      resolve();
    }
  };
  return {
    push(message) {
      if (closed) return false;
      queue.push(message);
      wake();
      return true;
    },
    release() {
      if (closed) return;
      closed = true;
      wake();
    },
    stream: (async function* () {
      while (true) {
        while (!closed && queue.length > 0) {
          yield queue.shift();
        }
        if (closed) return;
        await new Promise(resolve => { notify = resolve; });
      }
    })(),
  };
}

function mergeUsage(prev, next) {
  if (!next || typeof next !== 'object') return prev;
  if (!prev) return { ...next };
  const merged = { ...prev };
  for (const key of [
    'input_tokens',
    'output_tokens',
    'cache_read_tokens',
    'cache_creation_tokens',
    'cache_read_input_tokens',
    'cache_creation_input_tokens',
    'thinking_tokens',
    'total_tokens',
  ]) {
    const a = Number(prev[key]);
    const b = Number(next[key]);
    if (Number.isFinite(a) || Number.isFinite(b)) {
      merged[key] = (Number.isFinite(a) ? a : 0) + (Number.isFinite(b) ? b : 0);
    }
  }
  return merged;
}

async function run() {
  const lineReader = readJsonLines(process.stdin);
  const firstLine = await lineReader.next();
  if (firstLine.done || !firstLine.value) {
    throw new Error('Missing initial claude-agy payload on stdin');
  }
  const input = JSON.parse(firstLine.value);
  const pendingInjectedUuids = new Set();
  const injectedUuids = new Set();
  const armorEscalationUuids = new Set();
  const useArmor = input.useArmor === true;
  const armorEscalations = Array.isArray(input.armorEscalations) ? input.armorEscalations : [];
  let armorAttempt = 0;
  let acceptingInput = true;
  let finished = false;
  let terminalError = '';
  const heldPrompt = createHeldPromptStream([{
    type: 'user',
    uuid: randomUUID(),
    message: { role: 'user', content: input.prompt },
    parent_tool_use_id: null,
    timestamp: new Date().toISOString(),
  }]);

  // Keep listening on stdin for mid-turn user follow-up messages so they are
  // pushed into the running Claude Code process immediately without aborting.
  const stdinLoop = (async () => {
    try {
      for await (const rawLine of lineReader) {
        let msg;
        try {
          msg = JSON.parse(rawLine);
        } catch {
          continue;
        }
        if (!msg || typeof msg !== 'object') continue;
        if (msg.type === 'close_input') {
          acceptingInput = false;
          continue;
        }
        if (msg.type === 'user_message') {
          const msgUuid = typeof msg.uuid === 'string' && msg.uuid.trim() ? msg.uuid.trim() : randomUUID();
          const content = typeof msg.content === 'string' ? msg.content : '';
          if (!acceptingInput || finished || terminalError || !content.trim()) {
            emit({ event: 'inject_rejected', uuid: msgUuid });
            continue;
          }
          pendingInjectedUuids.add(msgUuid);
          injectedUuids.add(msgUuid);
          const pushed = heldPrompt.push({
            type: 'user',
            uuid: msgUuid,
            message: { role: 'user', content },
            parent_tool_use_id: null,
            timestamp: new Date().toISOString(),
          });
          if (pushed) {
            emit({ event: 'user_message_queued', uuid: msgUuid });
          } else {
            pendingInjectedUuids.delete(msgUuid);
            injectedUuids.delete(msgUuid);
            emit({ event: 'inject_rejected', uuid: msgUuid });
          }
        }
      }
    } catch (err) {
      if (!finished) {
        process.stderr.write('[claude-agy] stdin reader error: ' + (err?.message || String(err)) + '\n');
      }
    }
  })();
  void stdinLoop;

  const load = createRequire(path.join(process.env.MINTCLI_REPO, 'package.json'));
  const { query } = await import(pathToFileURL(load.resolve('@anthropic-ai/claude-agent-sdk')));
  const pluginFile = path.join(process.env.MINTCLI_MAGPIE_AGY, 'index.mjs');
  const { default: plugin } = await import(pathToFileURL(pluginFile));
  const host = await plugin.server();
  const adapter = await host.auth.loader(async () => ({ key: 'agy' }));
  const secret = randomBytes(32).toString('hex');
  const controller = new AbortController();
  let lastUpstreamError = '';
  const agyTrace = {
    sessions: new Set(),
    responseIds: new Set(),
    traceIds: new Set(),
    upstreamUrls: new Set(),
  };
  const scannedLogs = new Map();
  let lastTraceCount = 0;

  const flushAgyTrace = (force = false) => {
    scanAgyAcpLogs(process.env.TMPDIR, agyTrace, scannedLogs);
    // All four sets only grow. Equal totals mean the snapshot is unchanged.
    const count = agyTrace.sessions.size + agyTrace.responseIds.size +
      agyTrace.traceIds.size + agyTrace.upstreamUrls.size;
    if (!count || (!force && count === lastTraceCount)) return;
    lastTraceCount = count;
    emit({
      event: 'agy_trace',
      session_ids: [...agyTrace.sessions],
      response_ids: [...agyTrace.responseIds],
      trace_ids: [...agyTrace.traceIds],
      upstream_urls: [...agyTrace.upstreamUrls],
    });
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
    // Full-project test runs can start several multi-gigabyte workers.
    VITEST_MAX_FORKS: '1',
    VITEST_MAX_THREADS: '1',
    HOME: input.claudeHome,
    CLAUDE_CONFIG_DIR: input.claudeHome,
    CLAUDE_CODE_ARTIFACT: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1',
    ANTHROPIC_API_KEY: secret,
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:' + server.address().port,
  };
  if (GEMINI_NEON_MODEL_RE.test(input.model)) {
    // Antigravity offers a 512K window for Neon. Declare it to Claude Code
    // so the fallback window for unknown model IDs doesn't compact early.
    env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = GEMINI_NEON_CONTEXT_WINDOW;
  }
  let hasPartialText = false;
  let hasPartialThinking = false;
  let emittedText = '';
  let needsTextSeparator = false;
  let emittedThinking = false;
  let needsThinkingSeparator = false;
  let toolSeq = 0;
  let sawSegmentToolUse = false;
  let armorBuffer = '';
  let armorTailHold = '';
  let armorFlushed = !useArmor;
  let armorRefused = false;
  let accumulatedUsage = null;
  let totalDurationMs = 0;
  let hasDuration = false;

  const resetSegmentOutput = () => {
    hasPartialText = false;
    hasPartialThinking = false;
    emittedText = '';
    needsTextSeparator = false;
    emittedThinking = false;
    needsThinkingSeparator = false;
    sawSegmentToolUse = false;
    armorBuffer = '';
    armorTailHold = '';
    armorFlushed = !useArmor;
    armorRefused = false;
  };

  const pushVerifiedDelta = text => {
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

  const rawEmitText = text => {
    if (!text) return;
    if (!useArmor) {
      pushVerifiedDelta(text);
      return;
    }
    const [flushNow, keepHold] = splitTailDisclaimer(emittedText, armorTailHold + text);
    armorTailHold = keepHold;
    if (flushNow) pushVerifiedDelta(flushNow);
  };

  const emitText = text => {
    if (!text) return;
    if (!armorFlushed) {
      armorBuffer += text;
      const action = sawSegmentToolUse ? 'flush' : armorGateDecision(armorBuffer, false);
      if (action === 'flush') {
        armorFlushed = true;
        const flushed = armorBuffer;
        armorBuffer = '';
        rawEmitText(flushed);
      } else if (action === 'retry' && armorAttempt < armorEscalations.length) {
        armorFlushed = true;
        armorRefused = true;
        armorBuffer = '';
        armorTailHold = '';
      } else if (action === 'retry') {
        armorFlushed = true;
        const flushed = armorBuffer;
        armorBuffer = '';
        rawEmitText(flushed);
      }
      return;
    }
    if (!armorRefused) {
      rawEmitText(text);
    }
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
      prompt: heldPrompt.stream,
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
        extraArgs: { 'replay-user-messages': null },
        ...(input.sandbox ? { sandbox: {
          enabled: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false,
        } } : {}),
      },
    });
    for await (const item of turn) {
      if (item.type === 'stream_event') {
        if (item.event?.type === 'content_block_start' && item.event.content_block?.type === 'tool_use') {
          sawSegmentToolUse = true;
          if (!armorFlushed && armorBuffer) {
            armorFlushed = true;
            const flushed = armorBuffer;
            armorBuffer = '';
            rawEmitText(flushed);
          }
          if (emittedText) needsTextSeparator = true;
          if (emittedThinking) needsThinkingSeparator = true;
        } else if (item.event?.type === 'content_block_delta') {
          const delta = item.event.delta;
          if (delta?.type === 'text_delta' && delta.text) {
            hasPartialText = true;
            emitText(delta.text);
          } else if (delta?.type === 'thinking_delta' && delta.thinking) {
            hasPartialThinking = true;
            emitThinking(delta.thinking);
          }
        }
      } else if (item.type === 'assistant') {
        for (const block of item.message?.content || []) {
          if (block.type === 'tool_use') {
            sawSegmentToolUse = true;
            if (!armorFlushed && armorBuffer) {
              armorFlushed = true;
              const flushed = armorBuffer;
              armorBuffer = '';
              rawEmitText(flushed);
            }
            if (emittedText) needsTextSeparator = true;
            if (emittedThinking) needsThinkingSeparator = true;
            const toolId = String(block.id || `tool_${++toolSeq}`);
            const toolName = String(block.name || 'Tool');
            const toolInput = block.input && typeof block.input === 'object' ? block.input : (block.input ?? {});
            emit({
              event: 'tool',
              tool: formatToolLabel(toolName, toolInput),
              tool_id: toolId,
              tool_name: toolName,
              tool_input: toolInput,
              status: 'running',
            });
          } else if (block.type === 'text' && block.text && !hasPartialText) {
            emitText(block.text);
          } else if (block.type === 'thinking' && block.thinking && !hasPartialThinking) {
            emitThinking(block.thinking);
          }
        }
        if (emittedText) needsTextSeparator = true;
        if (emittedThinking) needsThinkingSeparator = true;
        hasPartialText = false;
        hasPartialThinking = false;
      } else if (item.type === 'user') {
        if (item.isReplay === true) {
          if (typeof item.uuid === 'string' && armorEscalationUuids.has(item.uuid)) {
            pendingInjectedUuids.delete(item.uuid);
            armorEscalationUuids.delete(item.uuid);
            resetSegmentOutput();
          } else if (typeof item.uuid === 'string' && injectedUuids.has(item.uuid)) {
            pendingInjectedUuids.delete(item.uuid);
            injectedUuids.delete(item.uuid);
            resetSegmentOutput();
            emit({ event: 'user_message_applied', uuid: item.uuid });
          }
          continue;
        }
        const blocks = Array.isArray(item.message?.content) ? item.message.content : [];
        const structuredResult = sanitizeToolUseResult(item.tool_use_result ?? item.toolUseResult);
        for (const block of blocks) {
          if (block?.type === 'tool_result') {
            emit({
              event: 'tool_result',
              tool_id: String(block.tool_use_id || block.toolId || ''),
              content: formatToolResultContent(block.content),
              is_error: Boolean(block.is_error),
              ...(structuredResult !== undefined ? { tool_use_result: structuredResult } : {}),
            });
          }
        }
      } else if (item.type === 'result') {
        accumulatedUsage = mergeUsage(accumulatedUsage, normalizeUsage(item.usage));
        if (typeof item.duration_ms === 'number' && Number.isFinite(item.duration_ms)) {
          totalDurationMs += item.duration_ms;
          hasDuration = true;
        }
        if (!armorFlushed && armorBuffer) {
          const pendingBuf = armorBuffer;
          armorBuffer = '';
          armorFlushed = true;
          if (!sawSegmentToolUse && armorGateDecision(pendingBuf, true) === 'retry' && armorAttempt < armorEscalations.length) {
            armorRefused = true;
            armorTailHold = '';
          } else {
            rawEmitText(pendingBuf);
          }
        }
        if (armorTailHold && !armorRefused) {
          const combined = emittedText + armorTailHold;
          const [cleaned, stripped] = stripFinalTailDisclaimer(combined);
          if (stripped) {
            emittedText = cleaned;
          } else {
            pushVerifiedDelta(armorTailHold);
          }
          armorTailHold = '';
        }
        if (
          useArmor &&
          !item.is_error &&
          !terminalError &&
          pendingInjectedUuids.size === 0 &&
          !sawSegmentToolUse &&
          (armorRefused || (!emittedText && typeof item.result === 'string' && isArmorRefusal(item.result))) &&
          armorAttempt < armorEscalations.length
        ) {
          const escalationUuid = randomUUID();
          const escalationContent = armorEscalations[armorAttempt];
          const pushed = heldPrompt.push({
            type: 'user',
            uuid: escalationUuid,
            message: { role: 'user', content: escalationContent },
            parent_tool_use_id: null,
            timestamp: new Date().toISOString(),
          });
          if (pushed) {
            pendingInjectedUuids.add(escalationUuid);
            armorEscalationUuids.add(escalationUuid);
            armorAttempt += 1;
            emit({
              event: 'thinking',
              thinking: `\n[🛡️ Antigravity Armor] 检测到模型拒答前言，已拦截并启动第 ${armorAttempt}/${armorEscalations.length} 档强制交付...\n`,
            });
            emit({ event: 'armor_status', status: 'escalated', retries: armorAttempt });
            resetSegmentOutput();
            continue;
          }
        }
        if (!item.is_error && !terminalError && pendingInjectedUuids.size > 0) {
          resetSegmentOutput();
          continue;
        }
        acceptingInput = false;
        finished = true;
        heldPrompt.release();
        flushAgyTrace(true);
        if (item.is_error || terminalError) {
          if (item.is_error && item.result) {
            process.stderr.write('[claude-agy] SDK error result: ' + String(item.result).slice(0, 1000) + '\n');
          }
          emit({ event: 'error', error: terminalError || lastUpstreamError || 'Claude Code 未能完成这条回复。' });
        } else {
          const responseText = emittedText || (armorRefused ? '' : item.result) || '';
          if (useArmor) {
            emit({
              event: 'armor_status',
              status: armorAttempt > 0 && responseText ? 'recovered' : 'delivered',
              retries: armorAttempt,
            });
          }
          emit({
            event: 'result',
            response: responseText,
            usage: accumulatedUsage,
            duration_seconds: hasDuration ? totalDurationMs / 1000 : null,
          });
        }
        break;
      }
    }
    if (!finished) {
      flushAgyTrace(true);
      emit({ event: 'error', error: 'Claude Code 已退出，未返回生成结果。' });
    }
  } finally {
    acceptingInput = false;
    finished = true;
    heldPrompt.release();
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
