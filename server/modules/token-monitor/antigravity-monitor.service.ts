import { antigravityBridge } from '@/modules/antigravity/index.js';
import type { ReplyModelEvidence, AnyRecord as Row } from '@/shared/index.js';

/** Used by the monitor service to inspect persisted AGY replies and their response evidence. */
export async function readAntigravityMonitor(session: Row) {
  const base = { sessionId: session.session_id, provider: session.provider, configuredModel: session.model || null,
    returnedModel: null as string | null, checkedAt: Date.now() };
  const response = await antigravityBridge.request('GET', '/api/conversations/' + encodeURIComponent(session.provider_session_id || session.session_id) + '/messages', undefined, AbortSignal.timeout(15000));
  if (!response.ok) throw new Error('AGY 原始记录暂不可读');
  const data = await response.json() as Row;
  const seen = new Set<string>();
  const replyModels: ReplyModelEvidence[] = [];
  const replies = []; const usage = []; const recorded = new Set<string>(); const reported = new Set<string>();
  for (const [index, message] of (data.messages || []).entries()) {
    if (message.role !== 'assistant') continue;
    const id = String(message.id || index); if (seen.has(id)) continue; seen.add(id);
    const route = message.routeInfo || {};
    const valid = (value: unknown): value is string => typeof value === 'string' && !!value.trim() && value.length <= 256;
    const models: string[] = (Array.isArray(route.returned_model_fulls) && route.returned_model_fulls.length ? route.returned_model_fulls : route.returned_models || []).filter(valid);
    models.forEach(model => reported.add(model));
    if (valid(message.requestedModel || message.model)) recorded.add(message.requestedModel || message.model);
    base.returnedModel = models.at(-1) || null;
    const timestamp = message.timestamp || message.created_at || '';
    const requested = message.requestedModel || route.requested_model || message.model;
    const stepIds = Array.isArray(message.steps)
      ? message.steps
        .filter((step: Row) => step?.type === 'text' && typeof step.id === 'string' && step.id)
        .map((step: Row) => String(step.id))
      : [];
    replyModels.push({ messageIds: [...new Set([id, ...stepIds])], timestamp: String(timestamp), requestedModel: valid(requested) ? requested : null, reportedModel: base.returnedModel });
    const content = String(message.content || '');
    const metrics = typeof message.metrics === 'string' ? message.metrics : '';
    // The native bridge historically persisted numeric usage only in this formatted snapshot.
    // Keep its cumulative total; summing per-message snapshots would inflate historical usage.
    const count = (pattern: RegExp) => Number(metrics.match(pattern)?.[1]?.replaceAll(',', '') || 0);
    if (/^[\d,]+ tokens/.test(metrics)) usage.push({ kind: 'snapshot', timestamp, tokens: {
      total: count(/^([\d,]+) tokens/), input: count(/输入 ([\d,]+)/), output: count(/输出 ([\d,]+)/),
      cacheRead: count(/缓存 ([\d,]+)/), cacheWrite: 0, reasoning: count(/思考 ([\d,]+)/),
    } });
    replies.push({ id, timestamp, model: base.returnedModel, content: content.slice(0, 100000), truncated: content.length > 100000,
      raw: { id, role: 'assistant', ...(base.returnedModel ? { model: base.returnedModel } : {}), content: content.slice(0, 100000),
        reportedModels: models, ...(metrics ? { metrics } : {}) } });
  }
  return { ...base, status: 'ok', replies: replies.slice(-30).reverse(), usage: usage.slice(-60).reverse(),
    replyModels,
    totals: usage.at(-1)?.tokens || null, totalsScope: 'native', limited: replies.length > 30,
    recordedModels: [...recorded], reportedModels: [...reported],
    usageNote: usage.length ? 'AGY 用量来自原生累计快照，缓存单独报告；总计沿用原生口径，不叠加各次累计值。' : undefined, alerts: [] };
}
