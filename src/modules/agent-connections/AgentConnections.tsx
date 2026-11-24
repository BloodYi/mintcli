import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Plus, Settings2 } from 'lucide-react';
import { api, readApiJson } from '@/shared/api';
import { Dialog, DialogContent, DialogTitle, LLMProviderLogo } from '@/shared/ui';
import type { AgentConnectionChoice, AgentConnectionsCatalog, ApiAgent, ApiProtocol, LLMProvider, OfficialAccountLogin } from '@/shared/types';
import { CliAccountAccess } from '@/modules/agent-connections/CliAccountAccess';
import { AccountAuthorization } from '@/modules/agent-connections/AccountAuthorization';
import { NativeOfficialLogin } from '@/modules/agent-connections/NativeOfficialLogin';
import { useAuthorizationPopup } from '@/modules/agent-connections/hooks/useAuthorizationPopup';
import { AccountQuota } from '@/modules/agent-connections/AccountQuota';
import { ApiModelPicker } from '@/modules/agent-connections/ApiModelPicker';

type Form = { id: string; kind: string; name: string; credentials: string; baseUrl: string; apiKey: string; agent: ApiAgent; protocol: ApiProtocol; model: string };
type Login = OfficialAccountLogin;
const empty: Form = { id: '', kind: 'chatgpt', name: '', credentials: '', baseUrl: '', apiKey: '', agent: 'codex', protocol: 'chat_completions', model: '' };
const AGENT_LABELS: Record<ApiAgent, string> = { codex: 'Codex', claude: 'Claude Code', antigravity: 'agy', chat: '纯文字聊天（不执行工具）' };
const NATIVE_PROTOCOLS: Record<ApiAgent, ApiProtocol> = { codex: 'responses', claude: 'anthropic', antigravity: 'gemini', chat: 'chat_completions' };
const PROTOCOL_LABELS: Record<ApiProtocol, string> = { chat_completions: 'Chat Completions（自动转换）', responses: 'Responses（原生）', anthropic: 'Anthropic Messages（原生）', gemini: 'Gemini（原生）' };
const rawAccountId = (item: AgentConnectionChoice) => item.kind === 'api' ? item.accountId.replace(/^api:/, '') : item.accountId;
const labels: Record<string, string> = { chatgpt: 'Codex', api: '第三方 API', claude: 'Claude', antigravity: 'agy', cursor: 'Cursor', opencode: 'OpenCode' };
/** The only account picker and manager in the shared workbench. Models remain in the existing composer. */
export function AgentConnections({
  provider,
  sessionId,
  disabled,
  onChoice,
  onProviderChange,
  mobileFolded = false,
  mobileSlot = null,
  onOpenManager,
}: {
  provider: LLMProvider;
  sessionId?: string | null;
  disabled: boolean;
  onChoice: (choice: AgentConnectionChoice | null) => void;
  onProviderChange: (provider: LLMProvider) => void;
  mobileFolded?: boolean;
  mobileSlot?: HTMLElement | null;
  onOpenManager?: () => void;
}) {
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
  const { open: openAuthorization, navigate: showAuthorization, closePlaceholder } = useAuthorizationPopup();
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
  useEffect(() => { showAuthorization(login?.url); }, [login?.url, showAuthorization]);
  useEffect(() => {
    if (!open || !form.id || !login || !['starting', 'pending', 'completing'].includes(login.status)) return;
    let cancelled = false;
    const timer = setInterval(() => {
      const request = form.kind === 'claude' ? api.agentConnections.claudeLoginStatus(form.id) : api.codexConnections.loginStatus(form.id);
      void request.then(readApiJson<Login>).then(value => { if (cancelled) return; setLogin({ ...value, acceptsCode: form.kind === 'claude' ? value.status === 'pending' : value.acceptsCode }); if (['error', 'failed', 'expired', 'cancelled'].includes(value.status)) closePlaceholder(); if (value.authorized) { setNotice('官方授权成功'); void reload(); window.dispatchEvent(new Event('codex-account-updated')); } }).catch(() => setNotice('授权状态暂时无法读取，请重试'));
    }, 2000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [form.id, form.kind, login?.status, open, reload, closePlaceholder]);
  const run = async (action: () => Promise<void>) => { setPending(true); setNotice(''); try { await action(); } catch (error) { closePlaceholder(); setNotice(error instanceof Error ? error.message : '操作失败'); } finally { setPending(false); } };
  const edit = (item?: AgentConnectionChoice) => { setForm(item ? { ...empty, id: rawAccountId(item), kind: item.kind, name: item.name, baseUrl: item.baseUrl || '', agent: item.agent || (item.protocol === 'chat_completions' ? 'chat' : 'codex'), protocol: (item.protocol || 'responses') as ApiProtocol, model: item.model || '' } : { ...empty }); setLogin(null); setCode(''); setNotice(''); setOpen(true); };
  const select = async (id: string) => { ++requestId.current; const result = await readApiJson<AgentConnectionsCatalog>(await api.agentConnections.select(id, sessionId)); ++requestId.current; setCatalog(result); const item = result.connections.find(value => value.id === id); if (item) onProviderChange(item.provider); window.dispatchEvent(new Event('codex-account-updated')); };
  const field = (key: keyof Form, value: string) => setForm(previous => ({ ...previous, [key]: value }));
  const input = 'mt-1 w-full rounded-md border border-border bg-background p-2 text-sm';
  const button = 'rounded-md border border-border px-3 py-2 text-sm disabled:opacity-50';
  const nativeCli = form.kind === 'cursor' || form.kind === 'opencode' ? form.kind : null;
  const onNativeChanged = useCallback(async () => { await reload(true); window.dispatchEvent(new Event('codex-account-updated')); }, [reload]);
  const selectedForm = catalog.connections.find(item => rawAccountId(item) === form.id && item.kind === form.kind);
  const beginOfficialLogin = (method: 'browser' | 'device' = 'browser') => {
    openAuthorization(); setLogin(null); setCode('');
    void run(async () => {
      let id = form.id;
      const name = form.name.trim() || (form.kind === 'claude' ? 'Claude 新账号' : 'Codex 新账号');
      if (!id) {
        const saved = await readApiJson<{ id: string }>(await (form.kind === 'claude'
          ? api.agentConnections.saveClaude({ name })
          : api.codexConnections.save({ name, kind: 'chatgpt' })));
        id = saved.id; setForm(previous => ({ ...previous, id, name, credentials: '' })); await reload();
      }
      const value = await readApiJson<Login>(await (form.kind === 'claude' ? api.agentConnections.claudeLogin(id) : api.codexConnections.login(id, method)));
      setLogin({ ...value, acceptsCode: form.kind === 'claude' ? value.status === 'pending' : value.acceptsCode });
    }).catch(() => closePlaceholder());
  };

  const mobileFoldedContent = (
    <div className="space-y-3.5" data-testid="agent-connections">
      <section className="space-y-2" aria-label="切换账号">
        <div className="flex items-center justify-between px-1">
          <h3 className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            切换账号
          </h3>
          <button
            type="button"
            className="inline-flex h-7 items-center gap-1 rounded-full border border-border/65 bg-background px-2.5 text-[11px] font-medium text-foreground/85 transition-colors active:scale-95 hover:bg-muted/60"
            onClick={() => {
              onOpenManager?.();
              edit(active);
            }}
          >
            <Settings2 className="h-3 w-3 text-muted-foreground" aria-hidden="true" />
            <span>管理账号</span>
          </button>
        </div>

        {catalog.connections.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2.5 rounded-2xl border border-dashed border-border/70 bg-muted/20 px-4 py-5 text-center">
            <p className="text-xs text-muted-foreground">还没有可用账号</p>
            <button
              type="button"
              className="inline-flex h-8 items-center gap-1.5 rounded-full bg-primary px-3.5 text-xs font-medium text-primary-foreground shadow-sm transition-opacity active:scale-95 hover:opacity-90"
              onClick={() => {
                onOpenManager?.();
                edit();
              }}
            >
              <Plus className="h-3.5 w-3.5" aria-hidden="true" />
              <span>添加账号 / API</span>
            </button>
          </div>
        ) : (
          <div
            role="radiogroup"
            aria-label="切换账号"
            className="max-h-[34dvh] divide-y divide-border/45 overflow-y-auto overscroll-contain rounded-2xl border border-border/55 bg-card/85 shadow-sm"
          >
            {catalog.connections.map((item) => {
              const isSelected = active?.id === item.id;
              const subtitleParts: string[] = [];
              if (item.kind === 'api' && item.agent) {
                subtitleParts.push(AGENT_LABELS[item.agent]);
              }
              if (item.email && item.email.trim().toLowerCase() !== item.name.trim().toLowerCase()) {
                subtitleParts.push(item.email);
              }
              if (!item.authorized) {
                subtitleParts.push('待登录');
              }
              const subtitle = subtitleParts.join(' · ');

              return (
                <button
                  key={item.id}
                  type="button"
                  role="radio"
                  aria-checked={isSelected}
                  disabled={disabled || pending}
                  onClick={() => {
                    if (!isSelected) {
                      void run(() => select(item.id));
                    }
                  }}
                  className={
                    isSelected
                      ? 'flex w-full items-center gap-3 bg-primary/[0.06] px-3.5 py-2.5 text-left transition-colors disabled:opacity-60'
                      : 'flex w-full items-center gap-3 px-3.5 py-2.5 text-left transition-colors active:bg-muted/60 hover:bg-muted/40 disabled:opacity-60'
                  }
                >
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-muted/65">
                    <LLMProviderLogo provider={item.provider} className="h-4 w-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate text-[13px] font-semibold leading-snug text-foreground">
                        {item.name}
                      </span>
                      <span className="shrink-0 rounded-md bg-muted/80 px-1.5 py-0.5 text-[10px] font-medium leading-none text-muted-foreground">
                        {labels[item.kind] || item.kind}
                      </span>
                      {item.subscriptionTier && (
                        <span className="shrink-0 rounded-md bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium leading-none text-primary">
                          {item.subscriptionTier}
                        </span>
                      )}
                    </span>
                    {subtitle && (
                      <span className="mt-0.5 block truncate text-[11px] leading-tight text-muted-foreground">
                        {subtitle}
                      </span>
                    )}
                  </span>
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center">
                    {isSelected && <Check className="h-4 w-4 text-primary" aria-hidden="true" />}
                  </span>
                </button>
              );
            })}
          </div>
        )}

        {!open && (notice || catalog.warning) && (
          <p className="px-1 text-[11px] text-muted-foreground" role="status">
            {notice || catalog.warning}
          </p>
        )}
      </section>

      <AccountQuota id={active?.id} embedded showUtilities={false} />
    </div>
  );

  return <>
    {mobileFolded ? (
      mobileSlot ? createPortal(mobileFoldedContent, mobileSlot) : null
    ) : (
      <>
        <div className="flex flex-wrap items-center gap-1.5 border-b border-border bg-background/95 px-2.5 py-1.5 text-xs sm:gap-2 sm:px-3 sm:py-2" data-testid="agent-connections">
          <label htmlFor="agent-account" className="shrink-0 font-medium text-muted-foreground">账号</label>
          <select id="agent-account" aria-label="切换账号" value={active?.id || ''} disabled={disabled || pending} className="h-8 min-w-0 flex-1 truncate rounded-lg border border-border bg-background pl-2.5 pr-7 text-xs leading-tight sm:max-w-md" onChange={event => void run(() => select(event.target.value))}>
            {!active && <option value="">请添加或选择账号</option>}
            {catalog.connections.map(item => <option key={item.id} value={item.id}>{labels[item.kind]} · {item.name}{item.agent && item.kind === 'api' ? ' · ' + AGENT_LABELS[item.agent] : ''}{item.email ? ' · ' + item.email : ''}{item.subscriptionTier ? ' · ' + item.subscriptionTier : ''}{item.authorized ? '' : '（待登录）'}</option>)}
          </select>
          <button type="button" className="h-8 shrink-0 whitespace-nowrap rounded-lg border border-border bg-background px-2.5 text-xs font-medium transition-colors hover:bg-muted/60" onClick={() => edit(active)}>管理账号</button>
          {(active?.email || active?.subscriptionTier) && <span className="hidden max-w-[18rem] truncate text-muted-foreground sm:inline">{[active.email, active.subscriptionTier].filter(Boolean).join(' · ')}</span>}
          {!open && (notice || catalog.warning) && <span className="w-full text-[11px] text-muted-foreground sm:w-auto" role="status">{notice || catalog.warning}</span>}
        </div>
        <AccountQuota id={active?.id} />
      </>
    )}
    <Dialog open={open} onOpenChange={value => { if (!pending) { setOpen(value); if (!value) { setForm({ ...empty }); setCode(''); } } }}>
      <DialogContent className="max-h-[90dvh] w-[calc(100%-1.5rem)] space-y-4 overflow-y-auto p-5 sm:max-w-2xl" aria-describedby="accounts-help" aria-labelledby="accounts-title">
        <DialogTitle>账号管理</DialogTitle>
        <div className="flex items-center justify-between"><h2 id="accounts-title" className="font-semibold">账号管理</h2><button type="button" aria-label="关闭账号管理" disabled={pending} onClick={() => setOpen(false)}>✕</button></div>
        <p id="accounts-help" className="text-sm text-muted-foreground">Codex、Claude、Cursor、OpenCode、agy 和第三方 API 都在这里添加和切换。模型在聊天输入框旁选择。</p>
        <div className="grid max-h-48 gap-2 overflow-y-auto sm:grid-cols-2" aria-label="所有账号">{catalog.connections.map(item => <button type="button" key={item.id} className={button + ' text-left break-all'} onClick={() => edit(item)}><strong>{labels[item.kind]} · {item.name}{item.subscriptionTier ? ' · ' + item.subscriptionTier : ''}</strong><span className="block text-xs text-muted-foreground">{item.email || (item.authorized ? '已保存授权' : '等待登录')}{active?.id === item.id ? ' · 当前使用' : ''}</span></button>)}</div>
        <button type="button" className={button} onClick={() => edit()}>＋ 添加账号 / API</button>
        {(!nativeCli || !form.id) && <label className="block text-sm">账号类型<select className={input} disabled={Boolean(form.id)} value={form.kind} onChange={event => { field('kind', event.target.value); setLogin(null); setCode(''); }}><option value="chatgpt">Codex / ChatGPT</option><option value="claude">Claude 官方账号</option><option value="cursor">Cursor 原生账号</option><option value="opencode">OpenCode 原生账号</option><option value="antigravity">Antigravity · agy</option><option value="api">第三方模型 API</option></select></label>}
        {selectedForm && ['chatgpt', 'claude'].includes(selectedForm.kind) && <AccountQuota id={selectedForm.id} />}
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

          <label className="text-sm">名称<input required maxLength={80} className={input} value={form.name} onChange={event => field('name', event.target.value)} /></label>
          {form.kind === 'antigravity' && !form.id && <><NativeOfficialLogin provider="antigravity" name={form.name} disabled={pending || disabled} onChanged={onNativeChanged} /><details><summary className="cursor-pointer text-sm">已有 agy 凭证文件？手动导入</summary><label className="text-sm">agy 原生账号授权 JSON<textarea rows={5} className={input + ' font-mono'} autoComplete="off" value={form.credentials} onChange={event => field('credentials', event.target.value)} /></label></details></>}
          {form.kind === 'claude' && <details><summary className="cursor-pointer text-sm">已有 Claude 原生登录文件？可导入</summary><label className="block text-sm">.credentials.json 内容<textarea rows={4} className={input + ' font-mono'} autoComplete="off" value={form.credentials} onChange={event => field('credentials', event.target.value)} /></label><p className="text-xs text-muted-foreground">也可以先保存账号，再点“官方登录”。授权资料只保存在服务器。</p></details>}
          {form.kind === 'api' && <>
            <label className="text-sm">执行 Agent<select className={input} value={form.agent} onChange={event => {
              const agent = event.target.value as ApiAgent;
              setForm(previous => ({ ...previous, agent, protocol: previous.protocol === 'chat_completions' ? previous.protocol : NATIVE_PROTOCOLS[agent] }));
            }}>{Object.entries(AGENT_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            <label className="text-sm">API 地址<input type="url" required className={input} value={form.baseUrl} onChange={event => field('baseUrl', event.target.value)} /></label>
            <label className="text-sm">API Key<input type="password" autoComplete="new-password" required={!form.id} className={input} placeholder={form.id ? '留空保留原密钥' : '仅保存在服务器'} value={form.apiKey} onChange={event => field('apiKey', event.target.value)} /></label>
            <label className="text-sm">协议<select className={input} value={form.protocol} onChange={event => field('protocol', event.target.value)}>
              <option value="chat_completions">{form.agent === 'chat' ? 'Chat Completions（文字聊天）' : PROTOCOL_LABELS.chat_completions}</option>
              {form.agent !== 'chat' && <option value={NATIVE_PROTOCOLS[form.agent]}>{PROTOCOL_LABELS[NATIVE_PROTOCOLS[form.agent]]}</option>}
            </select></label>
            {form.agent !== 'chat' && <p className="text-xs text-muted-foreground">{form.protocol === 'chat_completions' ? `由 ${AGENT_LABELS[form.agent]} 执行任务，自动转换为 Chat Completions；服务商模型需要支持工具调用。` : '使用服务商对应的原生协议，需要完整支持流式回复和工具调用。'}</p>}
            <ApiModelPicker key={form.id || 'new'} accountId={form.id} baseUrl={form.baseUrl} apiKey={form.apiKey} protocol={form.protocol} value={form.model} disabled={pending} onChange={value => field('model', value)} />
            <p className="text-xs text-muted-foreground">服务商没有提供统一的余额查询方式时，额度会显示暂不可用。</p>
          </>}
          {['chatgpt', 'claude'].includes(form.kind) && !form.id && <p className="text-xs text-muted-foreground">无需先保存账号，直接点击“打开官方授权 / 添加账号”即可。</p>}
          <div className="flex flex-wrap gap-2">
            <button type="submit" className={button + ' bg-primary text-primary-foreground'} disabled={pending}>{pending ? '处理中…' : '保存账号'}</button>
            {selectedForm && <button type="button" className={button} disabled={pending || disabled} onClick={() => void run(async () => { await select(selectedForm.id); setNotice('已切换账号'); })}>使用此账号</button>}
            {['chatgpt', 'claude'].includes(form.kind) && <button type="button" className={button + ' bg-primary text-primary-foreground'} disabled={pending || disabled || Boolean(login && ['starting', 'pending', 'completing'].includes(login.status))} onClick={() => beginOfficialLogin()}>{form.id ? '官方登录 / 重新授权' : '打开官方授权 / 添加账号'}</button>}
            {form.id && form.kind !== 'antigravity' && <button type="button" className={button + ' text-destructive'} disabled={pending || disabled} onClick={() => void run(async () => { await readApiJson(await (form.kind === 'claude' ? api.agentConnections.removeClaude(form.id) : api.codexConnections.remove(form.id))); setForm({ ...empty }); await reload(); setNotice('账号已移除，聊天记录保留'); })}>移除账号</button>}
          </div>
        </form>}
        {!nativeCli && login && <AccountAuthorization login={login} code={code} busy={pending} onCode={setCode}
          hint={form.kind === 'claude' ? '在官方网页完成授权，复制返回的授权码并粘贴到下方。' : login.method === 'device' ? '将设备验证码输入官方网页，完成确认后这里会自动添加账号。' : '在官方网页完成授权。如跳转 localhost 后无法打开，请将地址栏完整回调地址或授权码粘贴到下方。'}
          onSubmit={() => void run(async () => { const value = await readApiJson<Login>(await (form.kind === 'claude' ? api.agentConnections.claudeLoginCode(form.id, code.trim()) : api.codexConnections.loginCode(form.id, code.trim()))); setLogin({ ...value, acceptsCode: form.kind === 'claude' ? value.status === 'pending' : value.acceptsCode }); setCode(''); if (value.authorized) { await reload(); window.dispatchEvent(new Event('codex-account-updated')); } })}
          onCancel={() => void run(async () => { await (form.kind === 'claude' ? api.agentConnections.cancelClaudeLogin(form.id) : api.codexConnections.cancelLogin(form.id)); setLogin(null); setCode(''); closePlaceholder(); })} />}
        {form.kind === 'chatgpt' && (!login || !['starting', 'pending', 'completing'].includes(login.status)) && <button type="button" className="text-xs text-muted-foreground underline" disabled={pending || disabled} onClick={() => beginOfficialLogin('device')}>改用设备验证码登录</button>}

        {notice && <p role="status" className="text-sm">{notice}</p>}
      </DialogContent>
    </Dialog>
  </>;
}
