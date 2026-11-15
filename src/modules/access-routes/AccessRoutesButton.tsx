import { useEffect, useState } from 'react';
import { Network, ExternalLink, Check } from 'lucide-react';

import { api, readApiJson } from '@/shared/api';
import { Dialog, DialogContent, DialogTitle } from '@/shared/ui';

type AccessRoute = { id: string; name: string; origin: string };
type RouteStatus = { routes: AccessRoute[]; defaultId: string | null };

/** Used by the sidebar header to choose the website entrance without changing CLI or model API proxy selections. */
export function AccessRoutesButton() {
  // Load website entrances only while their chooser is open.
  const [open, setOpen] = useState(false);
  // Retain the server-confirmed list without deriving it from API egress choices.
  const [status, setStatus] = useState<RouteStatus | null>(null);
  // Explain an unavailable entrance list while preserving all existing selections.
  const [error, setError] = useState('');
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    void api.accessRoutes.status(controller.signal).then(readApiJson<RouteStatus>)
      .then(value => { if (!controller.signal.aborted) setStatus(value); })
      .catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '访问线路读取失败'); });
    return () => controller.abort();
  }, [open]);
  return <>
    <button type="button" title="网站访问线路" aria-label="网站访问线路" aria-haspopup="dialog" aria-expanded={open} onClick={() => { setStatus(null); setError(''); setOpen(true); }} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground">
      <Network className="h-4 w-4" />
    </button>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="w-[calc(100%-1.5rem)] space-y-4 p-4 sm:max-w-lg sm:p-6" aria-describedby="access-routes-help">
        <DialogTitle>网站访问线路</DialogTitle>
        <p id="access-routes-help" className="text-sm text-muted-foreground">选择你连接 mintcli 的线路。模型 API 的出口仍在“节点”中独立选择。</p>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        {!status && !error && <p role="status" className="text-sm text-muted-foreground">正在读取线路…</p>}
        {status && <div className="space-y-2">
          {status.routes.map(route => {
            const current = route.origin === window.location.origin;
            const href = new URL(window.location.pathname + window.location.search + window.location.hash, route.origin).href;
            return <a key={route.id} href={href} onClick={event => { if (current) { event.preventDefault(); setOpen(false); } }} className={'flex min-w-0 items-center gap-3 rounded-xl border p-3 hover:bg-muted ' + (current ? 'border-primary/50 bg-primary/5' : 'border-border')}>
              <div className="min-w-0 flex-1"><div className="break-words text-sm font-medium">{route.name}{route.id === status.defaultId && <span className="ml-2 text-xs text-muted-foreground">默认</span>}</div><div className="truncate text-xs text-muted-foreground">{new URL(route.origin).hostname}</div></div>
              {current ? <span className="flex shrink-0 items-center gap-1 text-xs text-primary"><Check className="h-3.5 w-3.5" />当前</span> : <ExternalLink className="h-4 w-4 shrink-0" />}
            </a>;
          })}
          {!status.routes.length && <p className="text-sm text-muted-foreground">暂未配置其他网站访问线路。</p>}
        </div>}
        <p className="text-xs text-muted-foreground">首次使用其他域名可能需要重新登录，会话和账号共用。</p>
      </DialogContent>
    </Dialog>
  </>;
}
