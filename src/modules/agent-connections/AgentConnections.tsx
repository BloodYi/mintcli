import { useCallback, useEffect, useRef, useState } from 'react';
import { api, readApiJson } from '@/shared/api';
import { Dialog, DialogContent, DialogTitle } from '@/shared/ui';
import type { AgentConnectionChoice, AgentConnectionsCatalog, LLMProvider } from '@/shared/types';
import { CliAccountAccess } from '@/modules/agent-connections/CliAccountAccess';
import { AccountQuota } from '@/modules/agent-connections/AccountQuota';

type Form = { id: string; kind: string; name: string; credentials: string; baseUrl: string; apiKey: string; protocol: string; model: string };
type Login = { status: string; url?: string; code?: string; authorized?: boolean };
const empty: Form = { id: '', kind: 'chatgpt', name: '', credentials: '', baseUrl: '', apiKey: '', protocol: 'responses', model: '' };
const labels: Record<string, string> = { chatgpt: 'Codex', api: '第三方 API', claude: 'Claude', antigravity: 'agy', cursor: 'Cursor', opencode: 'OpenCode' };
/** The only account picker and manager in the shared workbench. Models remain in the existing composer. */
export function AgentConnections({ provider, sessionId, disabled, onChoice, onProviderChange }: { provider: LLMProvider; sessionId?: string | null; disabled: boolean; onChoice: (choice: AgentConnectionChoice | null) => void; onProviderChange: (provider: LLMProvider) => void }) {
  // The server owns saved identities and cross-device selection; the browser receives safe metadata only.
  const [catalog, setCatalog] = useState<AgentConnectionsCatalog>({ activeId: '', connections: [] });
  // One dialog holds every account type instead of opening another workbench.
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<Form>(empty);
  // Secrets are empty on each edit and cleared immediately after saving.
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState('');
  const [login, setLogin] = useState<Login | null>(null);
  const [code, setCode] = useState('');
  const initialized = useRef(false);
  const requestId = useRef(0);
  const initialProvider = useRef(onProviderChange);
  initialProvider.current = onProviderChange;
  const reload = useCallback(async (force = false) => { const request = ++requestId.current; const result = await readApiJson<AgentConnectionsCatalog>(await api.agentConnections.list(force)); if (request === requestId.current) setCatalog(result); return result; }, []);
  useEffect(() => { let alive = true; void reload().then(result => { if (!initialized.current && alive && !sessionId) { const active = result.connections.find(item => item.id === result.activeId); if (active) initialProvider.current(active.provider); } initialized.current = true; }).catch(error => setNotice(error.message)); const timer = setInterval(() => void reload().catch(() => {}), 10000); return () => { alive = false; clearInterval(timer); }; }, [reload, sessionId]);
  const active = catalog.connections.find(item => item.id === catalog.activeId && item.provider === provider)
    || catalog.connections.find(item => item.provider === provider && item.current)
    || catalog.connections.find(item => item.provider === provider);
  useEffect(() => { onChoice(active || null); }, [active, onChoice]);
  useEffect(() => {
    if (!open || !form.id || !login || !['starting', 'pending'].includes(login.status)) return;
    const timer = setInterval(() => {
      const request = form.kind === 'claude' ? api.agentConnections.claudeLoginStatus(form.id) : api.codexConnections.loginStatus(form.id);
      void request.then(readApiJson<Login>).then(value => { setLogin(value); if (value.authorized) { setNotice('官方授权成功'); void reload(); window.dispatchEvent(new Event('codex-account-updated')); } }).catch(() => setNotice('授权状态暂时无法读取，请重试'));
    }, 2000);
    return () => clearInterval(timer);
  }, [form.id, form.kind, login, open, reload]);
  const run = async (action: () => Promise<void>) => { setPending(true); setNotice(''); try { await action(); } catch (error) { setNotice(error instanceof Error ? error.message : '操作失败'); } finally { setPending(false); } };
  const edit = (item?: AgentConnectionChoice) => { setForm(item ? { ...empty, id: item.accountId, kind: item.kind, name: item.name, baseUrl: item.baseUrl || '', protocol: item.protocol || 'responses', model: item.model || '' } : { ...empty }); setLogin(null); setCode(''); setNotice(''); setOpen(true); };
  const select = async (id: string) => { ++requestId.current; const result = await readApiJson<AgentConnectionsCatalog>(await api.agentConnections.select(id)); ++requestId.current; setCatalog(result); const item = result.connections.find(value => value.id === id); if (item) onProviderChange(item.provider); window.dispatchEvent(new Event('codex-account-updated')); };
  const field = (key: keyof Form, value: string) => setForm(previous => ({ ...previous, [key]: value }));
  const input = 'mt-1 w-full rounded-md border border-border bg-background p-2 text-sm';
  const button = 'rounded-md border border-border px-3 py-2 text-sm disabled:opacity-50';
  const nativeCli = form.kind === 'cursor' || form.kind === 'opencode' ? form.kind : null;
  const onNativeChanged = useCallback(async () => { await reload(true); window.dispatchEvent(new Event('codex-account-updated')); }, [reload]);
  const selectedForm = catalog.connections.find(item => item.accountId === form.id && item.kind === form.kind);
  return <>
    <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2 text-xs" data-testid="agent-connections">
      <label htmlFor="agent-account">账号</label>
      <select id="agent-account" aria-label="切换账号" value={active?.id || ''} disabled={disabled || pending} className="min-w-0 max-w-md flex-1 rounded-md border border-border bg-background px-2 py-1.5" onChange={event => void run(() => select(event.target.value))}>
        {!active && <option value="">请添加或选择账号</option>}
        {catalog.connections.map(item => <option key={item.id} value={item.id}>{labels[item.kind]} · {item.name}{item.email ? ' · ' + item.email : ''}{item.authorized ? '' : '（待登录）'}</option>)}
      </select>
      <button type="button" className="rounded-md border border-border px-2 py-1.5" onClick={() => edit(active)}>管理账号</button>
      {active?.email && <span className="break-all text-muted-foreground">{active.email}</span>}
      {!open && (notice || catalog.warning) && <span role="status">{notice || catalog.warning}</span>}
    </div>
    <AccountQuota id={active?.id} />
    <Dialog open={open} onOpenChange={value => { if (!pending) { setOpen(value); if (!value) { setForm({ ...empty }); setCode(''); } } }}>
      <DialogContent className="max-h-[90dvh] w-[calc(100%-1.5rem)] space-y-4 overflow-y-auto p-5 sm:max-w-2xl" aria-describedby="accounts-help" aria-labelledby="accounts-title">
        <DialogTitle>账号管理</DialogTitle>
        <div className="flex items-center justify-between"><h2 id="accounts-title" className="font-semibold">账号管理</h2><button type="button" aria-label="关闭账号管理" disabled={pending} onClick={() => setOpen(false)}>✕</button></div>
        <p id="accounts-help" className="text-sm text-muted-foreground">Codex、Claude、Cursor、OpenCode、agy 和第三方 API 都在这里添加和切换。模型在聊天输入框旁选择。</p>
        <div className="grid max-h-48 gap-2 overflow-y-auto sm:grid-cols-2" aria-label="所有账号">{catalog.connections.map(item => <button type="button" key={item.id} className={button + ' text-left break-all'} onClick={() => edit(item)}><strong>{labels[item.kind]} · {item.name}</strong><span className="block text-xs text-muted-foreground">{item.email || (item.authorized ? '已保存授权' : '等待登录')}{active?.id === item.id ? ' · 当前使用' : ''}</span></button>)}</div>
        <button type="button" className={button} onClick={() => edit()}>＋ 添加账号 / API</button>
        {nativeCli ? <><CliAccountAccess key={nativeCli} provider={nativeCli} disabled={disabled} onChanged={onNativeChanged} />{selectedForm && <AccountQuota key={selectedForm.id + String(selectedForm.authorized)} id={selectedForm.id} />}{selectedForm && <button type="button" className={button} disabled={pending || disabled} onClick={() => void run(async () => { await select(selectedForm.id); setNotice('已切换账号'); })}>使用此账号</button>}</> : <form className="grid gap-3" onSubmit={event => { event.preventDefault(); void run(async () => {
          if (form.kind === 'antigravity') {
            if (form.id) { setNotice('现有 agy 账号可直接使用；重新导入授权可更新账号资料'); return; }
            await readApiJson(await api.antigravity.addAccount({ alias: form.name, token_json: form.credentials, switch_now: false }));
          } else if (form.kind === 'claude') {
            const saved = await readApiJson<{ id: string }>(await api.agentConnections.saveClaude({ id: form.id || undefined, name: form.name, credentials: form.credentials || undefined }));
            setForm(previous => ({ ...previous, id: saved.id, credentials: '' }));
          } else {
            const saved = await readApiJson<{ id: string }>(await api.codexConnections.save({ ...form, id: form.id || undefined }));
            setForm(previous => ({ ...previous, id: saved.id, apiKey: '', credentials: '' }));
          }
          await reload(); field('credentials', ''); setNotice('已保存；可在上方切换到这个账号'); window.dispatchEvent(new Event('codex-account-updated'));
        }); }}>
          <label className="text-sm">账号类型<select className={input} disabled={Boolean(form.id)} value={form.kind} onChange={event => field('kind', event.target.value)}><option value="chatgpt">Codex / ChatGPT</option><option value="claude">Claude 官方账号</option><option value="antigravity">Antigravity · agy</option><option value="api">第三方模型 API</option></select></label>
          <label className="text-sm">名称<input required maxLength={80} className={input} value={form.name} onChange={event => field('name', event.target.value)} /></label>
          {form.kind === 'antigravity' && !form.id && <label className="text-sm">agy 原生账号授权 JSON<textarea required rows={5} className={input + ' font-mono'} autoComplete="off" value={form.credentials} onChange={event => field('credentials', event.target.value)} /></label>}
          {form.kind === 'claude' && <details><summary className="cursor-pointer text-sm">已有 Claude 原生登录文件？可导入</summary><label className="block text-sm">.credentials.json 内容<textarea rows={4} className={input + ' font-mono'} autoComplete="off" value={form.credentials} onChange={event => field('credentials', event.target.value)} /></label><p className="text-xs text-muted-foreground">也可以先保存账号，再点“官方登录”。授权资料只保存在服务器。</p></details>}
          {form.kind === 'api' && <>
            <label className="text-sm">API 地址<input type="url" required className={input} value={form.baseUrl} onChange={event => field('baseUrl', event.target.value)} /></label>
            <label className="text-sm">API Key<input type="password" autoComplete="new-password" required={!form.id} className={input} placeholder={form.id ? '留空保留原密钥' : '仅保存在服务器'} value={form.apiKey} onChange={event => field('apiKey', event.target.value)} /></label>
            <label className="text-sm">协议<select className={input} value={form.protocol} onChange={event => field('protocol', event.target.value)}><option value="responses">Responses（含 VPS 工具）</option><option value="chat_completions">Chat Completions（文字聊天）</option></select></label>
            <label className="text-sm">默认模型<input className={input} value={form.model} placeholder="服务商提供的模型 ID" onChange={event => field('model', event.target.value)} /></label>
            <p className="text-xs text-muted-foreground">服务商没有提供统一的余额查询方式时，额度会显示暂不可用。</p>
          </>}
          <div className="flex flex-wrap gap-2">
            <button type="submit" className={button + ' bg-primary text-primary-foreground'} disabled={pending}>{pending ? '处理中…' : '保存账号'}</button>
            {selectedForm && <button type="button" className={button} disabled={pending || disabled} onClick={() => void run(async () => { await select(selectedForm.id); setNotice('已切换账号'); })}>使用此账号</button>}
            {form.id && ['chatgpt', 'claude'].includes(form.kind) && <button type="button" className={button} disabled={pending || disabled} onClick={() => void run(async () => { setLogin(await readApiJson<Login>(await (form.kind === 'claude' ? api.agentConnections.claudeLogin(form.id) : api.codexConnections.login(form.id)))); })}>官方登录 / 重新授权</button>}
            {form.id && form.kind !== 'antigravity' && <button type="button" className={button + ' text-destructive'} disabled={pending || disabled} onClick={() => void run(async () => { await readApiJson(await (form.kind === 'claude' ? api.agentConnections.removeClaude(form.id) : api.codexConnections.remove(form.id))); setForm({ ...empty }); await reload(); setNotice('账号已移除，聊天记录保留'); })}>移除账号</button>}
          </div>
        </form>}
        {!nativeCli && login && <div className="grid gap-2 rounded border border-border p-3 text-sm" role="status"><p>授权状态：{login.authorized ? '已登录' : login.status}</p>{login.url && <a className="text-primary underline" href={login.url} target="_blank" rel="noopener noreferrer">打开官方授权页面</a>}{login.code && <p className="select-all font-mono text-lg">{login.code}</p>}{form.kind === 'claude' && login.status === 'pending' && <><label>授权页面返回的验证码<input className={input} value={code} autoComplete="off" onChange={event => setCode(event.target.value)} /></label><button type="button" disabled={pending || !code.trim()} className={button} onClick={() => void run(async () => { setLogin(await readApiJson<Login>(await api.agentConnections.claudeLoginCode(form.id, code))); setCode(''); })}>提交授权码</button></>}{['starting', 'pending'].includes(login.status) && <button type="button" className={button} onClick={() => void run(async () => { await (form.kind === 'claude' ? api.agentConnections.cancelClaudeLogin(form.id) : api.codexConnections.cancelLogin(form.id)); setLogin(null); })}>取消授权</button>}</div>}
        {notice && <p role="status" className="text-sm">{notice}</p>}
      </DialogContent>
    </Dialog>
  </>;
}
