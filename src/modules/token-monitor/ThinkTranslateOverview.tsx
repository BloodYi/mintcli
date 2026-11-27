import type { MonitorThinkTranslateSummary } from '@/shared/types';
import { formatMonitorDuration, formatTokenSpeed } from '@/shared/utils';

const count = (value: number) => value.toLocaleString();

function formatRemainingCooldown(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '即将恢复';
  if (seconds >= 3600) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return m > 0 ? `${h}h${m}m` : `${h}h`;
  }
  if (seconds >= 60) {
    return `${Math.ceil(seconds / 60)}m`;
  }
  return `${Math.ceil(seconds)}s`;
}

/** Used by TokenMonitor dialog to display thinking-translation model usage, tok/s throughput, and quota failover status. */
export function ThinkTranslateOverview({
  summary,
}: {
  summary?: MonitorThinkTranslateSummary | null;
}) {
  if (!summary) return null;

  const speedLabel = formatTokenSpeed(summary.speed);
  const hasAlerts = summary.cooldowns.length > 0 || summary.fallbackCalls > 0 || summary.failedCalls > 0;

  return (
    <details open={hasAlerts} className="my-3 rounded-lg border border-border p-3">
      <summary className="flex cursor-pointer flex-wrap items-center justify-between gap-2 text-sm font-medium">
        <span>
          思考翻译模型监控
          {summary.totalCalls > 0
            ? `（累计 ${count(summary.totalCalls)} 次${summary.fallbackCalls > 0 ? ` · 自动容灾 ${count(summary.fallbackCalls)} 次` : ''}）`
            : '（暂无调用）'}
        </span>
        <span className="flex items-center gap-2 font-mono text-xs text-muted-foreground">
          {speedLabel && <span className="text-emerald-700 dark:text-emerald-400">⚡ {speedLabel}</span>}
          <span>{count(summary.tokens.total)} tokens</span>
        </span>
      </summary>

      <div className="mt-2.5 space-y-2.5 text-xs">
        <p className="text-muted-foreground">
          当前配置账号：
          <span className="font-mono text-foreground">{summary.configuredAccountId || '跟随当前活跃账号'}</span>
          {' · '}
          配置模型：
          <span className="font-mono text-foreground">{summary.configuredModel || '默认轻量模型'}</span>
          <span className="ml-1.5 text-[11px]">（翻译用量独立计量，不计入上方对话会话总计）</span>
        </p>

        {summary.cooldowns.length > 0 && (
          <div role="status" className="space-y-1 rounded-md border border-amber-500/40 bg-amber-500/10 p-2.5 text-amber-700 dark:text-amber-300">
            <p className="font-medium">已自动旁路额度受限的翻译账号（自动切换健康账号继续翻译）：</p>
            {summary.cooldowns.map((cd, index) => (
              <p key={`${cd.accountId}-${cd.model}-${index}`} className="break-all font-mono text-[11px]">
                • {cd.accountId}
                {cd.model ? ` (${cd.model})` : ''}：{cd.reason}（冷却剩余 {formatRemainingCooldown(cd.remainingSeconds)}）
              </p>
            ))}
          </div>
        )}

        <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <div className="rounded border border-border bg-muted/25 p-2">
            <dt className="text-[11px] text-muted-foreground">翻译总 Token</dt>
            <dd className="mt-0.5 font-mono text-sm font-semibold">{count(summary.tokens.total)}</dd>
            <p className="font-mono text-[10px] text-muted-foreground">
              输入 {count(summary.tokens.input)} · 输出 {count(summary.tokens.output)}
            </p>
          </div>
          <div className="rounded border border-border bg-muted/25 p-2">
            <dt className="text-[11px] text-muted-foreground">翻译平均速度</dt>
            <dd className="mt-0.5 font-mono text-sm font-semibold text-emerald-700 dark:text-emerald-400">
              {speedLabel ? `⚡ ${speedLabel}` : '—'}
            </dd>
            <p className="font-mono text-[10px] text-muted-foreground">
              耗时 {formatMonitorDuration(summary.timedDurationMs) || '—'}
            </p>
          </div>
          <div className="rounded border border-border bg-muted/25 p-2">
            <dt className="text-[11px] text-muted-foreground">总调用 / 缓存命中</dt>
            <dd className="mt-0.5 font-mono text-sm font-semibold">
              {count(summary.totalCalls)} / {count(summary.cachedCalls)}
            </dd>
            <p className="font-mono text-[10px] text-muted-foreground">
              缓存读 {count(summary.tokens.cacheRead)}
            </p>
          </div>
          <div className="rounded border border-border bg-muted/25 p-2">
            <dt className="text-[11px] text-muted-foreground">自动容灾 / 失败</dt>
            <dd className="mt-0.5 font-mono text-sm font-semibold">
              {count(summary.fallbackCalls)} / {count(summary.failedCalls)}
            </dd>
            <p className="text-[10px] text-muted-foreground">429 自动切换备用号</p>
          </div>
        </dl>

        {summary.models.length > 0 && (
          <div className="space-y-1">
            <p className="text-[11px] font-medium text-muted-foreground">各翻译模型累计用量</p>
            {summary.models.map(row => {
              const rowSpeed = formatTokenSpeed(row.speed);
              return (
                <div
                  key={row.model}
                  className="flex flex-wrap items-center justify-between gap-2 rounded border border-border/70 bg-background px-2.5 py-1.5"
                >
                  <span className="min-w-0 break-all font-mono font-medium">
                    {row.model}
                    <span className="ml-1.5 rounded bg-muted px-1.5 py-0.5 font-sans text-[10px] text-muted-foreground">
                      {row.platform === 'agy' ? 'AGY' : row.platform === 'codex' ? 'Codex' : 'AGY + Codex'} · {count(row.callCount)} 次
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-2 font-mono">
                    {rowSpeed && <span className="text-emerald-700 dark:text-emerald-400">⚡ {rowSpeed}</span>}
                    <span>{count(row.tokens.total)} tokens</span>
                  </span>
                </div>
              );
            })}
          </div>
        )}

        {summary.recent.length > 0 && (
          <details className="rounded border border-border/70 bg-muted/15 p-2">
            <summary className="cursor-pointer text-[11px] font-medium text-muted-foreground">
              最近翻译调用明细（{Math.min(summary.recent.length, 15)}）
            </summary>
            <div className="mt-2 overflow-x-auto">
              <table className="w-full whitespace-nowrap text-left text-[11px]">
                <thead>
                  <tr>
                    {['时间', '账号', '真实返回/请求模型', '状态', '速度', '耗时', 'Token'].map(label => (
                      <th key={label} className="p-1.5 text-muted-foreground">{label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {summary.recent.slice(0, 15).map((item, idx) => (
                    <tr key={`${item.timestamp}-${idx}`} className="border-t border-border/60">
                      <td className="p-1.5 font-mono">
                        {item.timestamp ? new Date(item.timestamp).toLocaleTimeString() : '—'}
                      </td>
                      <td className="max-w-36 truncate p-1.5 font-mono" title={item.accountLabel}>
                        {item.accountLabel}
                      </td>
                      <td className="max-w-44 truncate p-1.5 font-mono" title={item.reportedModel || item.requestedModel || '默认'}>
                        {item.reportedModel || item.requestedModel || '默认'}
                      </td>
                      <td className="p-1.5">
                        {item.status === 'error' ? (
                          <span className="text-destructive" title={item.errorMessage || ''}>失败</span>
                        ) : item.cached ? (
                          <span className="text-muted-foreground">缓存</span>
                        ) : item.fallbackUsed ? (
                          <span className="text-amber-600 dark:text-amber-400" title={item.fallbackReason || '原账号受限，已自动切换'}>
                            容灾成功
                          </span>
                        ) : (
                          <span className="text-emerald-700 dark:text-emerald-400">正常</span>
                        )}
                      </td>
                      <td className="p-1.5 font-mono text-emerald-700 dark:text-emerald-400">
                        {formatTokenSpeed(item.tokensPerSec) || '—'}
                      </td>
                      <td className="p-1.5 font-mono text-muted-foreground">
                        {formatMonitorDuration(item.durationMs) || '—'}
                      </td>
                      <td className="p-1.5 font-mono">
                        {item.tokens ? count(item.tokens.total) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        )}
      </div>
    </details>
  );
}
