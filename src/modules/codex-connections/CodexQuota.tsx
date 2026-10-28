import { useEffect, useState } from 'react';
import { api } from '@/shared/api';

type Quota = { connectionId: string; status: string; planType?: string; checkedAt?: number; reason?: string; windows: { bucket: string; minutes: number | null; remainingPercent: number | null; resetsAt: number | null }[] };

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
    <span className="font-medium">额度{current?.planType ? ` · ${current.planType}` : ''}</span>
    {current?.windows.map((window, index) => <span key={`${window.bucket}-${index}`} className="rounded border border-border px-2 py-1" title={window.resetsAt ? `重置时间：${new Date(window.resetsAt * 1000).toLocaleString()}` : '官方未返回重置时间'}>
      {window.bucket} · {duration(window.minutes)} · 剩余 {window.remainingPercent === null ? '未返回' : `${window.remainingPercent}%`}
    </span>)}
    {(!current || !current.windows.length) && <span className="min-w-0 text-muted-foreground" role="status">{current?.reason || (busy ? '正在读取官方额度…' : '暂无额度信息')}</span>}
    <button type="button" className="ml-auto shrink-0 rounded border border-border px-2 py-1 disabled:opacity-50" disabled={busy} onClick={() => setRevision(value => value + 1)} aria-label="刷新当前账号额度">{busy ? '读取中…' : '刷新额度'}</button>
  </div>;
}
