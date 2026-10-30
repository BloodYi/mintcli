import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { readResponseCapture } from './response-capture.service.js';

import type { AnyRecord as Row } from '@/shared/index.js';
const cache = new Map<string, { key: string; value: { projected: string; recordedModels: string[]; reportedModels: string[] } }>();

/** Used by the monitor service to summarize entire indexed transcripts without loading reply/tool bodies. */
export async function readSessionHistory(sessionId: string, filePath: string) {
  const info = await stat(filePath);
  const captures = await readResponseCapture(sessionId);
  const key = `${info.size}:${info.mtimeMs}:${captures.at(-1)?.timestamp}`;
  const cacheId = sessionId + '\0' + filePath;
  const previous = cache.get(cacheId);
  if (previous?.key === key) return previous.value;
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
      if (row.type === 'turn_context') add(recorded, payload.model);
      const message = row.type === 'assistant' ? row.message : row.type === 'monitor_response' ? payload
        : row.type === 'response_item' && payload.role === 'assistant' ? payload : null;
      if (message) add(reported, message.model);
      // Retain usage, identifiers and prompt boundaries needed by the upstream deduplicator.
      // Never accumulate transcript text, base64 attachments, tool arguments or reasoning.
      if (row.type === 'event_msg' && payload.type === 'token_count') projected.push(JSON.stringify({ type: row.type, timestamp: row.timestamp, payload }));
      else if (row.type === 'monitor_response') projected.push(JSON.stringify({ type: row.type, timestamp: row.timestamp, payload: { id: payload.id, usage: payload.usage } }));
      else if (row.type === 'assistant') projected.push(JSON.stringify({ type: row.type, uuid: row.uuid, timestamp: row.timestamp,
        message: { id: message?.id, model: message?.model, usage: message?.usage, content: [] } }));
    }
  } finally { lines.close(); stream.destroy(); }
  for (const capture of captures) add(reported, capture.model);
  const value = { projected: projected.join('\n'), recordedModels: [...recorded], reportedModels: [...reported] };
  if (cache.size >= 256) cache.delete(cache.keys().next().value!);
  cache.set(cacheId, { key, value });
  return value;
}
