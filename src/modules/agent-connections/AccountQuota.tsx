import { CodexResetButton } from '@/modules/codex-connections';
import type { CodexResetCredits } from '@/shared/types';
import { EgressButton } from '@/modules/egress';
import { ChevronDown, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, readApiJson } from '@/shared/api';
import { MonitorButton } from '@/modules/token-monitor';
import { QuotaWindow } from '@/shared/ui/QuotaWindow';
type Quota = { resetCredits?: CodexResetCredits | null; connectionId: string; status: string; planType?: string; checkedAt?: number; reason?: string; source?: string; dashboardUrl?: string; windows: { bucket: string; model?: string; type?: string; minutes?: number | null; remainingPercent: number | null; resetsAt: number | null }[] };
/** Used by AgentConnections. Guards identity across slow quota responses and keeps unavailable values distinct from zero. */
export function AccountQuota({
  id,
  embedded = false,
  showUtilities = !embedded,
}: {
  id?: string;
  embedded?: boolean;
  showUtilities?: boolean;
}) {
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
  if (embedded) {
    const hasProviderReset = Boolean(id?.startsWith('codex:') || id?.startsWith('claude:'));
    return (
      <div
        className="space-y-3 rounded-2xl border border-border/55 bg-card/85 p-3.5 text-xs shadow-sm"
        aria-label="当前账号额度"
        aria-busy={busy}
      >
        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <button
              type="button"
              aria-expanded={!collapsed}
              aria-label={collapsed ? '展开账号额度' : '收起账号额度'}
              onClick={toggleCollapsed}
              className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden text-left"
            >
              <strong className="shrink-0 text-[13px] font-semibold text-foreground">剩余额度</strong>
              {current?.planType && (
                <span className="min-w-0 truncate rounded-full bg-primary/10 px-2 py-0.5 text-[10.5px] font-medium text-primary">
                  {current.planType}
                </span>
              )}
              <span className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-muted/70 px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                {collapsed ? '展开' : '收起'}
                <ChevronDown
                  className={`h-3 w-3 transition-transform duration-200 ${collapsed ? '' : 'rotate-180'}`}
                  aria-hidden="true"
                />
              </span>
            </button>

            <div className="flex shrink-0 items-center gap-1.5">
              <button
                type="button"
                disabled={busy || !id}
                aria-label="刷新额度"
                className="inline-flex h-7 shrink-0 items-center gap-1 rounded-full border border-border/70 bg-background px-2.5 text-[11px] font-medium text-foreground/85 transition-colors active:scale-95 hover:bg-muted/60 disabled:opacity-50"
                onClick={() => setRevision(value => value + 1)}
              >
                <RefreshCw className={`h-3 w-3 ${busy ? 'animate-spin' : ''}`} aria-hidden="true" />
                <span>刷新</span>
              </button>
              {showUtilities && <EgressButton connectionId={id} />}
              {showUtilities && <MonitorButton />}
            </div>
          </div>

          {hasProviderReset && (
            <div
              className="flex flex-wrap items-center justify-between gap-x-2.5 gap-y-1.5 border-t border-border/45 pt-2"
              data-testid="embedded-quota-actions"
            >
              {id?.startsWith('codex:') && (
                <CodexResetButton
                  connectionId={id.slice(6)}
                  credits={current?.resetCredits}
                  onReset={() => setRevision(value => value + 1)}
                  embedded
                />
              )}
              {id?.startsWith('claude:') && (
                <a
                  href="https://claude.ai/settings/usage"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex h-7 shrink-0 items-center rounded-full border border-border/70 bg-background px-2.5 text-[11px] font-medium text-foreground/85 hover:bg-muted/60"
                  title="在 Claude 官方用量页使用重置卡；请核对登录账号，完成后刷新额度"
                >
                  使用重置卡 ↗
                </a>
              )}
            </div>
          )}
        </div>

        {!collapsed && (
          <div className="space-y-2.5">
            {groups.size > 0 && (
              <div className="space-y-2.5" aria-label="agy 模型额度分组">
                {[...groups].map(([name, windows]) => (
                  <section key={name} className="space-y-1.5">
                    <h3 className="px-0.5 text-[11px] font-medium text-muted-foreground">{groupName(name)}</h3>
                    <div className={windows.length > 1 ? 'grid grid-cols-2 gap-2' : 'grid grid-cols-1 gap-2'}>
                      {[...windows]
                        .sort((a, b) => order(a.type) - order(b.type))
                        .map((window, index) => (
                          <QuotaWindow
                            key={index}
                            label={
                              window.type === 'weekly'
                                ? '每周配额剩余'
                                : window.type === 'five_hour'
                                  ? '5 小时配额剩余'
                                  : window.type === 'daily'
                                    ? '每日配额剩余'
                                    : window.bucket
                            }
                            remainingPercent={window.remainingPercent}
                            resetsAt={window.resetsAt}
                          />
                        ))}
                    </div>
                  </section>
                ))}
              </div>
            )}

            {!groups.size && Boolean(current?.windows.length) && (
              <div className={current && current.windows.length > 1 ? 'grid grid-cols-2 gap-2' : 'grid grid-cols-1 gap-2'}>
                {current?.windows.map((window, index) => (
                  <QuotaWindow
                    key={`${window.bucket}-${index}`}
                    label={
                      window.bucket +
                      (window.minutes
                        ? ` · ${window.minutes >= 1440 ? window.minutes / 1440 + ' 天' : window.minutes / 60 + ' 小时'}`
                        : '')
                    }
                    remainingPercent={window.remainingPercent}
                    resetsAt={window.resetsAt}
                  />
                ))}
              </div>
            )}

            {!current?.windows.length && (
              <p className="rounded-xl bg-muted/40 px-3 py-2 text-xs text-muted-foreground" role="status">
                {current?.reason || (busy ? '正在读取原生额度…' : '请选择账号')}
              </p>
            )}

            {(current?.dashboardUrl || current?.checkedAt) && (
              <div className="flex flex-wrap items-center justify-between gap-2 pt-0.5 text-[11px] text-muted-foreground">
                {current?.checkedAt ? (
                  <time dateTime={new Date(current.checkedAt).toISOString()} title={current.source}>
                    更新于 {new Date(current.checkedAt).toLocaleTimeString()}
                  </time>
                ) : <span />}
                {current?.dashboardUrl &&
                  ['https://cursor.com/dashboard?tab=usage', 'https://opencode.ai/console'].includes(current.dashboardUrl) && (
                    <a
                      href={current.dashboardUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-medium text-primary underline"
                    >
                      查看官方额度 ↗
                    </a>
                  )}
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  return <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 border-b border-border bg-muted/30 px-2.5 py-1.5 text-xs sm:px-3 sm:py-2" aria-label="当前账号额度" aria-busy={busy}>
    <div className="flex w-full flex-wrap items-center gap-1.5 sm:gap-2">
      <strong className="shrink-0 text-xs">剩余额度{current?.planType ? ' · ' + current.planType : ''}</strong>
      <button type="button" aria-expanded={!collapsed} aria-label={collapsed ? '展开账号额度' : '收起账号额度'} className="h-7 shrink-0 rounded-md border border-border bg-background px-2 text-[11px] font-medium hover:bg-muted/60 sm:text-xs" onClick={toggleCollapsed}>{collapsed ? '展开 ▾' : '收起 ▴'}</button>
      {!collapsed && current?.checkedAt && <time className="hidden text-[11px] text-muted-foreground sm:inline" dateTime={new Date(current.checkedAt).toISOString()} title={current.source}>更新于 {new Date(current.checkedAt).toLocaleTimeString()}</time>}
      <div className="ml-auto flex flex-wrap items-center justify-end gap-1.5">
        <button type="button" disabled={busy || !id} className="h-7 shrink-0 rounded-md border border-border bg-background px-2 text-[11px] font-medium hover:bg-muted/60 disabled:opacity-50 sm:text-xs" onClick={() => setRevision(value => value + 1)}>刷新额度</button>
        {showUtilities && <EgressButton connectionId={id} />}
        {id?.startsWith('codex:') && <CodexResetButton connectionId={id.slice(6)} credits={current?.resetCredits} onReset={() => setRevision(value => value + 1)} />}
        {id?.startsWith('claude:') && <a href="https://claude.ai/settings/usage" target="_blank" rel="noopener noreferrer" className="inline-flex h-7 items-center rounded-md border border-border bg-background px-2 text-[11px] font-medium hover:bg-muted/60 sm:text-xs" title="在 Claude 官方用量页使用重置卡；请核对登录账号，完成后刷新额度">使用重置卡 ↗</a>}
        {showUtilities && <MonitorButton />}
      </div>
    </div>
    {!collapsed && <>
    {groups.size > 0 && <div className="flex w-full min-w-0 max-w-full snap-x gap-2 overflow-x-auto pb-0.5 sm:gap-3" aria-label="agy 模型额度分组">
      {[...groups].map(([name, windows]) => <section key={name} className="min-w-[17.5rem] flex-1 snap-start space-y-1 sm:min-w-[14rem] sm:space-y-1.5">
        <h3 className="px-0.5 text-[11px] font-medium text-muted-foreground sm:text-xs">{groupName(name)}</h3>
        <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-1">
          {[...windows].sort((a, b) => order(a.type) - order(b.type)).map((window, index) => <QuotaWindow key={index}
            label={window.type === 'weekly' ? '每周配额剩余' : window.type === 'five_hour' ? '5 小时配额剩余' : window.type === 'daily' ? '每日配额剩余' : window.bucket}
            remainingPercent={window.remainingPercent} resetsAt={window.resetsAt} />)}
        </div>
      </section>)}
    </div>}
    {!groups.size && Boolean(current?.windows.length) && <div className="grid w-full min-w-0 grid-cols-2 gap-1.5 sm:gap-2">
      {current?.windows.map((window, index) => <QuotaWindow key={`${window.bucket}-${index}`}
        label={window.bucket + (window.minutes ? ` · ${window.minutes >= 1440 ? window.minutes / 1440 + ' 天' : window.minutes / 60 + ' 小时'}` : '')}
        remainingPercent={window.remainingPercent} resetsAt={window.resetsAt} />)}
    </div>}
    {!current?.windows.length && <span className="text-muted-foreground" role="status">{current?.reason || (busy ? '正在读取原生额度…' : '请选择账号')}</span>}
    {current?.dashboardUrl && ['https://cursor.com/dashboard?tab=usage', 'https://opencode.ai/console'].includes(current.dashboardUrl) && <a href={current.dashboardUrl} target="_blank" rel="noopener noreferrer" className="text-primary underline">查看官方额度</a>}
    {current?.checkedAt && <time className="text-[10.5px] text-muted-foreground sm:hidden" dateTime={new Date(current.checkedAt).toISOString()} title={current.source}>更新于 {new Date(current.checkedAt).toLocaleTimeString()}</time>}
    </>}
  </div>;
}
