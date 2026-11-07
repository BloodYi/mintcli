import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { api, readApiJson } from '@/shared/api';
import type { ReplyModelEvidence, ReplyModelIndex } from '@/shared/types';

type Lookup = { index: ReplyModelIndex | null; ids: Map<string, ReplyModelEvidence | null>; times: Map<string, ReplyModelEvidence | null> };
const ReplyModelsContext = createContext<Lookup>({ index: null, ids: new Map(), times: new Map() });
function buildLookup(index: ReplyModelIndex | null): Lookup {
  const ids = new Map<string, ReplyModelEvidence | null>();
  const times = new Map<string, ReplyModelEvidence | null>();
  const add = (map: typeof ids, key: string, record: ReplyModelEvidence) => {
    if (!key) return;
    const previous = map.get(key);
    map.set(key, previous === undefined || previous && previous.requestedModel === record.requestedModel && previous.reportedModel === record.reportedModel ? record : null);
  };
  if (index) for (const record of index.models) {
    for (const id of record.messageIds) add(ids, id, record);
    add(times, timestampKey(record.timestamp), record);
  }
  return { index, ids, times };
}

/** Used by TokenMonitorProvider to share one metadata poll across every visible reply. */
export function ReplyModelProvider({ sessionId, children }: { sessionId?: string | null; children: ReactNode }) {
  // Keep the index tied to its session so late reads never label another conversation.
  const [index, setIndex] = useState<ReplyModelIndex | null>(null);
  useEffect(() => {
    if (!sessionId) return;
    const controller = new AbortController(); let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result = await readApiJson<ReplyModelIndex>(await api.tokenMonitor.replyModels(sessionId, controller.signal));
        if (!cancelled && result.sessionId === sessionId) setIndex(previous =>
          previous?.sessionId === result.sessionId && previous.status === result.status && JSON.stringify(previous.models) === JSON.stringify(result.models) ? previous : result);
      } catch { if (!cancelled) setIndex(previous => ({ sessionId, status: 'error', models: previous?.sessionId === sessionId ? previous.models : [] })); }
      finally { if (!cancelled) timer = setTimeout(poll, 3000); }
    };
    void poll();
    return () => { cancelled = true; controller.abort(); clearTimeout(timer); };
  }, [sessionId]);
  const lookup = useMemo(() => buildLookup(index?.sessionId === sessionId ? index : null), [index, sessionId]);
  return <ReplyModelsContext.Provider value={lookup}>{children}</ReplyModelsContext.Provider>;
}

function timestampKey(value: string | number | Date) {
  const number = typeof value === 'number' ? value : typeof value === 'string' && /^\d{10,13}(?:\.\d+)?$/.test(value) ? Number(value) : null;
  const time = number !== null ? number * (number < 1e12 ? 1000 : 1) : new Date(value).getTime();
  return Number.isFinite(time) ? String(time) : '';
}

/** Used by chat MessageComponent for collapsible, per-reply request/response model annotations. */
export function ReplyModelDetails({ sessionId, messageId, timestamp, model, provider }: {
  sessionId: string | null; messageId?: string; timestamp: string | number | Date; model?: string; provider: string;
}) {
  const context = useContext(ReplyModelsContext);
  const index = context.index?.sessionId === sessionId ? context.index : null;
  const lookup = index ? context : { ids: new Map<string, ReplyModelEvidence | null>(), times: new Map<string, ReplyModelEvidence | null>() };
  // Prefer exact native ids. Only an unambiguous, exact timestamp can bridge
  // legacy rows whose normalizer did not retain ids; never use nearest/last model.
  const hasId = messageId && lookup.ids.has(messageId);
  const record = (hasId ? lookup.ids.get(messageId) : null) || lookup.times.get(timestampKey(timestamp));
  const used = record?.requestedModel || model || '未记录';
  const nativeClaudeModel = provider === 'claude' && model && !model.startsWith('<') ? model : null;
  const reported = record ? record.reportedModel : hasId ? null : nativeClaudeModel;
  const real = reported || (index?.sessionId === sessionId && index.status === 'error' ? '读取失败' : !index && sessionId ? '读取中…' : '未报告');
  return <details open className="mt-1 w-fit max-w-full text-[11px] text-muted-foreground" aria-label="回复模型信息">
    <summary className="cursor-pointer select-none">模型信息</summary>
    <dl className="mt-1 grid min-w-0 gap-0.5 pl-3">
      <div className="break-all"><dt className="inline">使用模型：</dt><dd className="inline font-mono">{used}</dd></div>
      <div className="break-all"><dt className="inline">真实返回模型：</dt><dd className="inline font-mono">{real}</dd></div>
    </dl>
  </details>;
}
