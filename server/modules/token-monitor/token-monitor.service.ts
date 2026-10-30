import { readSessionHistory } from './session-history.service.js';
import { readAntigravityMonitor } from './antigravity-monitor.service.js';
import { readResponseCapture } from './response-capture.service.js';
import { open, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { sessionsDb } from '@/modules/database/index.js';
import { AppError, findApplicationRoot, getModuleDirectory } from '@/shared/index.js';

import type { AnyRecord as Row } from '@/shared/index.js';
type Tokens = { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number; total: number };
type UsageEvent = { kind: string; timestamp: string; tokens?: Tokens };
const appRoot = findApplicationRoot(getModuleDirectory(import.meta.url));
const vendorRoot = path.join(appRoot, 'plugins/token-monitor/vendor');
const parser = createRequire(import.meta.url)(path.join(vendorRoot, 'session-detail.cjs')) as {
  parseCodexTranscript(text: string): UsageEvent[];
  parseClaudeTranscript(text: string): UsageEvent[];
};
const provenance = JSON.parse(await readFile(path.join(vendorRoot, 'provenance.json'), 'utf8')) as { version: string; commit: string; repository: string };
const MAX_BYTES = 4 * 1024 * 1024;

function number(value: unknown) { return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0; }
function codexTokens(value: Row): Tokens {
  const cacheRead = number(value.cached_input_tokens ?? value.input_tokens_details?.cached_tokens);
  const output = number(value.output_tokens ?? value.completion_tokens);
  const input = number(value.input_tokens ?? value.prompt_tokens);
  return { input: Math.max(0, input - cacheRead), output, cacheRead, cacheWrite: 0,
    reasoning: number(value.reasoning_output_tokens ?? value.output_tokens_details?.reasoning_tokens), total: input + output };
}
function textContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  // Only text actually returned to the user; tool payloads and private reasoning are not replies.
  return value.filter(part => part?.type === 'text' || part?.type === 'output_text').map(part => part.text || '').join('\n');
}
function usageFields(value: Row): Row {
  const result: Row = {};
  for (const [key, field] of Object.entries(value)) {
    if (typeof field === 'number' && /(?:tokens|input|output)/.test(key) && Number.isFinite(field)) result[key] = field;
    else if (field && typeof field === 'object' && !Array.isArray(field) && /(?:tokens_details)/.test(key)) {
      result[key] = Object.fromEntries(Object.entries(field).filter(([, item]) => typeof item === 'number' && Number.isFinite(item)));
    }
  }
  return result;
}
function sumTokens(events: UsageEvent[]): Tokens {
  const total: Tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0 };
  for (const event of events) if (event.tokens) for (const key of Object.keys(total) as (keyof Tokens)[]) total[key] += event.tokens[key];
  return total;
}

/** Used by monitoring routes and focused tests; reads only DB-indexed transcripts, never caller-supplied paths. */
export function createTokenMonitorService(dependencies: { getSession: (id: string) => Row | null; listSessions?: () => Row[] } = { getSession: (id: string) => sessionsDb.getSessionById(id), listSessions: () => sessionsDb.getMonitorSessions() }) {
  // Coalesce release checks across tabs and users; network failure is cached briefly, not reported as up-to-date.
  let releaseCache: { expires: number; value: Row } | null = null;
  let releasePending: Promise<Row> | null = null;
  return {
    async sessions() {
      const sessions = (dependencies.listSessions?.() || []).slice();
      const results: Row[] = [];
      // Bound disk/network concurrency; a broken or unreadable conversation must not hide the rest.
      for (let offset = 0; offset < sessions.length; offset += 3) {
        results.push(...await Promise.all(sessions.slice(offset, offset + 3).map(async session => {
          const base = { sessionId: session.session_id, provider: session.provider, title: session.custom_name || session.session_id,
            projectPath: session.project_path, archived: Boolean(session.isArchived), updatedAt: session.updated_at,
            configuredModel: session.model || null };
          try {
            if (session.provider === 'antigravity') {
              const snapshot = await readAntigravityMonitor(session);
              return { ...base, status: snapshot.status, recordedModels: snapshot.recordedModels, reportedModels: snapshot.reportedModels,
                returnedModel: snapshot.returnedModel, totals: snapshot.totals, totalsScope: snapshot.totalsScope };
            }
            if (!['codex', 'claude'].includes(session.provider) || !session.jsonl_path) throw new Error('unavailable');
            const history = await readSessionHistory(session.session_id, session.jsonl_path);
            const events = session.provider === 'codex' ? parser.parseCodexTranscript(history.projected) : parser.parseClaudeTranscript(history.projected);
            let cumulative: Tokens | null = null;
            if (session.provider === 'codex') for (const line of history.projected.split('\n')) {
              if (!line) continue;
              const row = JSON.parse(line); if (row.payload?.info?.total_token_usage) cumulative = codexTokens(row.payload.info.total_token_usage);
            }
            const usage = events.filter(event => event.kind === 'turn' && event.tokens);
            return { ...base, status: 'ok', recordedModels: history.recordedModels, reportedModels: history.reportedModels,
              totals: cumulative || (usage.length ? sumTokens(usage) : null), totalsScope: 'session' };
          } catch {
            return { ...base, status: 'unavailable', recordedModels: [], reportedModels: [], totals: null, totalsScope: 'unavailable' };
          }
        })));
      }
      return { sessions: results, checkedAt: Date.now() };
    },
    async updates() {
      if (releaseCache && releaseCache.expires > Date.now()) return releaseCache.value;
      if (releasePending) return releasePending;
      releasePending = (async () => {
        const checkedAt = Date.now();
        let value: Row;
        try {
          const response = await fetch('https://api.github.com/repos/Javis603/token-monitor/releases/latest', {
            headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'mintcli-token-monitor' }, signal: AbortSignal.timeout(10000), redirect: 'error',
          });
          if (!response.ok) throw new Error('release check failed');
          const body = await response.json() as Row;
          const latestVersion = typeof body.tag_name === 'string' ? body.tag_name.replace(/^v/, '') : '';
          if (!/^\d+\.\d+\.\d+(?:[-+].*)?$/.test(latestVersion)) throw new Error('invalid release');
          const a = latestVersion.split('.').map(Number), b = provenance.version.split('.').map(Number);
          const newer = a[0] > b[0] || a[0] === b[0] && (a[1] > b[1] || a[1] === b[1] && a[2] > b[2]);
          value = { checkedAt, installedVersion: provenance.version, latestVersion, updateAvailable: newer, status: 'ok', url: provenance.repository + '/releases/latest' };
        } catch {
          value = { checkedAt, installedVersion: provenance.version, latestVersion: null, updateAvailable: false, status: 'unavailable', url: provenance.repository + '/releases' };
        }
        releaseCache = { value, expires: Date.now() + (value.status === 'ok' ? 6 * 3600000 : 300000) };
        return value;
      })().finally(() => { releasePending = null; });
      return releasePending;
    },
    async snapshot(sessionId: string) {
      const session = dependencies.getSession(sessionId);
      if (!session) throw new AppError('Session not found', { code: 'SESSION_NOT_FOUND', statusCode: 404 });
      const base = { sessionId, provider: session.provider, configuredModel: session.model || null, checkedAt: Date.now(), returnedModel: null as string | null };
      if (session.provider === 'antigravity') {
        try { return await readAntigravityMonitor({ ...session, session_id: sessionId }); }
        catch { return { ...base, status: 'unavailable', reason: 'AGY 原始记录暂不可读，稍后重试', replies: [], usage: [], totals: null, limited: false, alerts: [] }; }
      }
      if (!['codex', 'claude'].includes(session.provider) || !session.jsonl_path) {
        return { ...base, status: 'unavailable', reason: '此提供商尚未提供可读取的原始回复与用量记录', replies: [], usage: [], totals: null, limited: false, alerts: [] };
      }
      let content: string, limited: boolean;
      try {
        const file = await open(session.jsonl_path, 'r');
        try {
          const { size } = await file.stat();
          limited = size > MAX_BYTES;
          const buffer = Buffer.alloc(Math.min(size, MAX_BYTES));
          const { bytesRead } = await file.read(buffer, 0, buffer.length, Math.max(0, size - MAX_BYTES));
          content = buffer.subarray(0, bytesRead).toString('utf8');
          if (limited) content = content.slice(content.indexOf('\n') + 1);
        } finally { await file.close(); }
      } catch {
        return { ...base, status: 'unavailable', reason: '原始记录尚未生成或暂不可读，稍后自动重试', replies: [], usage: [], totals: null, limited: false, alerts: [] };
      }
      const rows: Row[] = [];
      for (const line of content.split('\n')) { try { if (line.trim()) { const value = JSON.parse(line); if (value && typeof value === 'object' && !Array.isArray(value)) rows.push(value); } } catch { /* A writer may not have finished the trailing row. */ } }
      const captured = session.provider === 'codex' ? await readResponseCapture(sessionId) : [];
      const newestCaptured = [...captured].reverse();
      const replies = new Map<string, { id: string; timestamp: string; model: string | null; content: string; raw: Row; truncated: boolean }>();
      const seenRows = new Set<string>();
      const seenBlocks = new Set<string>();
      let cumulative: Tokens | null = null;
      let lastError: string | null = null;
      for (const [index, row] of rows.entries()) {
        if (typeof row.uuid === 'string') { if (seenRows.has(row.uuid)) continue; seenRows.add(row.uuid); }
        const payload = row.payload || {};
        if (row.type === 'event_msg' && payload.type === 'token_count' && payload.info?.total_token_usage) cumulative = codexTokens(payload.info.total_token_usage);
        if (row.type === 'monitor_error') lastError = '接口请求失败，请检查接口地址、授权或协议是否需要更新';
        if (row.type === 'monitor_response') lastError = null;
        const message = row.type === 'assistant' ? row.message
          : row.type === 'response_item' && payload.role === 'assistant' ? payload
          : row.type === 'monitor_response' ? payload : null;
        if (!message) continue;
        // A turn_context.model is the requested model. Only response records may establish returnedModel.
        const observed = newestCaptured.find(record => record.kind === 'response' && record.itemIds?.includes(message.id))
          || newestCaptured.find(record => Date.parse(record.timestamp) <= Date.parse(row.timestamp));
        const model = typeof message.model === 'string' && message.model.trim() && message.model.length <= 256
          ? message.model : observed?.model || null;
        base.returnedModel = model;
        lastError = null;
        const text = textContent(message.content);
        if (!text && !model && !message.usage) continue;
        const id = typeof message.id === 'string' ? message.id : String(index);
        const blockKey = id + '\0' + text;
        if (seenBlocks.has(blockKey)) continue;
        seenBlocks.add(blockKey);
        const previous = replies.get(id);
        const fullContent = previous ? previous.content + (text && previous.content ? '\n' : '') + text : text;
        replies.set(id, { id, timestamp: row.timestamp || '', model, content: fullContent.slice(0, 100000),
          // A field allowlist keeps auth, request headers, tool arguments and reasoning out of the inspector.
          raw: { ...(message.id ? { id: message.id } : {}), ...(model ? { model } : {}),
            ...(message.usage ? { usage: usageFields(message.usage) } : {}), role: 'assistant', content: fullContent.slice(0, 100000) }, truncated: fullContent.length > 100000 });
      }
      // A new HTTP response may arrive before the CLI flushes its transcript.
      // A turn marker clears older labels when the current response has no model.
      const latestCapture = newestCaptured.find(record => record.kind !== 'end');
      const latestReply = [...replies.values()].at(-1);
      if (latestCapture && (!latestReply || Date.parse(latestCapture.timestamp) >= Date.parse(latestReply.timestamp))) base.returnedModel = latestCapture.model;
      const history = await readSessionHistory(sessionId, session.jsonl_path).catch(() => null);
      const events = session.provider === 'codex' ? parser.parseCodexTranscript(history?.projected || content) : parser.parseClaudeTranscript(history?.projected || content);
      if (history && session.provider === 'codex') for (const line of history.projected.split('\n')) {
        if (!line) continue;
        const row = JSON.parse(line); if (row.payload?.info?.total_token_usage) cumulative = codexTokens(row.payload.info.total_token_usage);
      }
      const usage = events.filter(event => event.kind === 'turn' && event.tokens);
      const alerts = lastError ? [lastError] : [];
      if (replies.size && !usage.length && !cumulative) alerts.push('回复记录未包含 token 用量；接口或 CLI 可能需要更新，请检查协议与版本');
      return { ...base, status: 'ok', replies: [...replies.values()].slice(-30).reverse(), usage: usage.slice(-60).reverse(),
        totals: cumulative || (usage.length ? sumTokens(usage) : null), limited, totalsScope: history || cumulative || !limited ? 'session' : 'recent', recordedModels: history?.recordedModels || [], reportedModels: history?.reportedModels || [], alerts };
    },
  };
}
/** Used by the token-monitor routes for the current server instance. */
export const tokenMonitorService = createTokenMonitorService();
