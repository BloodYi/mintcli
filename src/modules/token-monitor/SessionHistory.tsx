import { useEffect, useState } from 'react';
import { api, readApiJson } from '@/shared/api';

type HistorySession = {
  sessionId: string; provider: string; title: string; archived: boolean; configuredModel: string | null;
  recordedModels: string[]; reportedModels: string[]; status: string; totals: { total: number } | null;
};

/** Used by the monitor dialog to browse every indexed conversation without switching the active chat. */
export function SessionHistory({ selectedId, onSelect, revision }: { selectedId?: string | null; onSelect: (id: string) => void; revision: number }) {
  // The history index is loaded only while the inspector is open, independently of reply polling.
  const [sessions, setSessions] = useState<HistorySession[] | null>(null);
  // Search filters the complete returned index locally without triggering repeated disk scans.
  const [query, setQuery] = useState('');
  // Tool selection narrows the same full index and remains active as new sessions arrive.
  const [provider, setProvider] = useState('');
  // Index failures stay visible without replacing a successfully loaded conversation snapshot.
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController(); let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const data = await readApiJson<{ sessions: HistorySession[] }>(await api.tokenMonitor.sessions(controller.signal));
        if (!cancelled) { setSessions(data.sessions); setError(''); }
      } catch { if (!cancelled) setError('历史会话读取失败，请刷新监控重试。'); }
      finally { if (!cancelled) timer = setTimeout(poll, 15000); }
    };
    void poll();
    return () => { cancelled = true; controller.abort(); clearTimeout(timer); };
  }, [revision]);
  const providers = [...new Set(sessions?.map(session => session.provider) || [])].sort();
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const filtered = sessions?.filter(session => (!provider || session.provider === provider)
    && terms.every(term => [session.sessionId, session.title, session.provider, session.provider === 'antigravity' ? 'AGY' : '', session.configuredModel, ...session.recordedModels, ...session.reportedModels].join(' ').toLowerCase().includes(term)));
  return <details className="my-3 rounded-lg border border-border p-3">
    <summary className="cursor-pointer text-sm font-medium">全部历史会话{sessions ? `（${sessions.length}，含归档）` : ''}</summary>
    <p className="my-2 text-xs text-muted-foreground">可直接查看其他对话；历史请求模型与接口返回模型分别标注。缺失的返回字段无法从所选模型还原。</p>
    <input aria-label="搜索历史会话" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索标题、工具、模型或会话 ID" className="mb-2 w-full rounded border border-border bg-background p-2 text-sm" />
    <label className="mb-2 flex items-center gap-2 text-xs">按工具筛选
      <select aria-label="按工具筛选历史会话" value={provider} onChange={event => setProvider(event.target.value)} className="min-w-0 flex-1 rounded border border-border bg-background p-2 text-sm">
        <option value="">全部工具</option>
        {providers.map(value => <option key={value} value={value}>{value === 'antigravity' ? 'AGY' : value === 'codex' ? 'Codex' : value === 'claude' ? 'Claude' : value}</option>)}
      </select>
    </label>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {!sessions && !error && <p role="status" className="text-xs">正在扫描历史用量…</p>}
    <div className="max-h-72 space-y-2 overflow-y-auto">
      {filtered?.map(session => <button type="button" key={session.sessionId} onClick={() => onSelect(session.sessionId)} aria-pressed={selectedId === session.sessionId}
        className="block w-full rounded border border-border p-2 text-left text-xs hover:bg-muted aria-pressed:bg-muted">
        <span className="block break-all font-medium">{session.title} · {session.provider}{session.archived ? ' · 已归档' : ''}</span>
        <span className="block break-all">返回模型：{session.reportedModels.join('、') || '历史未记录'}</span>
        <span className="block break-all text-muted-foreground">请求模型：{session.recordedModels.join('、') || session.configuredModel || '未记录'}</span>
        <span className="block font-mono">Token：{session.totals ? session.totals.total.toLocaleString() : '未记录'}</span>
      </button>)}
      {filtered?.length === 0 && <p className="text-xs">没有匹配的会话。</p>}
    </div>
  </details>;
}
