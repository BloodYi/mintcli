import { EgressButton } from '@/modules/egress';
import { useEffect, useState } from 'react';
import { api } from '@/shared/api';
import { CodexResetButton } from '@/modules/codex-connections/CodexResetButton';
import type { CodexResetCredits } from '@/shared/types';
import { QuotaWindow } from '@/shared/ui/QuotaWindow';

type Quota = { connectionId: string; status: string; planType?: string; checkedAt?: number; reason?: string; resetCredits?: CodexResetCredits | null; windows: { bucket: string; minutes: number | null; remainingPercent: number | null; resetsAt: number | null }[] };

function duration(minutes: number | null): string {
  if (minutes === null) return '额度窗口';
  if (minutes >= 1440 && minutes % 1440 === 0) return `${minutes / 1440} 天`;
  return minutes % 60 === 0 ? `${minutes / 60} 小时` : `${minutes} 分钟`;
}

/** Used by CodexConnections to show the selected account's real limits on PC and mobile. */
export function CodexQuota({ connectionId }: { connectionId?: string }) {
  // The snapshot is tied to its connection id so switching cannot display another account's limits.
  const [quota, setQuota] = useState<Quota | null>(null);
  // A revision lets the refresh button repeat the same guarded request without another timer.
  const [revision, setRevision] = useState(0);
  // Busy distinguishes a refresh in progress from an upstream missing-quota response.
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!connectionId) return;
    let cancelled = false, inflight = false;
    const refresh = async () => {
      if (inflight) return;
      inflight = true; setBusy(true);
      try {
        const response = await api.codexConnections.quota(connectionId);
        if (!response.ok) throw new Error('quota unavailable');
        const value = await response.json() as Quota;
        if (!cancelled && value.connectionId === connectionId) setQuota(value);
      } catch {
        if (!cancelled) setQuota({ connectionId, status: 'unavailable', windows: [], reason: '额度读取失败，请稍后刷新。' });
      } finally { inflight = false; if (!cancelled) setBusy(false); }
    };
    void refresh(); const timer = window.setInterval(() => void refresh(), 60000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [connectionId, revision]);
  if (!connectionId) return null;
  const current = quota?.connectionId === connectionId ? quota : null;
  return <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border bg-muted/30 px-3 py-2 text-xs" aria-label="当前账号额度" aria-busy={busy}>
    <span className="font-medium">剩余额度{current?.planType ? ` · ${current.planType}` : ''}</span>
    {Boolean(current?.windows.length) && <div className="grid w-full min-w-0 grid-cols-2 gap-2">
      {current?.windows.map((window, index) => <QuotaWindow key={`${window.bucket}-${index}`}
        label={`${window.bucket} · ${duration(window.minutes)}`} remainingPercent={window.remainingPercent} resetsAt={window.resetsAt} />)}
    </div>}
    {(!current || !current.windows.length) && <span className="min-w-0 text-muted-foreground" role="status">{current?.reason || (busy ? '正在读取官方额度…' : '暂无额度信息')}</span>}
    <button type="button" className="ml-auto shrink-0 rounded border border-border px-2 py-1 disabled:opacity-50" disabled={busy} onClick={() => setRevision(value => value + 1)} aria-label="刷新当前账号额度">{busy ? '读取中…' : '刷新额度'}</button>
    {current && 'resetCredits' in current && <CodexResetButton connectionId={connectionId} credits={current.resetCredits} onReset={() => setRevision(value => value + 1)} />}
    <EgressButton connectionId={connectionId ? "codex:" + connectionId : undefined} />
  </div>;
}
