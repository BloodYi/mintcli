import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import {
  computeTokensPerSec,
  createCodexTimingTracker,
  parseMonitorTimestampMs,
} from './model-usage.service.js';
import { readResponseCapture } from './response-capture.service.js';

import type {
  AnyRecord as Row,
  MonitorTimedUsageEvent,
  MonitorTokens,
  ReplyModelEvidence,
} from '@/shared/index.js';

type CachedHistoryValue = {
  projected: string;
  recordedModels: string[];
  reportedModels: string[];
  replyModels: ReplyModelEvidence[];
  timedTurns: MonitorTimedUsageEvent[];
};

const cache = new Map<string, { key: string; value: CachedHistoryValue }>();

function safeCount(value: unknown): number {
  const num = Number(value);
  return Number.isFinite(num) && num >= 0 ? num : 0;
}

function makeDisjointTokens(fields: {
  input?: unknown;
  output?: unknown;
  cacheRead?: unknown;
  cacheWrite?: unknown;
  reasoning?: unknown;
}): MonitorTokens {
  const input = safeCount(fields.input);
  const output = safeCount(fields.output);
  const cacheRead = safeCount(fields.cacheRead);
  const cacheWrite = safeCount(fields.cacheWrite);
  const reasoning = safeCount(fields.reasoning);
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    reasoning,
    total: input + output + cacheRead + cacheWrite,
  };
}

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
  const timedTurns: MonitorTimedUsageEvent[] = [];
  const byItem = new Map(captures.flatMap(record => (record.itemIds || []).map(id => [id, record] as const)));
  const newest = [...captures].reverse();
  let requestedModel: string | null = null;
  const contexts: { timestamp: number; model: string | null }[] = [];
  const name = (value: unknown): string | null =>
    typeof value === 'string' && value.trim() && value.length <= 256 && !value.startsWith('<')
      ? value.trim()
      : null;
  const recorded = new Set<string>();
  const reported = new Set<string>();
  const projected: string[] = [];
  const add = (set: Set<string>, value: unknown) => {
    if (typeof value === 'string' && value.trim() && value.length <= 256 && !value.startsWith('<')) {
      set.add(value.trim());
    }
  };

  // Codex timing & turn-scoped response attribution state.
  const codexTiming = createCodexTimingTracker();
  let currentCodexReportedModel: string | null = null;
  let currentCodexReplyEvidence: ReplyModelEvidence | null = null;
  let pendingUnlabeledCodexTurn: MonitorTimedUsageEvent | null = null;
  let pendingCodexTools: string[] = [];
  let lastCodexTotalSig: string | null = null;

  // Claude deduplication & monotonic split-block timing state (adapted from Javis603/tokscale claudecode.rs).
  const seenClaudeLineUuids = new Set<string>();
  const claudeTurnsById = new Map<
    string,
    { startMs: number | null; event: MonitorTimedUsageEvent; evidence: ReplyModelEvidence | null }
  >();
  let pendingClaudeStartMs: number | null = null;

  const stream = createReadStream(filePath, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      let row: Row;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
      const payload = row.payload && typeof row.payload === 'object' ? (row.payload as Row) : {};

      if (provider === 'codex') {
        codexTiming.observe(String(row.type || ''), row.timestamp, payload, name);
        if (row.type === 'response_item' && ['function_call', 'custom_tool_call', 'tool_search_call'].includes(String(payload.type || ''))) {
          const toolName = String(payload.name || payload.tool_name || payload.tool || '');
          if (toolName) pendingCodexTools.push(toolName);
          const itemCapture = typeof payload.id === 'string' ? byItem.get(payload.id) : undefined;
          const itemModel = name(payload.model) || name(itemCapture?.model);
          if (itemModel) {
            add(reported, itemModel);
            currentCodexReportedModel = itemModel;
          }
        } else if (row.type === 'event_msg' && payload.type === 'mcp_tool_call_end') {
          const toolName = String(payload.name || payload.tool_name || payload.tool || '');
          if (toolName) pendingCodexTools.push(toolName);
        } else if (row.type === 'event_msg' && (payload.type === 'task_started' || payload.type === 'user_message' || payload.type === 'turn_aborted' || payload.type === 'task_complete')) {
          currentCodexReportedModel = null;
          currentCodexReplyEvidence = null;
          pendingUnlabeledCodexTurn = null;
          if (payload.type === 'user_message' || payload.type === 'task_started') pendingCodexTools = [];
        } else if (row.type === 'token_usage_record') {
          const recordModel = name(payload.model);
          if (recordModel) {
            add(reported, recordModel);
            currentCodexReportedModel = recordModel;
          }
        }
      }

      if (row.type === 'turn_context') {
        if (typeof payload.model === 'string' && payload.model.trim() && payload.model.length <= 256) {
          recorded.add(payload.model);
        }
        requestedModel = name(payload.model);
        contexts.push({ timestamp: Date.parse(row.timestamp), model: requestedModel });
        currentCodexReportedModel = null;
        currentCodexReplyEvidence = null;
        pendingUnlabeledCodexTurn = null;
      }

      if (provider === 'claude' && row.type === 'user') {
        const at = parseMonitorTimestampMs(row.timestamp);
        if (at !== null) pendingClaudeStartMs = at;
      }

      const message =
        row.type === 'assistant'
          ? row.message
          : row.type === 'monitor_response'
            ? payload
            : row.type === 'response_item' && payload.role === 'assistant'
              ? payload
              : null;

      let latestEvidence: ReplyModelEvidence | null = null;
      if (message) {
        if (typeof message.model === 'string' && message.model.trim() && message.model.length <= 256) {
          // Keep original reported set behavior for non-synthetic labels; synthetic '<...>' is ignored by `add`.
          add(reported, message.model);
        }
        const observed =
          byItem.get(message.id) || newest.find(record => Date.parse(record.timestamp) <= Date.parse(row.timestamp));
        const aliases = [message.id, row.uuid].filter((id): id is string => typeof id === 'string' && !!id);
        if (observed?.kind === 'response') aliases.push(...(observed.itemIds || []));
        if (Array.isArray(message.content) && row.uuid) {
          message.content.forEach((part: Row, index: number) => {
            if (part?.type === 'text') aliases.push(`${row.uuid}_${index}`);
          });
        }
        const resolvedReported = name(message.model) || name(observed?.model) || null;
        latestEvidence = {
          messageIds: [...new Set(aliases)],
          timestamp: row.timestamp || '',
          requestedModel: name(row.requestedModel) || requestedModel,
          reportedModel: resolvedReported,
        };
        replyModels.push(latestEvidence);

        if (provider === 'codex') {
          currentCodexReplyEvidence = latestEvidence;
          if (resolvedReported) {
            currentCodexReportedModel = resolvedReported;
            if (pendingUnlabeledCodexTurn && pendingUnlabeledCodexTurn.model === null) {
              pendingUnlabeledCodexTurn.model = resolvedReported;
            }
          }
          // Once an assistant item passes, never backfill an earlier token_count from a subsequent reply.
          pendingUnlabeledCodexTurn = null;
        }
      }

      // Codex turn usage & request timing.
      if (provider === 'codex' && row.type === 'event_msg' && payload.type === 'token_count') {
        const totalUsage =
          payload.info && typeof payload.info === 'object' && payload.info.total_token_usage
            ? (payload.info.total_token_usage as Row)
            : null;
        const totalSig = totalUsage
          ? `${safeCount(totalUsage.input_tokens)}:${safeCount(totalUsage.cached_input_tokens)}:${safeCount(totalUsage.cache_write_input_tokens)}:${safeCount(totalUsage.output_tokens)}:${safeCount(totalUsage.reasoning_output_tokens)}`
          : null;
        const duplicateTotalTick = totalSig !== null && totalSig === lastCodexTotalSig;
        if (totalSig !== null) lastCodexTotalSig = totalSig;
        const lastUsage =
          !duplicateTotalTick && payload.info && typeof payload.info === 'object' && payload.info.last_token_usage
            ? (payload.info.last_token_usage as Row)
            : null;
        if (lastUsage) {
          const cacheRead = safeCount(lastUsage.cached_input_tokens);
          const tokens = makeDisjointTokens({
            input: Math.max(0, safeCount(lastUsage.input_tokens) - cacheRead),
            output: lastUsage.output_tokens,
            cacheRead,
            cacheWrite: lastUsage.cache_write_input_tokens,
            reasoning: lastUsage.reasoning_output_tokens,
          });
          if (tokens.total > 0) {
            const finished = codexTiming.finishCount(row.timestamp, lastUsage, tokens.reasoning > 0);
            const turnReported = currentCodexReportedModel || finished.model || null;
            const tokensPerSec = computeTokensPerSec(tokens.output, finished.durationMs);
            const turnEvent: MonitorTimedUsageEvent = {
              kind: 'turn',
              timestamp: row.timestamp || '',
              tokens,
              model: turnReported,
              requestedModel,
              durationMs: finished.durationMs,
              tokensPerSec,
              tools: [...new Set(pendingCodexTools)],
            };
            timedTurns.push(turnEvent);
            if (currentCodexReplyEvidence && finished.durationMs !== null && tokensPerSec !== null) {
              currentCodexReplyEvidence.durationMs = finished.durationMs;
              currentCodexReplyEvidence.tokensPerSec = tokensPerSec;
            }
            pendingUnlabeledCodexTurn = turnReported ? null : turnEvent;
            currentCodexReportedModel = null;
            currentCodexReplyEvidence = null;
          }
          pendingCodexTools = [];
        }
      }

      // Claude turn usage, replay deduplication & split-block monotonic timing.
      if (provider === 'claude' && row.type === 'assistant') {
        const lineUuid = typeof row.uuid === 'string' && row.uuid ? row.uuid : null;
        const isReplay = lineUuid !== null && seenClaudeLineUuids.has(lineUuid);
        if (lineUuid !== null) seenClaudeLineUuids.add(lineUuid);
        if (!isReplay && message) {
          if (typeof message.model === 'string' && message.model.trim().startsWith('<')) {
            pendingClaudeStartMs = null;
          } else if (message.usage && typeof message.usage === 'object') {
            const u = message.usage as Row;
            const at = parseMonitorTimestampMs(row.timestamp);
            const msgId = typeof message.id === 'string' && message.id ? message.id : null;
            const tools: string[] = Array.isArray(message.content)
              ? message.content
                  .filter((part: Row) => part?.type === 'tool_use' && typeof part.name === 'string')
                  .map((part: Row) => String(part.name))
              : [];
            const existing = msgId ? claudeTurnsById.get(msgId) : undefined;
            if (existing) {
              existing.event.tools = [...new Set([...(existing.event.tools || []), ...tools])];
              if (at !== null && existing.startMs !== null && at > existing.startMs) {
                const span = at - existing.startMs;
                existing.event.durationMs = Math.max(existing.event.durationMs ?? 0, span);
              }
              existing.event.tokensPerSec = computeTokensPerSec(
                existing.event.tokens.output,
                existing.event.durationMs,
              );
              if (existing.evidence && existing.event.durationMs !== null && existing.event.tokensPerSec !== null) {
                existing.evidence.durationMs = existing.event.durationMs;
                existing.evidence.tokensPerSec = existing.event.tokensPerSec;
              }
              if (latestEvidence && existing.event.durationMs !== null && existing.event.tokensPerSec !== null) {
                latestEvidence.durationMs = existing.event.durationMs;
                latestEvidence.tokensPerSec = existing.event.tokensPerSec;
              }
            } else {
              const startMs = pendingClaudeStartMs ?? at;
              const durationMs =
                pendingClaudeStartMs !== null && at !== null && at > pendingClaudeStartMs
                  ? at - pendingClaudeStartMs
                  : null;
              pendingClaudeStartMs = null;
              const tokens = makeDisjointTokens({
                input: u.input_tokens,
                output: u.output_tokens,
                cacheRead: u.cache_read_input_tokens,
                cacheWrite: u.cache_creation_input_tokens,
                reasoning: 0,
              });
              const tokensPerSec = computeTokensPerSec(tokens.output, durationMs);
              const turnEvent: MonitorTimedUsageEvent = {
                kind: 'turn',
                timestamp: row.timestamp || '',
                tokens,
                model: name(message.model),
                requestedModel: name(row.requestedModel) || requestedModel,
                durationMs,
                tokensPerSec,
                tools: [...new Set(tools)],
              };
              timedTurns.push(turnEvent);
              if (latestEvidence && durationMs !== null && tokensPerSec !== null) {
                latestEvidence.durationMs = durationMs;
                latestEvidence.tokensPerSec = tokensPerSec;
              }
              if (msgId) {
                claudeTurnsById.set(msgId, { startMs, event: turnEvent, evidence: latestEvidence });
              }
            }
          }
        }
      }

      // Retain usage, identifiers and prompt boundaries needed by the upstream deduplicator.
      // Never accumulate transcript text, base64 attachments, tool arguments or reasoning.
      if (row.type === 'event_msg' && payload.type === 'token_count') {
        projected.push(JSON.stringify({ type: row.type, timestamp: row.timestamp, payload }));
      } else if (row.type === 'monitor_response') {
        projected.push(JSON.stringify({ type: row.type, timestamp: row.timestamp, payload: { id: payload.id, usage: payload.usage } }));
      } else if (row.type === 'assistant') {
        projected.push(
          JSON.stringify({
            type: row.type,
            uuid: row.uuid,
            timestamp: row.timestamp,
            message: { id: message?.id, model: message?.model, usage: message?.usage, content: [] },
          }),
        );
      }
    }
  } finally {
    lines.close();
    stream.destroy();
  }

  const joined = new Set(replyModels.flatMap(record => record.messageIds));
  // Preserve the existing cross-engine history summary, while only Codex
  // annotations may join the Codex HTTP captures to individual replies.
  for (const capture of allCaptures) {
    if (typeof capture.model === 'string' && capture.model.trim() && capture.model.length <= 256) {
      reported.add(capture.model);
    }
  }
  for (const capture of captures) {
    if (capture.kind !== 'response') continue;
    const ids = (capture.itemIds || []).filter((id): id is string => typeof id === 'string' && !joined.has(id));
    if (!ids.length) continue;
    const context = [...contexts].reverse().find(value => value.timestamp <= Date.parse(capture.timestamp));
    replyModels.push({
      messageIds: ids,
      timestamp: capture.timestamp,
      requestedModel: context?.model || null,
      reportedModel: name(capture.model),
    });
    ids.forEach(id => joined.add(id));
  }

  const value: CachedHistoryValue = {
    projected: projected.join('\n'),
    recordedModels: [...recorded],
    reportedModels: [...reported],
    replyModels,
    timedTurns,
  };
  if (cache.size >= 256) cache.delete(cache.keys().next().value!);
  cache.set(cacheId, { key, value });
  return value;
}
