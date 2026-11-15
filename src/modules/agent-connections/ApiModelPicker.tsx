import { useEffect, useId, useRef, useState } from 'react';
import { api, readApiJson } from '@/shared/api';
import type { ApiProtocol } from '@/shared/types';

type Props = {
  accountId: string; baseUrl: string; apiKey: string; value: string; disabled: boolean;
  protocol?: ApiProtocol;
  onChange: (value: string) => void;
};

/** Used by the account manager to discover models from the current API form without saving it. */
export function ApiModelPicker({ accountId, baseUrl, apiKey, protocol, value, disabled, onChange }: Props) {
  // Keep discovery feedback and its results together; edits invalidate the entire snapshot.
  const [discovery, setDiscovery] = useState<{ status: 'idle' | 'loading' | 'loaded' | 'error'; models: string[]; message: string }>({ status: 'idle', models: [], message: '' });
  const request = useRef<AbortController | null>(null);
  const modelId = useId();
  const listId = useId();
  useEffect(() => {
    setDiscovery({ status: 'idle', models: [], message: '' });
    return () => { request.current?.abort(); request.current = null; };
  }, [accountId, baseUrl, apiKey, protocol]);

  const load = async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setDiscovery({ status: 'loading', models: [], message: '' });
    try {
      const result = await readApiJson<{ models: string[] }>(await api.codexConnections.discoverModels({
        id: accountId || undefined, baseUrl: baseUrl.trim(), apiKey: apiKey.trim() || undefined,
        ...(protocol ? { protocol } : {}),
      }, controller.signal));
      if (controller.signal.aborted) return;
      setDiscovery({ status: 'loaded', models: result.models, message: result.models.length
        ? `已拉取 ${result.models.length} 个模型，请选择或手动填写`
        : '服务商返回的模型列表为空，可手动填写模型 ID' });
    } catch (error) {
      if (!controller.signal.aborted) setDiscovery({ status: 'error', models: [], message: error instanceof Error ? error.message : '拉取模型失败，可手动填写模型 ID' });
    }
  };

  return <div className="grid min-w-0 gap-2">
    <label htmlFor={modelId} className="text-sm">默认模型</label>
    <div className="flex min-w-0 flex-wrap gap-2">
      <input id={modelId} maxLength={160} className="min-w-0 flex-1 rounded-md border border-border bg-background p-2 text-sm" value={value} placeholder="服务商提供的模型 ID" onChange={event => onChange(event.target.value)} />
      <button type="button" className="shrink-0 rounded-md border border-border px-3 py-2 text-sm disabled:opacity-50" disabled={disabled || discovery.status === 'loading' || !baseUrl.trim() || (!accountId && !apiKey.trim())} onClick={() => void load()}>{discovery.status === 'loading' ? '拉取中…' : '拉取模型'}</button>
    </div>
    {discovery.models.length > 0 && <>
      <label htmlFor={listId} className="text-xs text-muted-foreground">选择已拉取模型</label>
      <select id={listId} className="w-full min-w-0 rounded-md border border-border bg-background p-2 text-sm" value={discovery.models.includes(value) ? value : ''} onChange={event => { if (event.target.value) onChange(event.target.value); }}>
        <option value="">请选择模型（也可在上方手动填写）</option>
        {discovery.models.map(model => <option key={model} value={model}>{model}</option>)}
      </select>
    </>}
    {discovery.status === 'loading' && <p role="status" className="text-xs text-muted-foreground">正在拉取模型…</p>}
    {discovery.message && <p role={discovery.status === 'error' ? 'alert' : 'status'} className="break-words text-xs text-muted-foreground">{discovery.message}</p>}
  </div>;
}
