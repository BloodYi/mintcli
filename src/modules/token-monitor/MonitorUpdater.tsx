import { useEffect, useRef, useState } from 'react';
import { api, readApiJson } from '@/shared/api';

type UpdateTask = { sessionId: string; targetVersion: string; state: 'running' | 'review' | 'failed' | 'interrupted' | 'installed' };
const LABELS = { running: '更新任务运行中', review: '任务已结束，请查看验证与部署结果', failed: '更新任务失败，请查看任务记录', interrupted: '更新任务已中断，可重试', installed: '更新已生效' };

/** Used by the monitor release status row to launch and follow the persisted update conversation. */
export function MonitorUpdater({ available }: { available: boolean }) {
  // Persisted server state reconnects this view to the same task after a tab reload.
  const [task, setTask] = useState<UpdateTask | null>(null);
  // Disable repeat clicks while the server allocates the update conversation.
  const [starting, setStarting] = useState(false);
  // A failed POST or status read must be visible instead of claiming an update succeeded.
  const [error, setError] = useState('');
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController(); let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result = await readApiJson<{ task: UpdateTask | null }>(await api.tokenMonitor.updateTask(controller.signal));
        if (!cancelled) setTask(result.task);
      } catch { if (!cancelled) setError('更新任务状态读取失败，请稍后重试。'); }
      finally { if (!cancelled) timer = setTimeout(poll, 5000); }
    };
    void poll();
    return () => { cancelled = true; mounted.current = false; controller.abort(); clearTimeout(timer); };
  }, []);
  const start = async () => {
    if (starting || task?.state === 'running' || task?.state === 'review') return;
    setStarting(true); setError('');
    try {
      const result = await readApiJson<{ task: UpdateTask }>(await api.tokenMonitor.startUpdate());
      if (mounted.current) setTask(result.task);
    } catch (reason) {
      if (mounted.current) setError(reason instanceof Error ? reason.message : '更新任务启动失败。');
    } finally { if (mounted.current) setStarting(false); }
  };
  return <div className="min-w-0 text-xs">
    <button type="button" onClick={() => void start()} disabled={!available || starting || task?.state === 'running' || task?.state === 'review'}
      title="按既有规则检查、适配、验证，等待对话空闲后部署，失败回滚"
      className="shrink-0 rounded border border-border px-3 py-1 disabled:opacity-50">{starting ? '正在启动…' : task?.state === 'running' ? '更新中…' : '更新'}</button>
    {task && <p role="status" className="mt-1 break-words">{LABELS[task.state]} · <a className="underline" href={'/session/' + encodeURIComponent(task.sessionId)} target="_blank" rel="noopener noreferrer">查看更新任务</a></p>}
    {error && <p role="alert" className="mt-1 text-destructive">{error}</p>}
  </div>;
}
