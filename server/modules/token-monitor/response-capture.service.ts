import { createServer } from 'node:http';
import { open } from 'node:fs/promises';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function responseCapturePath(sessionId: string): string {
  return path.join(os.homedir(), '.claude-code-ui', 'token-monitor', encodeURIComponent(sessionId) + '.jsonl');
}

/** Used by Codex runtime to observe response model labels without persisting prompts, headers or reasoning. */
export async function startResponseCapture(upstream: string, sessionId: string | undefined) {
  const secret = randomUUID();
  const prefix = '/' + secret;
  const turnId = randomUUID();
  const persist = (value: Record<string, unknown>) => {
    if (!sessionId) return;
    try {
      const file = responseCapturePath(sessionId);
      mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      appendFileSync(file, JSON.stringify({ timestamp: new Date().toISOString(), turnId, ...value }) + '\n', { mode: 0o600 });
    } catch { /* Monitoring storage must not break a running conversation. */ }
  };
  persist({ kind: 'turn', model: null });
  const server = createServer(async (request, reply) => {
    if (!request.url?.startsWith(prefix + '/')) { reply.writeHead(404).end(); return; }
    const suffix = request.url.slice(prefix.length);
    // This listener is a per-turn relay to one fixed endpoint, never an open proxy.
    if (!/^\/responses(?:\/(?:compact|input_tokens))?(?:\?|$)/.test(suffix)) { reply.writeHead(404).end(); return; }
    const controller = new AbortController();
    reply.on('close', () => { if (!reply.writableEnded) controller.abort(); });
    try {
      const headers = new Headers();
      for (const [key, value] of Object.entries(request.headers)) {
        if (!['host', 'connection', 'transfer-encoding', 'accept-encoding'].includes(key) && value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
      }
      const response = await fetch(upstream.replace(/\/$/, '') + suffix, {
        method: request.method, headers, body: request.method === 'GET' ? undefined : request,
        duplex: 'half', signal: controller.signal, redirect: 'manual',
      } as RequestInit & { duplex: string });
      const outgoing: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        if (!['connection', 'content-length', 'content-encoding', 'transfer-encoding'].includes(key)) outgoing[key] = value;
      });
      reply.writeHead(response.status, outgoing);
      const contentType = (response.headers.get('content-type') || '').toLowerCase();
      let format = contentType.includes('text/event-stream') ? 'sse' : contentType.includes('application/json') ? 'json' : 'unknown';
      const decoder = new TextDecoder();
      let pending = '', oversized = false;
      const models = new Map<string, string>();
      const observe = (text: string) => {
        try {
          const event = JSON.parse(text);
          const data = event.response || (event.object === 'response' ? event : null);
          if (!data || typeof data.id !== 'string' || data.id.length > 256) return;
          const model = typeof data.model === 'string' && data.model.trim() && data.model.length <= 256 ? data.model : models.get(data.id) || null;
          if (model) models.set(data.id, model);
          persist({ kind: 'response', id: data.id, model,
            itemIds: Array.isArray(data.output) ? data.output.map((item: { id?: unknown }) => item.id).filter((id: unknown) => typeof id === 'string').slice(0, 256) : [] });
        } catch { /* An unsupported provider event never changes the response stream. */ }
      };
      if (response.body) for await (const chunk of response.body) {
        if (response.ok) {
          pending += decoder.decode(chunk, { stream: true });
          // Some Codex backends omit Content-Type. Sniff only the protocol prefix;
          // the original bytes still reach the CLI unchanged. Wait across split prefixes.
          if (format === 'unknown') {
            const prefix = pending.trimStart();
            if (/^(?:data:|event:|:)/.test(prefix)) format = 'sse';
            else if (prefix.startsWith('{')) format = 'json';
          }
          if (format === 'sse') {
            const lines = pending.split('\n'); pending = lines.pop() || '';
            for (const line of lines) {
              if (!oversized && line.startsWith('data:')) observe(line.slice(5).trim());
              oversized = false;
            }
          }
          // Pass oversized events through while bounding the observer's memory.
          if (pending.length > 4 * 1024 * 1024) { pending = ''; oversized = true; }
        }
        if (!reply.write(chunk)) await once(reply, 'drain', { signal: controller.signal });
      }
      pending += decoder.decode();
      if (!oversized && response.ok) {
        if (format === 'json') observe(pending);
        else if (format === 'sse' && pending.startsWith('data:')) observe(pending.slice(5).trim());
      }
      reply.end();
    } catch {
      if (!reply.headersSent) reply.writeHead(502, { 'content-type': 'application/json' }).end('{"error":{"message":"Response relay unavailable"}}');
      else reply.destroy();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Response monitor listener unavailable');
  return { baseUrl: `http://127.0.0.1:${address.port}${prefix}`, close: async () => {
    persist({ kind: 'end', model: null });
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  } };
}

/** Used by the snapshot service to join bounded response metadata with native transcripts. */
export async function readResponseCapture(sessionId: string) {
  const records: { timestamp: string; turnId: string; kind: string; id?: string; model: string | null; itemIds?: string[] }[] = [];
  try {
    const file = await open(responseCapturePath(sessionId), 'r');
    let text: string;
    try {
      const { size } = await file.stat();
      const buffer = Buffer.alloc(Math.min(size, 4 * 1024 * 1024));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, Math.max(0, size - buffer.length));
      text = buffer.subarray(0, bytesRead).toString('utf8');
      if (size > buffer.length) text = text.slice(text.indexOf('\n') + 1);
    } finally { await file.close(); }
    for (const line of text.split('\n')) {
      try { const row = JSON.parse(line); if (row.kind === 'turn' || row.kind === 'response' || row.kind === 'end') records.push(row); } catch { /* Ignore incomplete records. */ }
    }
  } catch { /* Older sessions have no captured HTTP metadata. */ }
  return records;
}
