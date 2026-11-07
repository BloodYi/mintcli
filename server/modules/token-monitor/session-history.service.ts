import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { readResponseCapture } from './response-capture.service.js';

import type { ReplyModelEvidence, AnyRecord as Row } from '@/shared/index.js';
const cache = new Map<string, { key: string; value: { projected: string; recordedModels: string[]; reportedModels: string[]; replyModels: ReplyModelEvidence[] } }>();

/** Used by the monitor service to summarize entire indexed transcripts without loading reply/tool bodies. */
export async function readSessionHistory(sessionId: string, filePath: string, provider = 'codex') {
  const info = await stat(filePath);
  const allCaptures = await readResponseCapture(sessionId);
  const captures = provider === 'codex' ? allCaptures : [];
  const key = `${provider}:${info.size}:${info.mtimeMs}:${allCaptures.length}:${allCaptures.at(-1)?.timestamp}`;
  const cacheId = sessionId + '\0' + filePath;
  const previous = cache.get(cacheId);
  if (previous?.key === key) return previous.value;
  const replyModels: ReplyModelEvidence[] = [];
  const byItem = new Map(captures.flatMap(record => (record.itemIds || []).map(id => [id, record] as const)));
  const newest = [...captures].reverse();
  let requestedModel: string | null = null;
  const contexts: { timestamp: number; model: string | null }[] = [];
  const name = (value: unknown): string | null => typeof value === 'string' && value.trim() && value.length <= 256 && !value.startsWith('<') ? value : null;
  const recorded = new Set<string>();
  const reported = new Set<string>();
  const projected: string[] = [];
  const add = (set: Set<string>, value: unknown) => { if (typeof value === 'string' && value.trim() && value.length <= 256) set.add(value); };
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      let row: Row;
      try { row = JSON.parse(line); } catch { continue; }
      if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
      const payload = row.payload || {};
      if (row.type === 'turn_context') { add(recorded, payload.model); requestedModel = name(payload.model); contexts.push({ timestamp: Date.parse(row.timestamp), model: requestedModel }); }
      const message = row.type === 'assistant' ? row.message : row.type === 'monitor_response' ? payload
        : row.type === 'response_item' && payload.role === 'assistant' ? payload : null;
      if (message) {
        add(reported, message.model);
        const observed = byItem.get(message.id) || newest.find(record => Date.parse(record.timestamp) <= Date.parse(row.timestamp));
        const aliases = [message.id, row.uuid].filter((id): id is string => typeof id === 'string' && !!id);
        if (observed?.kind === 'response') aliases.push(...(observed.itemIds || []));
        if (Array.isArray(message.content) && row.uuid) message.content.forEach((part: Row, index: number) => {
          if (part.type === 'text') aliases.push(`${row.uuid}_${index}`);
        });
        replyModels.push({ messageIds: [...new Set(aliases)], timestamp: row.timestamp || '',
          requestedModel: name(row.requestedModel) || requestedModel,
          reportedModel: name(message.model) || observed?.model || null });
      }
      // Retain usage, identifiers and prompt boundaries needed by the upstream deduplicator.
      // Never accumulate transcript text, base64 attachments, tool arguments or reasoning.
      if (row.type === 'event_msg' && payload.type === 'token_count') projected.push(JSON.stringify({ type: row.type, timestamp: row.timestamp, payload }));
      else if (row.type === 'monitor_response') projected.push(JSON.stringify({ type: row.type, timestamp: row.timestamp, payload: { id: payload.id, usage: payload.usage } }));
      else if (row.type === 'assistant') projected.push(JSON.stringify({ type: row.type, uuid: row.uuid, timestamp: row.timestamp,
        message: { id: message?.id, model: message?.model, usage: message?.usage, content: [] } }));
    }
  } finally { lines.close(); stream.destroy(); }
  const joined = new Set(replyModels.flatMap(record => record.messageIds));
  // Preserve the existing cross-engine history summary, while only Codex
  // annotations may join the Codex HTTP captures to individual replies.
  for (const capture of allCaptures) add(reported, capture.model);
  for (const capture of captures) {
    if (capture.kind !== 'response') continue;
    const ids = (capture.itemIds || []).filter(id => !joined.has(id));
    if (!ids.length) continue;
    const context = [...contexts].reverse().find(value => value.timestamp <= Date.parse(capture.timestamp));
    replyModels.push({ messageIds: ids, timestamp: capture.timestamp, requestedModel: context?.model || null, reportedModel: name(capture.model) });
    ids.forEach(id => joined.add(id));
  }
  const value = { projected: projected.join('\n'), recordedModels: [...recorded], reportedModels: [...reported], replyModels };
  if (cache.size >= 256) cache.delete(cache.keys().next().value!);
  cache.set(cacheId, { key, value });
  return value;
}
