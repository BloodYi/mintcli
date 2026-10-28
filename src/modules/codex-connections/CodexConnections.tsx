import { useCallback, useEffect, useState } from 'react';
import { api } from '@/shared/api';
import { CodexQuota } from '@/modules/codex-connections/CodexQuota';
import type { CodexConnectionChoice } from '@/shared/types';

type Connection = { id: string; name: string; kind: 'chatgpt' | 'api'; authorized: boolean; hasApiKey: boolean; email?: string; baseUrl: string; protocol: string; model: string };
type Catalog = { activeId: string; connections: Connection[] };
type Form = { id: string; name: string; kind: string; baseUrl: string; apiKey: string; protocol: string; model: string };
type Login = { status: string; url?: string; code?: string; authorized?: boolean };
const emptyForm: Form = { id: '', name: '', kind: 'chatgpt', baseUrl: '', apiKey: '', protocol: 'responses', model: '' };

async function json<T>(response: Response): Promise<T> {
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || (typeof data.error === 'string' ? data.error : data.message) || '操作失败，请重试');
  return data as T;
}

/** Used by the chat module to choose credentials and configure APIs in the native composer. */
export function CodexConnections({ disabled, onConnectionChange, showAccounts = false }: { disabled: boolean; onConnectionChange?: (connection: CodexConnectionChoice | null) => void; showAccounts?: boolean }) {
  // The server catalog is shared across devices and supplies the effective account for a new turn.
  const [catalog, setCatalog] = useState<Catalog>({ activeId: '', connections: [] });
  // Opening this dialog keeps account/API configuration within the existing chat interface.
  const [open, setOpen] = useState(false);
  // The draft never includes a stored key; a blank key means preserve it during an edit.
  const [form, setForm] = useState<Form>(emptyForm);
  // A single pending operation prevents selecting a connection before its save completes.
  const [pending, setPending] = useState(false);
  // Inline errors and success messages give API and authorization operations a visible result.
  const [notice, setNotice] = useState('');
  // The device code is temporary and polled only while its authorization dialog is open.
  const [login, setLogin] = useState<Login | null>(null);
  // Model ids fetched from this provider populate the model input without exposing the API key.
  const [models, setModels] = useState<string[]>([]);
  const reload = useCallback(async () => {
    setCatalog(await json<Catalog>(await api.codexConnections.list()));
  }, []);
  useEffect(() => { void reload().catch(() => {}); const timer = window.setInterval(() => void reload().catch(() => {}), 5000); return () => clearInterval(timer); }, [reload]);
  useEffect(() => {
    const item = catalog.connections.find(connection => connection.id === catalog.activeId);
    onConnectionChange?.(item ? { id: item.id, kind: item.kind, model: item.model } : null);
  }, [catalog, onConnectionChange]);
  useEffect(() => {
    if (!open || !form.id || !login || !['starting', 'pending'].includes(login.status)) return;
    const timer = window.setInterval(() => {
      void api.codexConnections.loginStatus(form.id).then(json<Login>).then(value => {
        setLogin(value); if (value.authorized) { setNotice('账号授权成功'); window.dispatchEvent(new Event('codex-account-updated')); void reload(); }
      }).catch(() => setNotice('授权状态读取失败，请重试'));
    }, 2000);
    return () => clearInterval(timer);
  }, [open, form.id, login, reload]);
  const run = async (action: () => Promise<void>) => {
    setPending(true); setNotice('');
    try { await action(); } catch (error) { setNotice(error instanceof Error ? error.message : '操作失败'); }
    finally { setPending(false); }
  };
  const edit = (item?: Connection) => {
    setForm(item ? { id: item.id, name: item.name, kind: item.kind, baseUrl: item.baseUrl, apiKey: '', protocol: item.protocol, model: item.model } : { ...emptyForm });
    setLogin(null); setModels([]); setNotice(''); setOpen(true);
  };
  const active = catalog.connections.find(item => item.id === catalog.activeId);
  const field = (key: keyof Form, value: string) => setForm(previous => ({ ...previous, [key]: value }));
  const control = 'w-full rounded-md border border-border bg-background p-2 text-sm';
  return <>
    {showAccounts && <section aria-label="已保存的 Codex 账号与 API" className="grid gap-2">{catalog.connections.map(item => <button type="button" key={item.id} aria-pressed={catalog.activeId === item.id} disabled={disabled || pending} className="rounded-lg border border-border p-3 text-left text-sm break-all" onClick={() => void run(async () => setCatalog(await json<Catalog>(await api.codexConnections.select(item.id))))}><strong>{item.name}</strong><span className="block text-muted-foreground">{item.email || (item.kind === 'api' ? '第三方 API' : '尚未返回账号身份')}</span><span>{catalog.activeId === item.id ? '当前使用 · ' : ''}{item.authorized ? '已保存授权' : '需要授权'}</span></button>)}</section>}
    <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2 text-xs" data-testid="codex-connections">
      <label htmlFor="codex-connection">Codex 账号 / API</label>
      <select id="codex-connection" className="min-w-0 max-w-[230px] flex-1 rounded-md border border-border bg-background px-2 py-1.5" value={catalog.activeId} disabled={disabled || pending} onChange={event => {
        const id = event.target.value;
        void run(async () => {
          const updated = await json<Catalog>(await api.codexConnections.select(id)); setCatalog(updated);
        });
      }}>
        {!catalog.connections.length && <option value="">请添加账号或 API</option>}
        {catalog.connections.map(item => <option key={item.id} value={item.id}>{item.kind === 'api' ? 'API' : 'ChatGPT'} · {item.name}{item.email ? ` · ${item.email}` : ''}{item.authorized ? '' : '（待授权）'}</option>)}
      </select>
      <button type="button" className="rounded-md border border-border px-2 py-1.5" onClick={() => edit(active)}>管理</button>
      {active?.kind === 'api' && <span className="text-muted-foreground">{active.protocol === 'chat_completions' ? 'API 聊天' : 'Responses · 可用工具'} · {active.model || '未选模型'}</span>}
      {!open && notice && <span role="status" className="text-amber-500">{notice}</span>}
    </div>
    {active?.email && <p className="break-all px-3 py-1 text-xs text-muted-foreground" aria-label="当前 Codex 登录账号">当前账号：{active.email}</p>}
    <CodexQuota connectionId={active?.id} />
    {open && <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-3" role="dialog" aria-modal="true" aria-label="Codex 账号与第三方 API">
      <section className="max-h-[90dvh] w-full max-w-xl overflow-y-auto rounded-xl border border-border bg-background p-5 text-foreground shadow-xl">
        <div className="mb-4 flex items-center justify-between"><h2 className="font-semibold">Codex 账号与第三方 API</h2><button type="button" aria-label="关闭连接管理" onClick={() => setOpen(false)}>✕</button></div>
        <div className="mb-4 flex flex-wrap gap-2">
          {catalog.connections.map(item => <button type="button" key={item.id} className="rounded border border-border px-2 py-1 text-xs" onClick={() => edit(item)}>{item.name}</button>)}
          <button type="button" className="rounded border border-border px-2 py-1 text-xs" onClick={() => edit()}>＋ 添加连接</button>
        </div>
        <form className="space-y-3" onSubmit={event => { event.preventDefault(); void run(async () => {
          const saved = await json<Connection>(await api.codexConnections.save({ ...form, id: form.id || undefined }));
          setForm(previous => ({ ...previous, id: saved.id, apiKey: '' }));
          await reload(); setNotice('已保存到服务器，手机与 PC 共用此配置');
        }); }}>
          <label className="block text-sm">连接类型<select className={control} value={form.kind} disabled={Boolean(form.id)} onChange={event => field('kind', event.target.value)}><option value="chatgpt">ChatGPT / Codex 账号</option><option value="api">第三方 API</option></select></label>
          <label className="block text-sm">名称<input className={control} value={form.name} required maxLength={80} onChange={event => field('name', event.target.value)} /></label>
          {form.kind === 'api' && <>
            <label className="block text-sm">API 地址<input className={control} type="url" placeholder="https://api.example.com/v1" value={form.baseUrl} required onChange={event => field('baseUrl', event.target.value)} /></label>
            <label className="block text-sm">API Key<input className={control} type="password" autoComplete="new-password" placeholder={form.id ? '留空保留原密钥' : '仅保存在服务器'} value={form.apiKey} required={!form.id} onChange={event => field('apiKey', event.target.value)} /></label>
            <label className="block text-sm">协议<select className={control} value={form.protocol} onChange={event => field('protocol', event.target.value)}><option value="responses">Responses（Codex 工具与 VPS 工作）</option><option value="chat_completions">Chat Completions（文字聊天）</option></select></label>
            <label className="block text-sm">此 API 使用的模型<input className={control} list="connection-models" value={form.model} placeholder="填写服务商提供的模型 ID" onChange={event => field('model', event.target.value)} /><datalist id="connection-models">{models.map(model => <option key={model} value={model} />)}</datalist></label>
            <p className="text-xs text-muted-foreground">API Key 不会返回浏览器。API 请求使用这里配置的模型；Chat Completions 不执行 VPS 工具。</p>
          </>}
          <div className="flex flex-wrap gap-2">
            <button type="submit" disabled={pending} className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground">{pending ? '处理中…' : '保存'}</button>
            {form.id && <button type="button" disabled={pending || disabled} className="rounded-md border border-border px-3 py-2 text-sm" onClick={() => void run(async () => { setCatalog(await json<Catalog>(await api.codexConnections.select(form.id))); setNotice('已设为当前连接'); })}>使用此连接</button>}
            {form.id && <button type="button" disabled={pending} className="rounded-md border border-border px-3 py-2 text-sm" onClick={() => void run(async () => { const result = await json<{ models: string[] }>(await api.codexConnections.models(form.id)); setModels(result.models); window.dispatchEvent(new Event('codex-account-updated')); setNotice(`已拉取 ${result.models.length} 个模型，可在模型输入框选择`); })}>拉取模型</button>}
            {form.id && form.kind === 'chatgpt' && <button type="button" disabled={pending} className="rounded-md border border-border px-3 py-2 text-sm" onClick={() => void run(async () => { setLogin(await json<Login>(await api.codexConnections.login(form.id))); })}>授权 / 重新登录</button>}
            {form.id && <button type="button" disabled={pending || disabled} className="rounded-md border border-border px-3 py-2 text-sm text-red-500" onClick={() => void run(async () => { setCatalog(await json<Catalog>(await api.codexConnections.remove(form.id))); setForm({ ...emptyForm }); setNotice('连接已移除，聊天记录保留'); })}>移除连接</button>}
          </div>
        </form>
        {login && <div className="mt-4 rounded border border-border p-3 text-sm"><p>授权状态：{login.authorized ? '已登录' : login.status}</p>{login.url && <a href={login.url} target="_blank" rel="noopener noreferrer" className="text-primary underline">打开官方授权页面</a>}{login.code && <p className="my-2 select-all font-mono text-xl">{login.code}</p>}{['starting', 'pending'].includes(login.status) && <button type="button" onClick={() => void run(async () => { await api.codexConnections.cancelLogin(form.id); setLogin(null); })}>取消授权</button>}</div>}
        {notice && <p className="mt-3 text-sm" role="status">{notice}</p>}
      </section>
    </div>}
  </>;
}
