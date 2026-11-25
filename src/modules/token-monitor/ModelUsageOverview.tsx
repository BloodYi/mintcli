import { useMemo, useState } from 'react';
import type {
  MonitorGlobalModelUsage,
  MonitorModelAttributionSource,
  MonitorSessionsPayload,
  MonitorTokens,
} from '@/shared/types';
import {
  formatMonitorDuration,
  formatMonitorSharePercent,
  formatTokenSpeed,
} from '@/shared/utils';

const UNATTRIBUTED_MODEL = '__unattributed';

type SortMode = 'tokens' | 'speed' | 'output' | 'sessions';
type ScopeMode = 'all' | 'reported';

function emptyTokens(): MonitorTokens {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0 };
}

function addTokens(target: MonitorTokens, delta: Partial<MonitorTokens> | null | undefined): void {
  if (!delta) return;
  target.input += Number(delta.input) || 0;
  target.output += Number(delta.output) || 0;
  target.cacheRead += Number(delta.cacheRead) || 0;
  target.cacheWrite += Number(delta.cacheWrite) || 0;
  target.reasoning += Number(delta.reasoning) || 0;
  target.total += Number(delta.total) || 0;
}

function computeSpeed(timedOutput: number, timedDurationMs: number): number | null {
  if (timedDurationMs <= 0 || timedOutput <= 0) return null;
  return Math.round(((timedOutput * 1000) / timedDurationMs) * 10) / 10;
}

function providerLabel(provider: string): string {
  if (provider === 'antigravity') return 'AGY';
  if (provider === 'codex') return 'Codex';
  if (provider === 'claude') return 'Claude';
  return provider;
}

function sourceBadge(source: MonitorModelAttributionSource): { text: string; className: string } {
  if (source === 'reported') {
    return {
      text: '真实返回',
      className: 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-400',
    };
  }
  if (source === 'mixed') {
    return {
      text: '含请求记录',
      className: 'bg-amber-500/12 text-amber-700 dark:text-amber-400',
    };
  }
  if (source === 'requested') {
    return {
      text: '请求记录',
      className: 'bg-muted text-muted-foreground',
    };
  }
  return {
    text: '未标注',
    className: 'bg-muted text-muted-foreground',
  };
}

function deriveModelsFromSessions(
  payload: MonitorSessionsPayload,
  providerFilter: string,
): {
  rows: MonitorGlobalModelUsage[];
  totals: MonitorTokens;
  reportedTotals: MonitorTokens;
  sessionsWithUsage: number;
  timedOutputTokens: number;
  timedDurationMs: number;
  speed: number | null;
} {
  // Fast path: use pre-aggregated server models when viewing all providers and server summary exists.
  if (!providerFilter && payload.models && payload.summary) {
    return {
      rows: payload.models,
      totals: payload.summary.tokens,
      reportedTotals: payload.summary.reportedTokens,
      sessionsWithUsage: payload.summary.sessionsWithUsage,
      timedOutputTokens: payload.summary.timedOutputTokens,
      timedDurationMs: payload.summary.timedDurationMs,
      speed: payload.summary.speed,
    };
  }

  const totals = emptyTokens();
  const reportedTotals = emptyTokens();
  let sessionsWithUsage = 0;
  let timedOutputTokens = 0;
  let timedDurationMs = 0;
  const map = new Map<
    string,
    {
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
    }
  >();

  for (const session of payload.sessions) {
    if (providerFilter && session.provider !== providerFilter) continue;
    const sOut = Number(session.timedOutputTokens) || 0;
    const sDur = Number(session.timedDurationMs) || 0;
    if (sOut > 0 && sDur > 0) {
      timedOutputTokens += sOut;
      timedDurationMs += sDur;
    }
    if (!session.totals) continue;
    sessionsWithUsage += 1;
    addTokens(totals, session.totals);

    if (session.modelUsage?.length) {
      for (const item of session.modelUsage) {
        let bucket = map.get(item.model);
        if (!bucket) {
          bucket = {
            model: item.model,
            providers: new Set(),
            hasReported: false,
            hasRequested: false,
            unattributed: item.model === UNATTRIBUTED_MODEL,
            tokens: emptyTokens(),
            reportedTokens: emptyTokens(),
            sessionCount: 0,
            reportedSessionCount: 0,
            turnCount: 0,
            timedOutputTokens: 0,
            timedDurationMs: 0,
          };
          map.set(item.model, bucket);
        }
        bucket.providers.add(session.provider);
        bucket.sessionCount += 1;
        bucket.turnCount += item.turnCount;
        bucket.timedOutputTokens += item.timedOutputTokens;
        bucket.timedDurationMs += item.timedDurationMs;
        addTokens(bucket.tokens, item.tokens);
        addTokens(bucket.reportedTokens, item.reportedTokens);
        addTokens(reportedTotals, item.reportedTokens);
        if (item.source === 'reported') {
          bucket.hasReported = true;
          bucket.reportedSessionCount += 1;
        } else if (item.source === 'mixed') {
          bucket.hasReported = true;
          bucket.hasRequested = true;
          if (item.reportedTokens.total > 0) bucket.reportedSessionCount += 1;
        } else if (item.source === 'requested') {
          bucket.hasRequested = true;
        } else {
          bucket.unattributed = true;
        }
      }
    } else {
      // Fallback when mocked history rows omit per-session `modelUsage`.
      const rep = session.reportedModels[0] || null;
      const rec = session.recordedModels[0] || session.configuredModel || null;
      const key = rep || rec || UNATTRIBUTED_MODEL;
      let bucket = map.get(key);
      if (!bucket) {
        bucket = {
          model: key,
          providers: new Set(),
          hasReported: false,
          hasRequested: false,
          unattributed: key === UNATTRIBUTED_MODEL,
          tokens: emptyTokens(),
          reportedTokens: emptyTokens(),
          sessionCount: 0,
          reportedSessionCount: 0,
          turnCount: 0,
          timedOutputTokens: 0,
          timedDurationMs: 0,
        };
        map.set(key, bucket);
      }
      bucket.providers.add(session.provider);
      bucket.sessionCount += 1;
      addTokens(bucket.tokens, session.totals);
      if (rep) {
        bucket.hasReported = true;
        bucket.reportedSessionCount += 1;
        addTokens(bucket.reportedTokens, session.totals);
        addTokens(reportedTotals, session.totals);
      } else if (rec) {
        bucket.hasRequested = true;
      } else {
        bucket.unattributed = true;
      }
    }
  }

  const rows: MonitorGlobalModelUsage[] = [...map.values()]
    .filter(b => b.tokens.total > 0 || b.timedDurationMs > 0)
    .map(b => {
      const source: MonitorModelAttributionSource =
        b.unattributed || b.model === UNATTRIBUTED_MODEL
          ? 'unattributed'
          : b.hasReported && b.hasRequested
            ? 'mixed'
            : b.hasReported
              ? 'reported'
              : 'requested';
      return {
        model: b.model,
        providers: [...b.providers].sort(),
        source,
        tokens: b.tokens,
        reportedTokens: b.reportedTokens,
        sessionCount: b.sessionCount,
        reportedSessionCount: b.reportedSessionCount,
        turnCount: b.turnCount,
        timedOutputTokens: b.timedOutputTokens,
        timedDurationMs: b.timedDurationMs,
        speed: computeSpeed(b.timedOutputTokens, b.timedDurationMs),
        share: totals.total > 0 ? b.tokens.total / totals.total : 0,
      };
    });

  return {
    rows,
    totals,
    reportedTotals,
    sessionsWithUsage,
    timedOutputTokens,
    timedDurationMs,
    speed: computeSpeed(timedOutputTokens, timedDurationMs),
  };
}

/**
 * Used by the Token Monitor dialog to display cross-session token totals and tok/s speed per model.
 * Stitches model attribution ranking & tok/s speed presentation from Javis603/token-monitor and Javis603/tokscale.
 */
export function ModelUsageOverview({ data }: { data: MonitorSessionsPayload | null }) {
  // Narrows the global model leaderboard to one provider without re-polling the backend.
  const [provider, setProvider] = useState('');
  // Lets the user switch between full model attribution and strictly response-reported model evidence.
  const [scope, setScope] = useState<ScopeMode>('all');
  // Controls ranking order across total tokens, generation speed (tok/s), output tokens, or session count.
  const [sortBy, setSortBy] = useState<SortMode>('tokens');

  const providers = useMemo(
    () => [...new Set(data?.sessions.map(session => session.provider) || [])].sort(),
    [data],
  );

  const computed = useMemo(() => {
    if (!data) return null;
    const base = deriveModelsFromSessions(data, provider);
    const activeTotals = scope === 'reported' ? base.reportedTotals : base.totals;
    const denominator = activeTotals.total;

    const projected = base.rows
      .map(row => {
        const activeTokens = scope === 'reported' ? row.reportedTokens : row.tokens;
        const activeSessions = scope === 'reported' ? row.reportedSessionCount : row.sessionCount;
        const activeSource: MonitorModelAttributionSource =
          scope === 'reported' ? 'reported' : row.source;
        return {
          ...row,
          activeTokens,
          activeSessions,
          activeSource,
          activeShare: denominator > 0 ? activeTokens.total / denominator : 0,
        };
      })
      .filter(row =>
        scope === 'reported'
          ? row.model !== UNATTRIBUTED_MODEL && row.activeTokens.total > 0
          : row.activeTokens.total > 0 || (row.speed !== null && row.speed > 0),
      );

    projected.sort((left, right) => {
      if (left.model === UNATTRIBUTED_MODEL && right.model !== UNATTRIBUTED_MODEL) return 1;
      if (right.model === UNATTRIBUTED_MODEL && left.model !== UNATTRIBUTED_MODEL) return -1;
      if (sortBy === 'speed') {
        const diff = (right.speed ?? -1) - (left.speed ?? -1);
        if (diff !== 0) return diff;
      } else if (sortBy === 'output') {
        const diff = right.activeTokens.output - left.activeTokens.output;
        if (diff !== 0) return diff;
      } else if (sortBy === 'sessions') {
        const diff = right.activeSessions - left.activeSessions;
        if (diff !== 0) return diff;
      }
      return (
        right.activeTokens.total - left.activeTokens.total ||
        left.model.localeCompare(right.model)
      );
    });

    const maxMetric = projected.reduce((max, row) => {
      const val =
        sortBy === 'speed'
          ? row.speed ?? 0
          : sortBy === 'output'
            ? row.activeTokens.output
            : sortBy === 'sessions'
              ? row.activeSessions
              : row.activeTokens.total;
      return Math.max(max, val);
    }, 0);

    return {
      rows: projected,
      totals: activeTotals,
      sessionsWithUsage: base.sessionsWithUsage,
      speed: base.speed,
      timedDurationMs: base.timedDurationMs,
      maxMetric,
      namedModelCount: projected.filter(row => row.model !== UNATTRIBUTED_MODEL).length,
    };
  }, [data, provider, scope, sortBy]);

  if (!data || !computed || (computed.rows.length === 0 && data.sessions.length === 0)) {
    return null;
  }

  const globalSpeedLabel = formatTokenSpeed(computed.speed);
  const globalDurationLabel = formatMonitorDuration(computed.timedDurationMs);

  return (
    <details open className="my-3 rounded-lg border border-border bg-muted/15 p-3" aria-label="全部模型用量与速度统计">
      <summary className="cursor-pointer select-none text-sm font-medium">
        全部模型 Token 用量与速度（{computed.namedModelCount} 个模型 · 总计 {computed.totals.total.toLocaleString()}
        {globalSpeedLabel ? ` · ⚡ ${globalSpeedLabel}` : ''}）
      </summary>
      <p className="my-2 text-xs text-muted-foreground">
        汇总全部历史会话（含归档）各模型的累计 Token 消耗与平均输出生成速度（排除本地工具等待耗时；AGY 沿用原生单会话快照口径不重复累加）。
      </p>

      <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <div className="min-w-0 rounded-lg border border-border bg-background/80 p-2.5">
          <div className="text-[11px] text-muted-foreground">全部模型总计</div>
          <div className="mt-0.5 truncate font-mono text-sm font-semibold">
            {computed.totals.total.toLocaleString()}
          </div>
          <div className="truncate text-[11px] text-muted-foreground">
            {computed.sessionsWithUsage} 个有记录会话
          </div>
        </div>
        <div className="min-w-0 rounded-lg border border-border bg-background/80 p-2.5">
          <div className="text-[11px] text-muted-foreground">累计输入 / 缓存读</div>
          <div className="mt-0.5 truncate font-mono text-sm font-semibold">
            {computed.totals.input.toLocaleString()}
          </div>
          <div className="truncate font-mono text-[11px] text-muted-foreground">
            缓存 {computed.totals.cacheRead.toLocaleString()}
          </div>
        </div>
        <div className="min-w-0 rounded-lg border border-border bg-background/80 p-2.5">
          <div className="text-[11px] text-muted-foreground">累计输出（含推理）</div>
          <div className="mt-0.5 truncate font-mono text-sm font-semibold">
            {computed.totals.output.toLocaleString()}
          </div>
          <div className="truncate font-mono text-[11px] text-muted-foreground">
            推理 {computed.totals.reasoning.toLocaleString()}
          </div>
        </div>
        <div className="min-w-0 rounded-lg border border-border bg-background/80 p-2.5">
          <div className="text-[11px] text-muted-foreground">平均输出速度</div>
          <div className="mt-0.5 truncate font-mono text-sm font-semibold text-emerald-600 dark:text-emerald-400">
            {globalSpeedLabel || '未记录耗时'}
          </div>
          <div className="truncate text-[11px] text-muted-foreground">
            {globalDurationLabel ? `有效计时 ${globalDurationLabel}` : '历史记录无计时'}
          </div>
        </div>
      </div>

      <div className="mb-2.5 flex flex-wrap items-center gap-2">
        <label className="flex min-w-0 flex-[1_1_8.5rem] items-center gap-1.5 text-xs">
          <span className="shrink-0 text-muted-foreground">工具</span>
          <select
            aria-label="按工具筛选模型统计"
            value={provider}
            onChange={event => setProvider(event.target.value)}
            className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1.5 text-xs"
          >
            <option value="">全部工具</option>
            {providers.map(value => (
              <option key={value} value={value}>
                {providerLabel(value)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex min-w-0 flex-[1_1_10rem] items-center gap-1.5 text-xs">
          <span className="shrink-0 text-muted-foreground">口径</span>
          <select
            aria-label="模型归因口径"
            value={scope}
            onChange={event => setScope(event.target.value as ScopeMode)}
            className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1.5 text-xs"
          >
            <option value="all">全部归因（优先真实返回）</option>
            <option value="reported">仅真实返回模型</option>
          </select>
        </label>
        <label className="flex min-w-0 flex-[1_1_9rem] items-center gap-1.5 text-xs">
          <span className="shrink-0 text-muted-foreground">排序</span>
          <select
            aria-label="模型统计排序"
            value={sortBy}
            onChange={event => setSortBy(event.target.value as SortMode)}
            className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1.5 text-xs"
          >
            <option value="tokens">总 Token 最多</option>
            <option value="speed">输出速度最快 (tok/s)</option>
            <option value="output">输出 Token 最多</option>
            <option value="sessions">会话数最多</option>
          </select>
        </label>
      </div>

      <div className="max-h-64 space-y-2 overflow-y-auto pr-0.5">
        {computed.rows.map(row => {
          const badge = sourceBadge(row.activeSource);
          const speedText = formatTokenSpeed(row.speed);
          const metricVal =
            sortBy === 'speed'
              ? row.speed ?? 0
              : sortBy === 'output'
                ? row.activeTokens.output
                : sortBy === 'sessions'
                  ? row.activeSessions
                  : row.activeTokens.total;
          const barWidth =
            computed.maxMetric > 0
              ? Math.max(2, Math.round((metricVal / computed.maxMetric) * 100))
              : 0;
          const displayName = row.model === UNATTRIBUTED_MODEL ? '未标注模型' : row.model;

          return (
            <div
              key={row.model}
              className="rounded-lg border border-border/80 bg-background p-2.5 text-xs"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1">
                <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
                  <span className="break-all font-mono font-semibold text-foreground">
                    {displayName}
                  </span>
                  <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] ${badge.className}`}>
                    {badge.text}
                  </span>
                  <span className="shrink-0 text-[11px] text-muted-foreground">
                    {row.providers.map(providerLabel).join(' / ')}
                  </span>
                </div>
                <div className="flex shrink-0 items-baseline gap-2 font-mono">
                  {speedText && (
                    <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-400">
                      ⚡ {speedText}
                    </span>
                  )}
                  <span className="font-semibold text-foreground">
                    {row.activeTokens.total.toLocaleString()}
                  </span>
                  <span className="text-[11px] text-muted-foreground">
                    {formatMonitorSharePercent(row.activeShare)}
                  </span>
                </div>
              </div>
              <div className="my-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-emerald-500/75 transition-all"
                  style={{ width: `${barWidth}%` }}
                />
              </div>
              <div className="flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[11px] text-muted-foreground">
                <span>输入 {row.activeTokens.input.toLocaleString()}</span>
                <span>输出 {row.activeTokens.output.toLocaleString()}</span>
                {row.activeTokens.cacheRead > 0 && (
                  <span>缓存读 {row.activeTokens.cacheRead.toLocaleString()}</span>
                )}
                {row.activeTokens.cacheWrite > 0 && (
                  <span>缓存写 {row.activeTokens.cacheWrite.toLocaleString()}</span>
                )}
                <span>{row.activeSessions} 会话</span>
              </div>
            </div>
          );
        })}
        {computed.rows.length === 0 && (
          <p className="py-2 text-xs text-muted-foreground">当前筛选条件下暂无匹配的模型用量记录。</p>
        )}
      </div>
    </details>
  );
}
