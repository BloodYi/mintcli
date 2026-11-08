import { useEffect, useState } from 'react';
import { Network, RefreshCw } from 'lucide-react';
import { api, readApiJson } from '@/shared/api';
import { Dialog, DialogContent, DialogTitle } from '@/shared/ui';

type Routing = { configured: boolean; updatedAt: string | null; source?: string; nodes: { id: string; name: string; port: number }[]; selections: Record<string, string>; probes?: Record<string, Probe> };
type Target = { id: string; name: string };
type Probe = { nodeId: string; ok: boolean; ip?: string; country?: string; latencyMs?: number; error?: string };
const CLI_TARGETS = [{ id: 'codex', name: 'Codex CLI' }, { id: 'claude', name: 'Claude CLI' }, { id: 'antigravity', name: 'Antigravity · agy' }, { id: 'cursor', name: 'Cursor CLI' }, { id: 'opencode', name: 'OpenCode CLI' }];
const button = 'rounded-lg border border-border px-3 py-2 text-xs hover:bg-muted disabled:opacity-50';

/** Used by account quota bars to manage independent CLI and third-party API egress choices. */
export function EgressButton({ connectionId }: { connectionId?: string }) {
  // The dialog loads routing only on demand so quota refreshes do not issue extra network requests.
  const [open, setOpen] = useState(false);
  // Keep node inventory and saved selections together so a save displays the server's confirmed choice.
  const [data, setData] = useState<{ routing: Routing; targets: Target[] } | null>(null);
  // Serialize user operations and distinguish the selected diagnostic from an idle row.
  const [busy, setBusy] = useState('');
  // Retain the last measured exit for each node while the dialog is open.
  const [probes, setProbes] = useState<Record<string, Probe>>({});
  // Surface failed reads and writes without implying that a choice was applied.
  const [notice, setNotice] = useState('');
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    let cancelled = false;
    setBusy('load'); setNotice('');
    void Promise.all([
      api.egress.status(controller.signal).then(readApiJson<Routing>),
      api.codexConnections.list().then(readApiJson<{ connections: { id: string; name: string; kind: string }[] }>),
    ]).then(([routing, accounts]) => {
      if (!cancelled) { setProbes(routing.probes || {}); setData({ routing, targets: [...CLI_TARGETS, ...accounts.connections.filter(item => item.kind === 'api').map(item => ({ id: 'api:' + item.id, name: item.name + ' · API' }))] }); }
    }).catch(error => { if (!cancelled) setNotice(error instanceof Error ? error.message : '节点读取失败'); })
      .finally(() => { if (!cancelled) setBusy(''); });
    return () => { cancelled = true; controller.abort(); };
  }, [open]);
  const run = async (key: string, action: () => Promise<void>) => {
    if (busy) return;
    setBusy(key); setNotice('');
    try { await action(); } catch (error) { setNotice(error instanceof Error ? error.message : '节点操作失败，请重试'); }
    finally { setBusy(''); }
  };
  const currentTarget = data?.targets.find(target => target.id === 'api:' + connectionId?.replace(/^codex:/, ''))?.id || connectionId?.split(':')[0];
  return <>
    <button type="button" aria-label="选择代理节点" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)} className="flex h-8 shrink-0 items-center gap-1 rounded-lg border border-border px-2 text-xs hover:bg-muted"><Network className="h-3.5 w-3.5" /><span>节点</span></button>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-h-[88dvh] w-[calc(100%-1.5rem)] space-y-4 overflow-y-auto p-4 sm:max-w-3xl sm:p-6" aria-describedby="egress-help">
        <DialogTitle>代理节点</DialogTitle>
        <p id="egress-help" className="text-sm text-muted-foreground">为各 CLI 和第三方 API 分别选择出口，选择后自动保存，对后续请求生效。正在生成的回复继续使用原节点。仅影响这台 VPS 的 AI CLI，不修改你的 Clash 聚合订阅。</p>
        {notice && <p role="status" className="rounded-lg border border-border bg-muted p-3 text-sm">{notice}</p>}
        {busy === 'load' && <p role="status">正在读取节点…</p>}
        {data && <>
          {!data.routing.configured && <p role="status" className="text-sm text-amber-600">代理服务尚未配置，请先配置订阅。</p>}
          {data.routing.source === 'snapshot' && <p className="rounded-lg bg-muted p-3 text-xs text-muted-foreground">当前使用已保存的本地配置，共 {data.routing.nodes.length} 个出口选项。聚合链接暂不可用；刷新只读取订阅，失败时保留现有配置。</p>}
          <div className="space-y-2" aria-label="各服务出口">
            {data.targets.map(target => {
              const selected = data.routing.selections[target.id] || 'legacy';
              return <label key={target.id} className={'grid min-w-0 gap-2 rounded-xl border p-3 sm:grid-cols-[11rem_minmax(0,1fr)] sm:items-center ' + (target.id === currentTarget ? 'border-primary/50 bg-primary/5' : 'border-border')}>
                <span className="min-w-0 break-words text-sm font-medium">{target.name}{target.id === currentTarget && <span className="ml-2 text-xs text-muted-foreground">当前</span>}</span>
                <select aria-label={target.name + ' 的出口节点'} className="min-w-0 max-w-full rounded-lg border border-border bg-background px-2 py-2 text-sm" value={selected} disabled={Boolean(busy) || !data.routing.configured} onChange={event => { const nodeId = event.target.value; void run(target.id, async () => { const routing = await readApiJson<Routing>(await api.egress.select(target.id, nodeId)); setData(previous => previous ? { ...previous, routing } : previous); setNotice(target.name + ' 已保存，后续请求使用所选出口'); }); }}>
                  {!data.routing.nodes.some(node => node.id === selected) && <option value={selected}>原节点已不可用，请重新选择</option>}
                  {data.routing.nodes.map(node => <option key={node.id} value={node.id}>{node.name}</option>)}
                </select>
              </label>;
            })}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
            <div><h3 className="text-sm font-medium">节点检测</h3><p className="text-xs text-muted-foreground">检测 HTTPS 连通性和出口 IP；模型 API 是否允许此出口，需实际请求确认。</p></div>
            <button type="button" className={button + ' flex items-center gap-1'} disabled={Boolean(busy)} onClick={() => void run('sync', async () => { const routing = await readApiJson<Routing>(await api.egress.sync()); setData(previous => previous ? { ...previous, routing } : previous); setProbes({}); setNotice('本地节点已刷新'); })}><RefreshCw className={'h-3.5 w-3.5 ' + (busy === 'sync' ? 'animate-spin' : '')} />{busy === 'sync' ? '刷新中…' : '刷新本地节点'}</button>
          </div>
          <div className="space-y-1">
            {data.routing.nodes.map(node => <div key={node.id} className="flex min-w-0 flex-wrap items-center gap-2 rounded-lg border border-border p-2 text-xs">
              <span className="min-w-0 flex-1 break-words">{node.name}</span>
              <button type="button" className={button} disabled={Boolean(busy)} aria-label={'检测 ' + node.name} onClick={() => void run('probe:' + node.id, async () => { const result = await readApiJson<Probe>(await api.egress.probe(node.id)); setProbes(previous => ({ ...previous, [node.id]: result })); })}>{busy === 'probe:' + node.id ? '检测中…' : '检测'}</button>
              {probes[node.id] && <span role="status" className={'w-full break-words ' + (probes[node.id].ok ? 'text-green-600 dark:text-green-400' : 'text-amber-600')}>{probes[node.id].ok ? `${probes[node.id].ip} · ${probes[node.id].country || ''} · ${probes[node.id].latencyMs} ms` : probes[node.id].error}</span>}
            </div>)}
          </div>
        </>}
      </DialogContent>
    </Dialog>
  </>;
}
