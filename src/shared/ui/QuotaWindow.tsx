import { Clock3 } from 'lucide-react';
import { useEffect, useState } from 'react';

type QuotaWindowProps = {
  label: string;
  remainingPercent: number | null;
  resetsAt: number | null;
};

function countdown(remaining: number): string {
  if (remaining <= 0) return '已到重置时间，等待刷新';
  if (remaining < 60000) return '不到 1 分钟后重置';
  const minutes = Math.ceil(remaining / 60000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor(minutes % 1440 / 60);
  const parts = [days ? `${days} 天` : '', hours ? `${hours} 小时` : '', minutes % 60 ? `${minutes % 60} 分钟` : ''].filter(Boolean);
  return `${parts.join(' ')}后重置`;
}

/** Used by agent-connections, codex-connections and antigravity to show real quota windows and visible reset times. */
export function QuotaWindow({ label, remainingPercent, resetsAt }: QuotaWindowProps) {
  // Advance the countdown locally between provider snapshots without making extra quota requests.
  const [now, setNow] = useState(Date.now);
  const resetMilliseconds = typeof resetsAt === 'number' && Number.isFinite(resetsAt) && resetsAt > 0
    ? new Date(resetsAt * 1000).getTime()
    : NaN;
  const validReset = Number.isFinite(resetMilliseconds);
  const percent = typeof remainingPercent === 'number' && Number.isFinite(remainingPercent) && remainingPercent >= 0 && remainingPercent <= 100
    ? remainingPercent
    : null;

  useEffect(() => {
    if (!validReset) return;
    setNow(Date.now());
    if (resetMilliseconds <= Date.now()) return;
    const timer = window.setInterval(() => {
      const currentTime = Date.now();
      setNow(currentTime);
      if (currentTime >= resetMilliseconds) window.clearInterval(timer);
    }, 30000);
    return () => window.clearInterval(timer);
  }, [resetMilliseconds, validReset]);

  const resetDate = validReset ? new Date(resetMilliseconds) : null;
  const resetLabel = resetDate
    ? `${String(resetDate.getMonth() + 1).padStart(2, '0')}月${String(resetDate.getDate()).padStart(2, '0')}日 ${String(resetDate.getHours()).padStart(2, '0')}:${String(resetDate.getMinutes()).padStart(2, '0')}`
    : '';
  const color = percent === null ? 'text-muted-foreground' : percent < 20 ? 'text-red-600 dark:text-red-400' : percent < 40 ? 'text-amber-600 dark:text-amber-400' : 'text-emerald-600 dark:text-emerald-400';
  const fill = percent === null ? 'bg-muted-foreground/20' : percent < 20 ? 'bg-red-500' : percent < 40 ? 'bg-amber-500' : 'bg-emerald-500';

  return <section aria-label={`${label}额度`} className="min-w-0 rounded-lg border border-border bg-background px-2.5 py-2 text-xs shadow-sm sm:rounded-xl sm:p-2.5">
    <div className="flex items-center justify-between gap-2">
      <span className="min-w-0 truncate text-[11px] font-medium leading-4 sm:text-xs">{label}</span>
      <span className={`shrink-0 text-[11px] font-semibold tabular-nums leading-4 sm:text-xs ${color}`}>{percent === null ? '未返回' : `${percent}%`}</span>
    </div>
    <div
      role="progressbar"
      aria-label={`${label}剩余额度`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent ?? undefined}
      aria-valuetext={percent === null ? '额度未返回' : `剩余 ${percent}%`}
      className="my-1.5 h-1.5 overflow-hidden rounded-full bg-muted"
    >
      <div aria-hidden="true" className={`h-full rounded-full ${fill}`} style={{ width: percent === null ? '100%' : `${percent}%` }} />
    </div>
    <div className="flex items-start gap-1 text-[10px] leading-3.5 text-muted-foreground sm:text-[11px] sm:leading-4">
      <Clock3 aria-hidden="true" className="mt-0.5 h-2.5 w-2.5 shrink-0 opacity-75 sm:h-3 sm:w-3" />
      {resetDate ? <div className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
        <span className="shrink-0">重置 <time dateTime={resetDate.toISOString()} title={resetDate.toLocaleString('zh-CN', { timeZoneName: 'short' })} className="tabular-nums">{resetLabel}</time></span>
        <p className={'min-w-0 truncate ' + (resetMilliseconds <= now ? 'text-amber-600 dark:text-amber-400' : '')}>{countdown(resetMilliseconds - now)}</p>
      </div> : <span>重置时间暂未提供</span>}
    </div>
  </section>;
}
