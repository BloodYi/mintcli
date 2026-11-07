import { ReplyModelProvider } from '@/modules/token-monitor/ReplyModels';
import { MonitorUpdater } from '@/modules/token-monitor/MonitorUpdater';
import { SessionHistory } from '@/modules/token-monitor/SessionHistory';
import { createContext, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Activity, X } from 'lucide-react';
import { api, readApiJson } from '@/shared/api';
import { Dialog, DialogContent, DialogTitle } from '@/shared/ui';
/** Disjoint token counts; reasoning is already included in output. */
type MonitorTokens = { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number; total: number };
/** Server snapshot for one session; configured and returned model identities remain separate. */
type MonitorSnapshot = {
  sessionId: string; provider: string; configuredModel: string | null; returnedModel: string | null; checkedAt: number;
  recordedModels?: string[]; reportedModels?: string[]; status: string; reason?: string; limited: boolean; totals: MonitorTokens | null; totalsScope?: string; usageNote?: string; alerts: string[];
  replies: { id: string; timestamp: string; model: string | null; content: string; raw: Record<string, unknown>; truncated: boolean }[];
  usage: { timestamp: string; tokens: MonitorTokens }[];
};
/** Cached upstream release check; unavailable is distinct from no update. */
type MonitorUpdate = { checkedAt: number; installedVersion: string; latestVersion: string | null; updateAvailable: boolean; status: string; url: string };

type MonitorContextValue = { open: boolean; toggle: () => void; snapshot: MonitorSnapshot | null; warning: boolean };
const MonitorContext = createContext<MonitorContextValue | null>(null);
const count = (value: number) => value.toLocaleString();

function TokenCounts({ tokens, native = false }: { tokens: MonitorTokens; native?: boolean }) {
  return <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3" aria-label="token 统计">
    {([['总计', tokens.total], [native ? '输入（原生）' : '输入（未缓存）', tokens.input], [native ? '输出（原生）' : '输出（含推理）', tokens.output], ['缓存读取', tokens.cacheRead], ['缓存写入', tokens.cacheWrite], [native ? '推理（原生）' : '推理（输出子集）', tokens.reasoning]] as const).map(([label, value]) => <div key={label} className="rounded-lg border border-border bg-muted/30 p-3"><dt className="text-xs text-muted-foreground">{label}</dt><dd className="mt-1 font-mono text-lg">{count(value)}</dd></div>)}
  </dl>;
}

/** Used by chat, account quotas and plugin tabs to open the same session inspector. */
export function MonitorButton({ model = false }: { model?: boolean }) {
  const monitor = useContext(MonitorContext);
  if (!monitor) return null;
  return <button type="button" aria-label={model ? '查看真实返回模型与 token' : '开关监控窗口'} aria-haspopup="dialog" aria-expanded={monitor.open}
    onClick={monitor.toggle} title={model ? '查看接口报告的模型、回复与用量' : 'Token Monitor'}
    className="flex h-8 min-w-0 items-center gap-1 rounded-lg border border-border px-2 text-xs hover:bg-muted">
    <Activity className="h-3.5 w-3.5 shrink-0" />
    <span className={model ? 'hidden max-w-32 truncate sm:inline' : ''}>{model ? (monitor.snapshot?.returnedModel ? '返回：' + monitor.snapshot.returnedModel : '真实返回') : '监控窗口'}</span>
    {monitor.warning && <span role="status" className="text-amber-600" aria-label="监控有提醒">●</span>}
  </button>;
}

/** Used by plugins to host the same inspector when the chat pane is unmounted. */
export function TokenMonitorPage({ sessionId }: { sessionId?: string | null }) {
  return <TokenMonitorProvider sessionId={sessionId}><div className="grid gap-4 p-6"><h2 className="font-medium">Token Monitor · 真实返回与用量</h2><p className="text-sm text-muted-foreground">查看全部历史会话的 token 与模型，或检查当前会话的回复原文。</p><div><MonitorButton /></div></div></TokenMonitorProvider>;
}

/** Used by ChatInterface to share one polling snapshot and dialog across both monitor entry points. */
export function TokenMonitorProvider({ sessionId, model, children }: { sessionId?: string | null; model?: string; children: ReactNode }) {
  // The user controls visibility without stopping background interface-health reminders.
  const [open, setOpen] = useState(false);
  // Snapshots retain session identity so a slow previous response can never appear in the new chat.
  const [snapshot, setSnapshot] = useState<MonitorSnapshot | null>(null);
  // Errors are tagged by session to keep unrelated chats from inheriting a failure.
  const [error, setError] = useState<{ sessionId: string; message: string } | null>(null);
  // Release metadata is shared by the two launch buttons and the inspector.
  const [update, setUpdate] = useState<MonitorUpdate | null>(null);
  // A manual refresh restarts the serial polling effect and aborts stale reads.
  const [revision, setRevision] = useState(0);
  // The inspector can browse history while retaining the active conversation identity.
  const [selection, setSelection] = useState<{ source: typeof sessionId; id: string } | null>(null);
  const inspectedId = open && selection && selection.source === sessionId ? selection.id : sessionId;
  useEffect(() => {
    const listener = (event: Event) => {
      const target = (event as CustomEvent<{ sessionId?: string }>).detail?.sessionId;
      if (!target || target === sessionId) setOpen(true);
    };
    window.addEventListener('token-monitor-open', listener);
    return () => window.removeEventListener('token-monitor-open', listener);
  }, [sessionId]);
  useEffect(() => {
    if (!inspectedId) return;
    let cancelled = false; let timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    const poll = async () => {
      try {
        const result = await readApiJson<MonitorSnapshot>(await api.tokenMonitor.snapshot(inspectedId, controller.signal));
        if (!cancelled && result.sessionId === inspectedId) { setSnapshot(result); setError(null); }
      } catch (reason) {
        if (!cancelled) setError({ sessionId: inspectedId, message: reason instanceof Error ? reason.message : '监控接口读取失败，请检查接口是否需要更新' });
      } finally { if (!cancelled) timer = setTimeout(poll, open ? 3000 : 15000); }
    };
    void poll();
    return () => { cancelled = true; controller.abort(); clearTimeout(timer); };
  }, [inspectedId, open, revision]);
  useEffect(() => {
    let cancelled = false; const controller = new AbortController();
    const check = async () => { try { const result = await readApiJson<MonitorUpdate>(await api.tokenMonitor.updates(controller.signal)); if (!cancelled) setUpdate(result); } catch { /* Session health remains available during a release-check failure. */ } };
    void check(); const timer = setInterval(check, 300000);
    return () => { cancelled = true; controller.abort(); clearInterval(timer); };
  }, []);
  const current = snapshot?.sessionId === inspectedId ? snapshot : null;
  const currentError = error && error.sessionId === inspectedId ? error.message : null;
  const warning = Boolean(currentError || current?.alerts.length || update?.updateAvailable);
  return <ReplyModelProvider sessionId={sessionId}><MonitorContext.Provider value={{ open, toggle: () => setOpen(value => !value), snapshot: current, warning }}>
    <div className="flex h-full min-h-0 flex-col">
    {warning && <div role="status" className="flex shrink-0 items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-3 py-1 text-xs">
      <span className="min-w-0 flex-1">{currentError ? '监控接口异常，请检查接口是否需要更新' : current?.alerts[0] || 'Token Monitor 有新版本，可检查更新'}</span>
      <button type="button" className="shrink-0 underline" onClick={() => setOpen(true)}>查看提醒</button>
    </div>}
    <div className="min-h-0 flex-1">{children}</div>
    </div>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-h-[90dvh] w-[calc(100%-1rem)] overflow-y-auto p-4 sm:max-w-3xl" aria-describedby="token-monitor-help">
        <div className="flex items-center gap-2"><DialogTitle>Token Monitor · 真实返回与用量</DialogTitle><button type="button" className="ml-auto p-2" aria-label="关闭监控窗口" onClick={() => setOpen(false)}><X className="h-4 w-4" /></button></div>
        <p id="token-monitor-help" className="text-xs text-muted-foreground">支持浏览全部历史会话，当前详情每 3 秒刷新。返回模型仅来自回复字段；服务商报告的名称不代表后端模型身份认证。</p>
        {open && <SessionHistory selectedId={inspectedId} revision={revision} onSelect={id => setSelection({ source: sessionId, id })} />}
        {inspectedId !== sessionId && <button type="button" className="text-xs underline" onClick={() => setSelection(null)}>返回当前会话</button>}
        {!inspectedId ? <p className="py-6 text-sm">请先选择或开始一个会话。</p> : <>
          <dl className="my-3 grid gap-2 rounded-lg bg-muted/40 p-3 text-sm sm:grid-cols-2"><div><dt className="text-xs text-muted-foreground">界面所选模型</dt><dd className="break-all">{(inspectedId === sessionId ? model : null) || current?.configuredModel || '未选择'}</dd></div><div><dt className="text-xs text-muted-foreground">最新回复报告的模型</dt><dd className="break-all font-mono">{current?.returnedModel || '未报告（不使用所选模型推断）'}</dd></div></dl>
          {!!current?.recordedModels?.length && <p className="mb-2 break-all text-xs text-muted-foreground">历史记录的请求模型：{current.recordedModels.join('、')}（请求记录）</p>}
          <button type="button" className="mb-3 rounded border border-border px-3 py-1 text-xs" onClick={() => setRevision(value => value + 1)}>刷新监控</button>
          {currentError && <p role="alert" className="mb-3 text-sm text-destructive">{currentError}</p>}
          {current?.alerts.map(alert => <p key={alert} role="alert" className="mb-2 text-sm text-amber-600">{alert}</p>)}
          {current?.status === 'unavailable' && <p role="status" className="mb-3 text-sm text-muted-foreground">{current.reason}</p>}
          {!current && !currentError && <p role="status">正在读取原始记录…</p>}
          {current?.totals ? <><p className="mb-2 text-xs text-muted-foreground">{current.totalsScope === 'native' ? '原生累计快照' : current.totalsScope === 'session' ? '会话累计用量' : '最近记录用量（非完整会话）'} · 按提供商原始用量口径展示</p><TokenCounts tokens={current.totals} native={current.totalsScope === 'native'} /></> : current?.status === 'ok' && <p className="text-sm text-muted-foreground">原始记录尚未报告 token 用量。</p>}
          {current?.usageNote && <p className="mt-2 text-xs text-muted-foreground">{current.usageNote}</p>}
          {current?.limited && <p className="mt-2 text-xs text-muted-foreground">回复正文仅读取最近 4 MiB，最多展示 30 条回复和 60 次用量；历史用量另行扫描完整记录。</p>}
          {!!current?.usage.length && <details className="mt-4"><summary className="cursor-pointer text-sm">{current.totalsScope === 'native' ? '原生累计快照' : '每次返回的 token 明细'}（{current.usage.length}）</summary><div className="mt-2 overflow-x-auto"><table className="w-full whitespace-nowrap text-left text-xs"><thead><tr>{['时间', '输入', '输出', '缓存读', '缓存写', '推理', '总计'].map(label => <th key={label} className="p-2">{label}</th>)}</tr></thead><tbody>{current.usage.map((event, index) => <tr key={index} className="border-t border-border"><td className="p-2">{event.timestamp ? new Date(event.timestamp).toLocaleTimeString() : '—'}</td>{(['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning', 'total'] as const).map(key => <td key={key} className="p-2 font-mono">{count(event.tokens[key])}</td>)}</tr>)}</tbody></table></div></details>}
          <h3 className="mb-2 mt-4 text-sm font-medium">回复原文与返回字段</h3>
          {current?.replies.map(reply => <article key={reply.id} className="mb-3 rounded-lg border border-border p-3 text-xs"><div className="mb-2 flex flex-wrap gap-2 text-muted-foreground"><time>{reply.timestamp ? new Date(reply.timestamp).toLocaleString() : '时间未报告'}</time><span className="break-all">返回模型：{reply.model || '未报告'}</span></div><pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words font-sans text-sm">{reply.content || '此条仅含用量或模型字段'}</pre><details className="mt-2"><summary className="cursor-pointer text-muted-foreground">查看原始返回字段（文本、模型、usage）</summary><pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all">{JSON.stringify(reply.raw, null, 2)}</pre></details>{reply.truncated && <p>此条回复超过展示上限，已截取前 100,000 字符。</p>}</article>)}
          {current?.status === 'ok' && !current.replies.length && <p className="text-sm text-muted-foreground">尚未记录到模型回复。</p>}
          {current && <p className="text-xs text-muted-foreground">更新于 {new Date(current.checkedAt).toLocaleTimeString()}</p>}
        </>}
        <div className="mt-4 border-t border-border pt-3 text-xs text-muted-foreground"><a href="https://github.com/Javis603/token-monitor" target="_blank" rel="noopener noreferrer" className="underline">Javis603/token-monitor</a> · mintcli 适配版{update && <> · 解析器 {update.installedVersion}<div className="mt-1 flex items-start gap-2"><p className="min-w-0 flex-1">{update.status !== 'ok' ? '上游版本检查暂不可用，稍后自动重试' : update.updateAvailable ? `发现上游新版本 ${update.latestVersion}，可更新适配器并检查接口兼容性` : `上游版本已检查：${update.latestVersion}`} · <a href={update.url} target="_blank" rel="noopener noreferrer" className="underline">查看更新</a></p><MonitorUpdater available={update.status === 'ok' && update.updateAvailable} /></div></>}</div>
      </DialogContent>
    </Dialog>
  </MonitorContext.Provider></ReplyModelProvider>;
}
