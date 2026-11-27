import { antigravityBridge } from '@/modules/antigravity/index.js';
import {
  buildSessionModelUsage,
  computeTokensPerSec,
  emptyMonitorTokens,
} from './model-usage.service.js';
import type {
  AnyRecord as Row,
  MonitorTimedUsageEvent,
  MonitorTokens,
  ReplyModelEvidence,
} from '@/shared/index.js';

function extractSafeTransport(route: Row): 'claude_agy' | 'acp' | 'cli' | null {
  const raw = typeof route.transport === 'string' ? route.transport.trim().toLowerCase() : '';
  if (raw === 'claude_agy' || raw === 'claude-agy') return 'claude_agy';
  if (raw === 'acp') return 'acp';
  if (raw === 'cli') return 'cli';
  return null;
}

function extractSafePlugins(route: Row): string[] {
  const plugins: string[] = [];
  const armor = route.armor;
  if (armor === true || (armor && typeof armor === 'object' && (armor as Row).enabled !== false)) {
    plugins.push('Armor');
  }
  const transam = route.transam;
  if (transam === true || (transam && typeof transam === 'object' && (transam as Row).enabled !== false)) {
    const tier = transam && typeof transam === 'object' && typeof (transam as Row).tier === 'string'
      ? String((transam as Row).tier).trim().toUpperCase()
      : '';
    plugins.push(/^4[AHN]$/.test(tier) ? `TRANS-AM ${tier}` : 'TRANS-AM');
  }
  const agyFast = route.agy_fast;
  if (agyFast === true || (agyFast && typeof agyFast === 'object' && (agyFast as Row).enabled !== false)) {
    plugins.push('agy-fast');
  }
  const thinkLang = route.think_lang;
  if (thinkLang === true || (thinkLang && typeof thinkLang === 'object' && (thinkLang as Row).enabled !== false)) {
    plugins.push('思考跟随');
  }
  return plugins;
}

function addTokens(target: MonitorTokens, delta: MonitorTokens): void {
  target.input += delta.input;
  target.output += delta.output;
  target.cacheRead += delta.cacheRead;
  target.cacheWrite += delta.cacheWrite;
  target.reasoning += delta.reasoning;
  target.total += delta.total;
}

/** Used by the monitor service to inspect persisted AGY replies and their response evidence. */
export async function readAntigravityMonitor(session: Row) {
  const base = {
    sessionId: session.session_id,
    provider: session.provider,
    configuredModel: session.model || null,
    returnedModel: null as string | null,
    checkedAt: Date.now(),
  };
  const response = await antigravityBridge.request(
    'GET',
    '/api/conversations/' + encodeURIComponent(session.provider_session_id || session.session_id) + '/messages',
    undefined,
    AbortSignal.timeout(15000),
  );
  if (!response.ok) throw new Error('AGY 原始记录暂不可读');
  const data = (await response.json()) as Row;
  const seen = new Set<string>();
  const replyModels: ReplyModelEvidence[] = [];
  const replies = [];
  const usage: MonitorTimedUsageEvent[] = [];
  const recorded = new Set<string>();
  const reported = new Set<string>();

  for (const [index, message] of (data.messages || []).entries()) {
    if (message.role !== 'assistant') continue;
    const id = String(message.id || index);
    if (seen.has(id)) continue;
    seen.add(id);
    const route = (message.routeInfo && typeof message.routeInfo === 'object' ? message.routeInfo : {}) as Row;
    const valid = (value: unknown): value is string =>
      typeof value === 'string' && !!value.trim() && value.length <= 256;
    const models: string[] = (
      Array.isArray(route.returned_model_fulls) && route.returned_model_fulls.length
        ? route.returned_model_fulls
        : route.returned_models || []
    ).filter(valid);
    models.forEach(model => reported.add(model));
    if (valid(message.requestedModel || message.model)) {
      recorded.add(message.requestedModel || message.model);
    }
    base.returnedModel = models.at(-1) || null;
    const timestamp = message.timestamp || message.created_at || '';
    const requested = message.requestedModel || route.requested_model || message.model;
    const requestedModel = valid(requested) ? requested : null;
    const transport = extractSafeTransport(route);
    const plugins = extractSafePlugins(route);
    const isPerTurn = transport === 'claude_agy' || transport === 'acp';

    const stepIds = Array.isArray(message.steps)
      ? message.steps
          .filter((step: Row) => step?.type === 'text' && typeof step.id === 'string' && step.id)
          .map((step: Row) => String(step.id))
      : [];

    const content = String(message.content || '');
    const metrics = typeof message.metrics === 'string' ? message.metrics : '';
    const count = (pattern: RegExp) => Number(metrics.match(pattern)?.[1]?.replaceAll(',', '') || 0);
    const durationSeconds = Number(metrics.match(/⏱️\s*(\d+(?:\.\d+)?)s/)?.[1] || 0);
    const durationMs = durationSeconds > 0 ? Math.round(durationSeconds * 1000) : null;
    let tokensPerSec: number | null = null;

    if (/^[\d,]+ tokens/.test(metrics)) {
      const tokens: MonitorTokens = {
        total: count(/^([\d,]+) tokens/),
        input: count(/输入 ([\d,]+)/),
        output: count(/输出 ([\d,]+)/),
        cacheRead: count(/缓存 ([\d,]+)/),
        cacheWrite: count(/缓存写入 ([\d,]+)/),
        reasoning: count(/思考 ([\d,]+)/),
      };
      tokensPerSec = computeTokensPerSec(tokens.output, durationMs);
      usage.push({
        kind: isPerTurn ? 'turn' : 'snapshot',
        timestamp,
        tokens,
        model: base.returnedModel,
        requestedModel,
        durationMs,
        tokensPerSec,
      });
    }

    replyModels.push({
      messageIds: [...new Set([id, ...stepIds])],
      timestamp: String(timestamp),
      requestedModel,
      reportedModel: base.returnedModel,
      ...(durationMs !== null && tokensPerSec !== null ? { durationMs, tokensPerSec } : {}),
      ...(transport ? { transport } : {}),
      ...(plugins.length ? { plugins } : {}),
    });

    replies.push({
      id,
      timestamp,
      model: base.returnedModel,
      content: content.slice(0, 100000),
      truncated: content.length > 100000,
      raw: {
        id,
        role: 'assistant',
        ...(base.returnedModel ? { model: base.returnedModel } : {}),
        content: content.slice(0, 100000),
        reportedModels: models,
        ...(transport ? { transport } : {}),
        ...(plugins.length ? { plugins } : {}),
        ...(metrics ? { metrics } : {}),
      },
    });
  }

  const hasPerTurn = usage.some(entry => entry.kind === 'turn');
  const hasSnapshot = usage.some(entry => entry.kind === 'snapshot');
  let totals: MonitorTokens | null = null;
  let turnsForAttribution: MonitorTimedUsageEvent[] = usage;
  let nativeCumulative = true;

  if (usage.length > 0) {
    if (!hasPerTurn) {
      // Legacy AGY print-mode sessions store cumulative session snapshots; never sum them together.
      totals = usage.at(-1)?.tokens || null;
      nativeCumulative = true;
    } else if (!hasSnapshot) {
      // Modern ACP and Claude -> agy turns emit exact per-turn usage; sum across turns.
      const sum = emptyMonitorTokens();
      for (const entry of usage) addTokens(sum, entry.tokens);
      totals = sum;
      nativeCumulative = false;
    } else {
      // Mixed history: take the latest legacy cumulative snapshot once plus per-turn ACP/Claude->agy entries.
      const sum = emptyMonitorTokens();
      const normalizedTurns: MonitorTimedUsageEvent[] = [];
      let prevSnap = emptyMonitorTokens();
      let latestSnap: MonitorTokens | null = null;
      for (const entry of usage) {
        if (entry.kind === 'snapshot') {
          latestSnap = entry.tokens;
          const delta: MonitorTokens = {
            input: Math.max(0, entry.tokens.input - prevSnap.input),
            output: Math.max(0, entry.tokens.output - prevSnap.output),
            cacheRead: Math.max(0, entry.tokens.cacheRead - prevSnap.cacheRead),
            cacheWrite: Math.max(0, entry.tokens.cacheWrite - prevSnap.cacheWrite),
            reasoning: Math.max(0, entry.tokens.reasoning - prevSnap.reasoning),
            total: Math.max(0, entry.tokens.total - prevSnap.total),
          };
          normalizedTurns.push({ ...entry, kind: 'turn', tokens: delta });
          prevSnap = entry.tokens;
        } else {
          addTokens(sum, entry.tokens);
          normalizedTurns.push(entry);
        }
      }
      if (latestSnap) addTokens(sum, latestSnap);
      totals = sum;
      turnsForAttribution = normalizedTurns;
      nativeCumulative = false;
    }
  }

  const recordedModels = [...recorded];
  const reportedModels = [...reported];
  const attribution = buildSessionModelUsage({
    totals,
    turns: turnsForAttribution,
    recordedModels,
    reportedModels,
    configuredModel: base.configuredModel,
    nativeCumulative,
  });

  const totalsScope = hasPerTurn ? 'session' : 'native';
  const usageNote = !usage.length
    ? undefined
    : hasPerTurn
      ? 'ACP / Claude → agy 按逐轮真实返回累计用量，缓存单独报告。'
      : 'AGY 用量来自原生累计快照，缓存单独报告；总计沿用原生口径，不叠加各次累计值。';

  return {
    ...base,
    status: 'ok',
    replies: replies.slice(-30).reverse(),
    usage: usage.slice(-60).reverse(),
    replyModels,
    totals,
    totalsScope,
    speed: attribution.speed,
    latestSpeed: attribution.latestSpeed,
    timedOutputTokens: attribution.timedOutputTokens,
    timedDurationMs: attribution.timedDurationMs,
    modelUsage: attribution.modelUsage,
    limited: replies.length > 30,
    recordedModels,
    reportedModels,
    usageNote,
    alerts: [],
  };
}
