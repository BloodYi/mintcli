import { useEffect, useState } from 'react';
import { api, readApiJson } from '@/shared/api';
import { MonitorButton } from '@/modules/token-monitor';
type Quota = { connectionId: string; status: string; planType?: string; checkedAt?: number; reason?: string; source?: string; dashboardUrl?: string; windows: { bucket: string; model?: string; type?: string; minutes?: number | null; remainingPercent: number | null; resetsAt: number | null }[] };
/** Used by AgentConnections. Guards identity across slow quota responses and keeps unavailable values distinct from zero. */
export function AccountQuota({ id }: { id?: string }) {
  // Keep the user’s compact quota preference across refreshes and account switches.
  const [collapsed, setCollapsed] = useState(() => { try { return localStorage.getItem('account-quota-collapsed') === 'true'; } catch { return false; } });
  const toggleCollapsed = () => setCollapsed(value => { const next = !value; try { localStorage.setItem('account-quota-collapsed', String(next)); } catch { /* Storage may be disabled. */ } return next; });
  // Every snapshot carries the identity it was measured for.
  const [quota, setQuota] = useState<Quota | null>(null);
  // Manual refresh asks the native CLI; ordinary refresh can use its recent snapshot.
  const [revision, setRevision] = useState(0);
  // Disable duplicate refreshes while the current request is pending.
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!id) return;
    let cancelled = false, inflight = false;
    const refresh = async (force: boolean) => {
      if (inflight) return; inflight = true; setBusy(true);
      try { const result = await readApiJson<Quota>(await api.agentConnections.quota(id, force)); if (!cancelled && result.connectionId === id) setQuota(result); }
      catch (error) { if (!cancelled) setQuota({ connectionId: id, status: 'unavailable', windows: [], reason: error instanceof Error ? error.message : '额度读取失败' }); }
      finally { inflight = false; if (!cancelled) setBusy(false); }
    };
    void refresh(revision > 0); const timer = setInterval(() => void refresh(false), 60000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [id, revision]);
  const current = quota?.connectionId === id ? quota : null;
  // Group only windows returned for this account; Argon entitlement is never inferred.
  const groups = new Map<string, NonNullable<typeof current>['windows']>();
  if (id?.startsWith('antigravity:')) for (const window of current?.windows || []) {
    const name = window.model || window.bucket;
    groups.set(name, [...(groups.get(name) || []), window]);
  }
  const groupName = (name: string) => /^Gemini Models$/i.test(name) ? 'Gemini 模型' : /^Claude and GPT models$/i.test(name) ? 'Claude 与 GPT 模型' : name;
  const order = (type?: string) => type === 'weekly' ? 0 : type === 'five_hour' ? 1 : 2;
  return <div className="flex flex-wrap items-center gap-2 border-b border-border bg-muted/30 px-3 py-2 text-xs" aria-label="当前账号额度" aria-busy={busy}>
    <strong>额度{current?.planType ? ' · ' + current.planType : ''}</strong>
    <button type="button" aria-expanded={!collapsed} aria-label={collapsed ? '展开账号额度' : '收起账号额度'} className="rounded border border-border px-2 py-1" onClick={toggleCollapsed}>{collapsed ? '展开 ▾' : '收起 ▴'}</button>
    {!collapsed && <>
    {groups.size > 0 && <div className="flex w-full min-w-0 max-w-full divide-x divide-border overflow-x-auto rounded-xl border border-border bg-background lg:w-auto lg:flex-1" aria-label="agy 模型额度分组">
      {[...groups].map(([name, windows]) => <section key={name} className="min-w-[10rem] flex-1 px-3 py-2">
        <h3 className="mb-1 whitespace-nowrap text-muted-foreground">{groupName(name)}</h3>
        {[...windows].sort((a, b) => order(a.type) - order(b.type)).map((window, index) => <div key={index} className="flex items-center gap-2 py-1" title={window.resetsAt ? '重置：' + new Date(window.resetsAt * 1000).toLocaleString() : '未返回重置时间'}>
          <span className="mr-auto whitespace-nowrap">{window.type === 'weekly' ? '每周配额剩余' : window.type === 'five_hour' ? '5 小时配额剩余' : window.type === 'daily' ? '每日配额剩余' : window.bucket}</span>
          <span className="shrink-0 tabular-nums">{window.remainingPercent === null ? '未返回' : window.remainingPercent + '%'}</span>
          <span aria-hidden="true" className={'inline-block h-3.5 w-3.5 shrink-0 rounded-full border-2 ' + (window.remainingPercent === null ? 'border-muted-foreground' : window.remainingPercent < 20 ? 'border-red-500' : 'border-green-600')} />
        </div>)}
      </section>)}
    </div>}
    {!groups.size && current?.windows.map((window, index) => <span key={index} className="rounded border border-border px-2 py-1" title={window.resetsAt ? '重置：' + new Date(window.resetsAt * 1000).toLocaleString() : '未返回重置时间'}>{window.bucket}{window.minutes ? ` · ${window.minutes >= 1440 ? window.minutes / 1440 + ' 天' : window.minutes / 60 + ' 小时'}` : ''} · 剩余 {window.remainingPercent === null ? '未返回' : window.remainingPercent + '%'}</span>)}
    {!current?.windows.length && <span className="text-muted-foreground" role="status">{current?.reason || (busy ? '正在读取原生额度…' : '请选择账号')}</span>}
    {current?.dashboardUrl && ['https://cursor.com/dashboard?tab=usage', 'https://opencode.ai/console'].includes(current.dashboardUrl) && <a href={current.dashboardUrl} target="_blank" rel="noopener noreferrer" className="text-primary underline">查看官方额度</a>}
    {current?.checkedAt && <time className="text-muted-foreground" dateTime={new Date(current.checkedAt).toISOString()} title={current.source}>更新于 {new Date(current.checkedAt).toLocaleTimeString()}</time>}
    </>}
    <div className="ml-auto flex items-center gap-2">
    <button type="button" disabled={busy || !id} className="ml-auto rounded border border-border px-2 py-1 disabled:opacity-50" onClick={() => setRevision(value => value + 1)}>刷新额度</button>
    <MonitorButton />
    </div>
  </div>;
}
