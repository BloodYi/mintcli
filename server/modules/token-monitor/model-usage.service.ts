import type {
  AnyRecord as Row,
  MonitorGlobalModelUsage,
  MonitorGlobalSummary,
  MonitorModelAttributionSource,
  MonitorSessionModelUsage,
  MonitorTimedUsageEvent,
  MonitorTokens,
} from '@/shared/index.js';

export const UNATTRIBUTED_MODEL = '__unattributed';
const SAME_FLUSH_MS = 100;
const MAX_DISPLAY_RATE = 1e12;

/** Zero-initialized token bucket used by Token Monitor session and global aggregators. */
export function emptyMonitorTokens(): MonitorTokens {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0 };
}

function safeNonNegative(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function addTokensInto(target: MonitorTokens, delta: MonitorTokens): void {
  target.input += safeNonNegative(delta.input);
  target.output += safeNonNegative(delta.output);
  target.cacheRead += safeNonNegative(delta.cacheRead);
  target.cacheWrite += safeNonNegative(delta.cacheWrite);
  target.reasoning += safeNonNegative(delta.reasoning);
  target.total += safeNonNegative(delta.total);
}

function cloneTokens(source: MonitorTokens): MonitorTokens {
  return {
    input: safeNonNegative(source.input),
    output: safeNonNegative(source.output),
    cacheRead: safeNonNegative(source.cacheRead),
    cacheWrite: safeNonNegative(source.cacheWrite),
    reasoning: safeNonNegative(source.reasoning),
    total: safeNonNegative(source.total),
  };
}

/** Used by session-history, AGY and token-monitor services to parse ISO or epoch timestamps into ms. */
export function parseMonitorTimestampMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.round(value < 1e12 ? value * 1000 : value);
  }
  if (typeof value !== 'string' || !value.trim()) return null;
  const trimmed = value.trim();
  if (/^\d{10,13}(?:\.\d+)?$/.test(trimmed)) {
    const num = Number(trimmed);
    return Number.isFinite(num) && num > 0 ? Math.round(num < 1e12 ? num * 1000 : num) : null;
  }
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Used by session-history, AGY and token-monitor services to calculate tok/s output rate.
 * Adapted from MIT-licensed Javis603/token-monitor tokenRatePresentation & sessionRows:
 * untimed or zero-output entries return null rather than a misleading zero rate.
 */
export function computeTokensPerSec(
  timedOutputTokens: number,
  timedDurationMs: number | null | undefined,
): number | null {
  if (typeof timedDurationMs !== 'number' || !Number.isFinite(timedDurationMs) || timedDurationMs <= 0) {
    return null;
  }
  const output = safeNonNegative(timedOutputTokens);
  if (output <= 0) return null;
  const raw = Math.min(MAX_DISPLAY_RATE, (output * 1000) / timedDurationMs);
  return Math.round(raw * 10) / 10;
}

function maxNullable(left: number | null, right: number | null): number | null {
  if (left === null) return right;
  if (right === null) return left;
  return Math.max(left, right);
}

function usageSignature(usage: Row): string {
  const input = safeNonNegative(usage.input_tokens ?? usage.prompt_tokens);
  const cached = safeNonNegative(usage.cached_input_tokens ?? usage.input_tokens_details?.cached_tokens);
  const cacheWrite = safeNonNegative(usage.cache_write_input_tokens);
  const output = safeNonNegative(usage.output_tokens ?? usage.completion_tokens);
  const reasoning = safeNonNegative(
    usage.reasoning_output_tokens ?? usage.output_tokens_details?.reasoning_tokens,
  );
  return `${input}:${cached}:${cacheWrite}:${output}:${reasoning}`;
}

/**
 * Used by session-history and token-monitor services to time Codex model generation per request.
 * Adapted from MIT-licensed Javis603/tokscale `codex_timing.rs`: excludes post-response tool
 * execution waits when `token_usage_record` precedes tool output or when tool output and
 * `token_count` flush within 100 ms.
 */
export function createCodexTimingTracker() {
  let boundaryMs: number | null = null;
  let lastCountMs: number | null = null;
  let requestStartMs: number | null = null;
  let modelEndMs: number | null = null;
  let toolResultAfterOutputMs: number | null = null;
  let onlyEmptyMessages: boolean | null = null;
  let pendingRecord: { sig: string; durationMs: number | null; model: string | null } | null = null;

  const reset = (nextBoundary: number | null) => {
    boundaryMs = nextBoundary;
    requestStartMs = null;
    modelEndMs = null;
    toolResultAfterOutputMs = null;
    onlyEmptyMessages = null;
  };

  const startTurn = (at: number | null) => {
    reset(at);
    lastCountMs = null;
    pendingRecord = null;
  };

  const observeOutputContent = (kind: string, payload: Row) => {
    const content = Array.isArray(payload.content) ? payload.content : null;
    const emptyMessage =
      kind === 'message' &&
      content !== null &&
      content.every(
        (part: Row) =>
          part?.type === 'output_text' && typeof part.text === 'string' && part.text.length === 0,
      );
    onlyEmptyMessages = (onlyEmptyMessages ?? true) && emptyMessage;
  };

  const finishWindow = (
    endCandidateMs: number | null,
    preferExactEnd: boolean,
    hasReasoning: boolean,
  ): number | null => {
    const start = requestStartMs ?? boundaryMs;
    let end = endCandidateMs;
    if (!preferExactEnd) {
      const delayedByTools =
        toolResultAfterOutputMs !== null &&
        (endCandidateMs === null ||
          (endCandidateMs - toolResultAfterOutputMs >= 0 &&
            endCandidateMs - toolResultAfterOutputMs <= SAME_FLUSH_MS));
      if (delayedByTools) {
        end = modelEndMs;
      }
    }
    const emptyCompletion = onlyEmptyMessages === true && !hasReasoning;
    const nextBoundary = maxNullable(boundaryMs, endCandidateMs);
    reset(nextBoundary);
    lastCountMs = maxNullable(lastCountMs, endCandidateMs);
    if (emptyCompletion || start === null || end === null || end <= start) {
      return null;
    }
    return end - start;
  };

  return {
    observe(entryType: string, timestamp: unknown, payload: Row, validModel: (v: unknown) => string | null) {
      const kind = typeof payload.type === 'string' ? payload.type : '';
      const isAssistantMessage =
        entryType === 'response_item' &&
        (kind === 'message' || !kind) &&
        payload.role === 'assistant';
      const modelOutput =
        entryType === 'response_item' &&
        (kind === 'reasoning' || kind.endsWith('_call') || isAssistantMessage);
      const at = parseMonitorTimestampMs(timestamp);
      if (at === null) {
        if (modelOutput) observeOutputContent(kind || 'message', payload);
        return;
      }
      if (entryType === 'turn_context') {
        startTurn(at);
        return;
      }
      if (entryType === 'token_usage_record') {
        const usage = payload.usage && typeof payload.usage === 'object' ? (payload.usage as Row) : null;
        if (usage) {
          const sig = usageSignature(usage);
          const hasReasoning =
            safeNonNegative(usage.reasoning_output_tokens ?? usage.output_tokens_details?.reasoning_tokens) > 0;
          const durationMs = finishWindow(at, true, hasReasoning);
          pendingRecord = { sig, durationMs, model: validModel(payload.model) };
        }
        return;
      }
      if (entryType === 'event_msg') {
        if (kind === 'task_started') {
          startTurn(at);
        } else if (kind === 'turn_aborted') {
          reset(at);
          pendingRecord = null;
        } else if (kind === 'user_message') {
          const text = String(payload.message ?? payload.text ?? '').trim();
          const hasImages =
            (Array.isArray(payload.images) && payload.images.length > 0) ||
            (Array.isArray(payload.local_images) && payload.local_images.length > 0);
          if (text || hasImages) startTurn(at);
        } else if (kind === 'task_complete') {
          reset(null);
          pendingRecord = null;
        }
        return;
      }
      if (entryType === 'response_item') {
        if (kind.endsWith('_output')) {
          boundaryMs = maxNullable(boundaryMs, at);
          if (modelEndMs !== null) toolResultAfterOutputMs = at;
        } else if (modelOutput) {
          if (
            requestStartMs === null &&
            lastCountMs !== null &&
            at - lastCountMs >= 0 &&
            at - lastCountMs <= SAME_FLUSH_MS
          ) {
            return;
          }
          if (requestStartMs === null) requestStartMs = boundaryMs;
          observeOutputContent(kind || 'message', payload);
          modelEndMs = at;
          toolResultAfterOutputMs = null;
        } else if (kind === 'message') {
          boundaryMs = maxNullable(boundaryMs, at);
        }
      }
    },
    finishCount(timestamp: unknown, lastUsage: Row, hasReasoning: boolean): { durationMs: number | null; model: string | null } {
      const at = parseMonitorTimestampMs(timestamp);
      const sig = usageSignature(lastUsage);
      if (pendingRecord !== null) {
        const matched = pendingRecord.sig === sig;
        const result = {
          durationMs: matched ? pendingRecord.durationMs : null,
          model: matched ? pendingRecord.model : null,
        };
        pendingRecord = null;
        boundaryMs = maxNullable(boundaryMs, at);
        lastCountMs = maxNullable(lastCountMs, at);
        return result;
      }
      return { durationMs: finishWindow(at, false, hasReasoning), model: null };
    },
  };
}

type MutableModelBucket = {
  model: string;
  hasReported: boolean;
  hasRequested: boolean;
  unattributed: boolean;
  tokens: MonitorTokens;
  reportedTokens: MonitorTokens;
  turnCount: number;
  timedOutputTokens: number;
  timedDurationMs: number;
};

function resolveBucketSource(bucket: MutableModelBucket): MonitorModelAttributionSource {
  if (bucket.unattributed || bucket.model === UNATTRIBUTED_MODEL) return 'unattributed';
  if (bucket.hasReported && bucket.hasRequested) return 'mixed';
  if (bucket.hasReported) return 'reported';
  return 'requested';
}

function scaleTokensProportionally(totals: MonitorTokens, weight: number, totalWeight: number): MonitorTokens {
  if (totalWeight <= 0 || weight <= 0) return emptyMonitorTokens();
  const ratio = weight / totalWeight;
  return {
    input: Math.round(totals.input * ratio),
    output: Math.round(totals.output * ratio),
    cacheRead: Math.round(totals.cacheRead * ratio),
    cacheWrite: Math.round(totals.cacheWrite * ratio),
    reasoning: Math.round(totals.reasoning * ratio),
    total: Math.round(totals.total * ratio),
  };
}

/**
 * Used by token-monitor and AGY monitor services to compute per-session model usage and tok/s.
 * Preserves native AGY non-additive snapshot semantics (`nativeCumulative: true`) while reconciling
 * per-model attribution shares to exact session totals (adapted from Javis603/token-monitor usageAttributionRows).
 */
export function buildSessionModelUsage(options: {
  totals: MonitorTokens | null;
  turns: MonitorTimedUsageEvent[];
  recordedModels: string[];
  reportedModels: string[];
  configuredModel: string | null;
  nativeCumulative?: boolean;
}): {
  speed: number | null;
  latestSpeed: number | null;
  timedOutputTokens: number;
  timedDurationMs: number;
  modelUsage: MonitorSessionModelUsage[];
} {
  const { totals, turns, recordedModels, reportedModels, configuredModel, nativeCumulative = false } = options;
  let timedOutputTokens = 0;
  let timedDurationMs = 0;
  let latestSpeed: number | null = null;

  const fallbackSingleReported = reportedModels.length === 1 ? reportedModels[0] : null;
  const fallbackSingleRequested =
    recordedModels.length === 1 ? recordedModels[0] : configuredModel || recordedModels[0] || null;

  const buckets = new Map<string, MutableModelBucket>();
  const ensureBucket = (model: string): MutableModelBucket => {
    let bucket = buckets.get(model);
    if (!bucket) {
      bucket = {
        model,
        hasReported: false,
        hasRequested: false,
        unattributed: model === UNATTRIBUTED_MODEL,
        tokens: emptyMonitorTokens(),
        reportedTokens: emptyMonitorTokens(),
        turnCount: 0,
        timedOutputTokens: 0,
        timedDurationMs: 0,
      };
      buckets.set(model, bucket);
    }
    return bucket;
  };

  for (const turn of turns) {
    const reported = turn.model || fallbackSingleReported;
    const requested = turn.requestedModel || fallbackSingleRequested;
    const key = reported || requested || UNATTRIBUTED_MODEL;
    const bucket = ensureBucket(key);
    if (reported) {
      bucket.hasReported = true;
    } else if (requested) {
      bucket.hasRequested = true;
    } else {
      bucket.unattributed = true;
    }
    bucket.turnCount += 1;

    if (turn.durationMs !== null && turn.durationMs > 0 && turn.tokens.output > 0) {
      timedOutputTokens += turn.tokens.output;
      timedDurationMs += turn.durationMs;
      bucket.timedOutputTokens += turn.tokens.output;
      bucket.timedDurationMs += turn.durationMs;
      if (turn.tokensPerSec !== null && turn.tokensPerSec > 0) {
        latestSpeed = turn.tokensPerSec;
      } else {
        latestSpeed = computeTokensPerSec(turn.tokens.output, turn.durationMs);
      }
    }

    if (!nativeCumulative) {
      addTokensInto(bucket.tokens, turn.tokens);
      if (reported) addTokensInto(bucket.reportedTokens, turn.tokens);
    }
  }

  const speed = computeTokensPerSec(timedOutputTokens, timedDurationMs);
  if (!totals) {
    return { speed, latestSpeed, timedOutputTokens, timedDurationMs, modelUsage: [] };
  }

  if (nativeCumulative) {
    // Native AGY totals represent one authoritative snapshot; never sum cumulative snapshots together.
    if (buckets.size === 0) {
      const key = fallbackSingleReported || fallbackSingleRequested || UNATTRIBUTED_MODEL;
      const bucket = ensureBucket(key);
      if (fallbackSingleReported) bucket.hasReported = true;
      else if (fallbackSingleRequested) bucket.hasRequested = true;
      else bucket.unattributed = true;
      bucket.tokens = cloneTokens(totals);
      if (fallbackSingleReported) bucket.reportedTokens = cloneTokens(totals);
    } else if (buckets.size === 1) {
      const sole = [...buckets.values()][0];
      sole.tokens = cloneTokens(totals);
      if (sole.hasReported && !sole.hasRequested) sole.reportedTokens = cloneTokens(totals);
    } else {
      // Check if turns are monotonic cumulative snapshots; otherwise apportion totals by observed weights.
      let monotonic = turns.length > 0;
      for (let i = 1; i < turns.length; i += 1) {
        if (
          turns[i].tokens.total < turns[i - 1].tokens.total ||
          turns[i].tokens.input < turns[i - 1].tokens.input ||
          turns[i].tokens.output < turns[i - 1].tokens.output
        ) {
          monotonic = false;
          break;
        }
      }
      if (monotonic) {
        let prev = emptyMonitorTokens();
        for (const turn of turns) {
          const reported = turn.model || fallbackSingleReported;
          const requested = turn.requestedModel || fallbackSingleRequested;
          const bucket = ensureBucket(reported || requested || UNATTRIBUTED_MODEL);
          const delta: MonitorTokens = {
            input: Math.max(0, turn.tokens.input - prev.input),
            output: Math.max(0, turn.tokens.output - prev.output),
            cacheRead: Math.max(0, turn.tokens.cacheRead - prev.cacheRead),
            cacheWrite: Math.max(0, turn.tokens.cacheWrite - prev.cacheWrite),
            reasoning: Math.max(0, turn.tokens.reasoning - prev.reasoning),
            total: Math.max(0, turn.tokens.total - prev.total),
          };
          addTokensInto(bucket.tokens, delta);
          if (reported) addTokensInto(bucket.reportedTokens, delta);
          prev = turn.tokens;
        }
      } else {
        const rawWeights = new Map<string, number>();
        let weightSum = 0;
        for (const turn of turns) {
          const key = turn.model || fallbackSingleReported || turn.requestedModel || fallbackSingleRequested || UNATTRIBUTED_MODEL;
          const w = Math.max(1, turn.tokens.total);
          rawWeights.set(key, (rawWeights.get(key) || 0) + w);
          weightSum += w;
        }
        const entries = [...buckets.values()];
        let allocatedTotal = 0;
        let allocatedInput = 0;
        let allocatedOutput = 0;
        let allocatedCacheRead = 0;
        let allocatedCacheWrite = 0;
        let allocatedReasoning = 0;
        entries.forEach((bucket, index) => {
          if (index === entries.length - 1) {
            bucket.tokens = {
              input: Math.max(0, totals.input - allocatedInput),
              output: Math.max(0, totals.output - allocatedOutput),
              cacheRead: Math.max(0, totals.cacheRead - allocatedCacheRead),
              cacheWrite: Math.max(0, totals.cacheWrite - allocatedCacheWrite),
              reasoning: Math.max(0, totals.reasoning - allocatedReasoning),
              total: Math.max(0, totals.total - allocatedTotal),
            };
          } else {
            bucket.tokens = scaleTokensProportionally(totals, rawWeights.get(bucket.model) || 0, weightSum);
            allocatedInput += bucket.tokens.input;
            allocatedOutput += bucket.tokens.output;
            allocatedCacheRead += bucket.tokens.cacheRead;
            allocatedCacheWrite += bucket.tokens.cacheWrite;
            allocatedReasoning += bucket.tokens.reasoning;
            allocatedTotal += bucket.tokens.total;
          }
          if (bucket.hasReported && !bucket.hasRequested) {
            bucket.reportedTokens = cloneTokens(bucket.tokens);
          }
        });
      }
    }
  } else {
    // Reconcile any cumulative difference (e.g. Codex total_token_usage vs turn sum) without losing or inflating tokens.
    const attributed = emptyMonitorTokens();
    for (const bucket of buckets.values()) addTokensInto(attributed, bucket.tokens);
    if (buckets.size === 0) {
      const key = fallbackSingleReported || fallbackSingleRequested || UNATTRIBUTED_MODEL;
      const bucket = ensureBucket(key);
      if (fallbackSingleReported) bucket.hasReported = true;
      else if (fallbackSingleRequested) bucket.hasRequested = true;
      else bucket.unattributed = true;
      bucket.tokens = cloneTokens(totals);
      if (fallbackSingleReported) bucket.reportedTokens = cloneTokens(totals);
    } else if (attributed.total < totals.total) {
      const remainder: MonitorTokens = {
        input: Math.max(0, totals.input - attributed.input),
        output: Math.max(0, totals.output - attributed.output),
        cacheRead: Math.max(0, totals.cacheRead - attributed.cacheRead),
        cacheWrite: Math.max(0, totals.cacheWrite - attributed.cacheWrite),
        reasoning: Math.max(0, totals.reasoning - attributed.reasoning),
        total: Math.max(0, totals.total - attributed.total),
      };
      if (buckets.size === 1) {
        const sole = [...buckets.values()][0];
        addTokensInto(sole.tokens, remainder);
        if (sole.hasReported && !sole.hasRequested) addTokensInto(sole.reportedTokens, remainder);
      } else {
        const unattributed = ensureBucket(UNATTRIBUTED_MODEL);
        unattributed.unattributed = true;
        addTokensInto(unattributed.tokens, remainder);
      }
    } else if (attributed.total > totals.total) {
      if (buckets.size === 1) {
        const sole = [...buckets.values()][0];
        const repRatio = attributed.total > 0 ? sole.reportedTokens.total / attributed.total : 0;
        sole.tokens = cloneTokens(totals);
        sole.reportedTokens =
          sole.hasReported && !sole.hasRequested
            ? cloneTokens(totals)
            : scaleTokensProportionally(totals, repRatio, 1);
      } else {
        const entries = [...buckets.values()];
        let allocInput = 0;
        let allocOutput = 0;
        let allocCacheRead = 0;
        let allocCacheWrite = 0;
        let allocReasoning = 0;
        let allocTotal = 0;
        entries.forEach((bucket, index) => {
          const prevBucketTotal = bucket.tokens.total;
          const prevRepTotal = bucket.reportedTokens.total;
          if (index === entries.length - 1) {
            bucket.tokens = {
              input: Math.max(0, totals.input - allocInput),
              output: Math.max(0, totals.output - allocOutput),
              cacheRead: Math.max(0, totals.cacheRead - allocCacheRead),
              cacheWrite: Math.max(0, totals.cacheWrite - allocCacheWrite),
              reasoning: Math.max(0, totals.reasoning - allocReasoning),
              total: Math.max(0, totals.total - allocTotal),
            };
          } else {
            bucket.tokens = scaleTokensProportionally(totals, prevBucketTotal, attributed.total);
            allocInput += bucket.tokens.input;
            allocOutput += bucket.tokens.output;
            allocCacheRead += bucket.tokens.cacheRead;
            allocCacheWrite += bucket.tokens.cacheWrite;
            allocReasoning += bucket.tokens.reasoning;
            allocTotal += bucket.tokens.total;
          }
          if (bucket.hasReported && !bucket.hasRequested) {
            bucket.reportedTokens = cloneTokens(bucket.tokens);
          } else if (prevRepTotal > 0 && prevBucketTotal > 0) {
            bucket.reportedTokens = scaleTokensProportionally(bucket.tokens, prevRepTotal, prevBucketTotal);
          }
        });
      }
    }
  }

  const denominator = Math.max(
    totals.total,
    [...buckets.values()].reduce((sum, bucket) => sum + bucket.tokens.total, 0),
  );

  const modelUsage: MonitorSessionModelUsage[] = [...buckets.values()]
    .filter(bucket => bucket.tokens.total > 0 || totals.total === 0)
    .map(bucket => ({
      model: bucket.model,
      source: resolveBucketSource(bucket),
      tokens: bucket.tokens,
      reportedTokens: bucket.reportedTokens,
      turnCount: bucket.turnCount,
      timedOutputTokens: bucket.timedOutputTokens,
      timedDurationMs: bucket.timedDurationMs,
      speed: computeTokensPerSec(bucket.timedOutputTokens, bucket.timedDurationMs),
      share: denominator > 0 ? bucket.tokens.total / denominator : 0,
    }))
    .sort((left, right) => {
      if (left.model === UNATTRIBUTED_MODEL && right.model !== UNATTRIBUTED_MODEL) return 1;
      if (right.model === UNATTRIBUTED_MODEL && left.model !== UNATTRIBUTED_MODEL) return -1;
      return right.tokens.total - left.tokens.total || left.model.localeCompare(right.model);
    });

  return { speed, latestSpeed, timedOutputTokens, timedDurationMs, modelUsage };
}

/** Used by token-monitor service `sessions()` to aggregate token usage and tok/s across all models. */
export function aggregateGlobalModelUsage(sessions: Row[]): {
  models: MonitorGlobalModelUsage[];
  summary: MonitorGlobalSummary;
} {
  const summaryTokens = emptyMonitorTokens();
  const summaryReportedTokens = emptyMonitorTokens();
  let sessionsWithUsage = 0;
  let totalTimedOutputTokens = 0;
  let totalTimedDurationMs = 0;

  type GlobalBucket = {
    model: string;
    providers: Set<string>;
    hasReported: boolean;
    hasRequested: boolean;
    unattributed: boolean;
    tokens: MonitorTokens;
    reportedTokens: MonitorTokens;
    sessionCount: number;
    reportedSessionCount: number;
    turnCount: number;
    timedOutputTokens: number;
    timedDurationMs: number;
  };
  const byModel = new Map<string, GlobalBucket>();

  for (const session of sessions) {
    const totals = session.totals as MonitorTokens | null | undefined;
    const provider = typeof session.provider === 'string' ? session.provider : 'unknown';
    const sessionTimedOutput = safeNonNegative(session.timedOutputTokens);
    const sessionTimedDuration = safeNonNegative(session.timedDurationMs);
    if (sessionTimedDuration > 0 && sessionTimedOutput > 0) {
      totalTimedOutputTokens += sessionTimedOutput;
      totalTimedDurationMs += sessionTimedDuration;
    }
    if (!totals) continue;
    sessionsWithUsage += 1;
    addTokensInto(summaryTokens, totals);

    const rows: MonitorSessionModelUsage[] = Array.isArray(session.modelUsage) ? session.modelUsage : [];
    for (const row of rows) {
      let bucket = byModel.get(row.model);
      if (!bucket) {
        bucket = {
          model: row.model,
          providers: new Set(),
          hasReported: false,
          hasRequested: false,
          unattributed: row.model === UNATTRIBUTED_MODEL,
          tokens: emptyMonitorTokens(),
          reportedTokens: emptyMonitorTokens(),
          sessionCount: 0,
          reportedSessionCount: 0,
          turnCount: 0,
          timedOutputTokens: 0,
          timedDurationMs: 0,
        };
        byModel.set(row.model, bucket);
      }
      bucket.providers.add(provider);
      bucket.sessionCount += 1;
      bucket.turnCount += safeNonNegative(row.turnCount);
      bucket.timedOutputTokens += safeNonNegative(row.timedOutputTokens);
      bucket.timedDurationMs += safeNonNegative(row.timedDurationMs);
      addTokensInto(bucket.tokens, row.tokens);
      addTokensInto(bucket.reportedTokens, row.reportedTokens);
      addTokensInto(summaryReportedTokens, row.reportedTokens);

      if (row.source === 'reported') {
        bucket.hasReported = true;
        bucket.reportedSessionCount += 1;
      } else if (row.source === 'mixed') {
        bucket.hasReported = true;
        bucket.hasRequested = true;
        if (row.reportedTokens.total > 0) bucket.reportedSessionCount += 1;
      } else if (row.source === 'requested') {
        bucket.hasRequested = true;
      } else {
        bucket.unattributed = true;
      }
    }
  }

  const denominator = summaryTokens.total;
  const models: MonitorGlobalModelUsage[] = [...byModel.values()]
    .filter(bucket => bucket.tokens.total > 0 || bucket.timedDurationMs > 0)
    .map(bucket => {
      const source: MonitorModelAttributionSource =
        bucket.unattributed || bucket.model === UNATTRIBUTED_MODEL
          ? 'unattributed'
          : bucket.hasReported && bucket.hasRequested
            ? 'mixed'
            : bucket.hasReported
              ? 'reported'
              : 'requested';
      return {
        model: bucket.model,
        providers: [...bucket.providers].sort(),
        source,
        tokens: bucket.tokens,
        reportedTokens: bucket.reportedTokens,
        sessionCount: bucket.sessionCount,
        reportedSessionCount: bucket.reportedSessionCount,
        turnCount: bucket.turnCount,
        timedOutputTokens: bucket.timedOutputTokens,
        timedDurationMs: bucket.timedDurationMs,
        speed: computeTokensPerSec(bucket.timedOutputTokens, bucket.timedDurationMs),
        share: denominator > 0 ? bucket.tokens.total / denominator : 0,
      };
    })
    .sort((left, right) => {
      if (left.model === UNATTRIBUTED_MODEL && right.model !== UNATTRIBUTED_MODEL) return 1;
      if (right.model === UNATTRIBUTED_MODEL && left.model !== UNATTRIBUTED_MODEL) return -1;
      return right.tokens.total - left.tokens.total || left.model.localeCompare(right.model);
    });

  const namedModels = models.filter(item => item.model !== UNATTRIBUTED_MODEL);
  const reportedModelCount = namedModels.filter(item => item.reportedTokens.total > 0).length;

  return {
    models,
    summary: {
      totalSessions: sessions.length,
      sessionsWithUsage,
      modelCount: namedModels.length,
      reportedModelCount,
      tokens: summaryTokens,
      reportedTokens: summaryReportedTokens,
      timedOutputTokens: totalTimedOutputTokens,
      timedDurationMs: totalTimedDurationMs,
      speed: computeTokensPerSec(totalTimedOutputTokens, totalTimedDurationMs),
    },
  };
}
