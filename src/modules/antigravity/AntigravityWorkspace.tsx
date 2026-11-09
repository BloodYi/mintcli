import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api, readApiJson } from '@/shared/api';
import type { AntigravityMessage } from '@/shared/types';
import { useAntigravity } from '@/modules/antigravity/hooks/useAntigravity';
import { QuotaWindow } from '@/shared/ui/QuotaWindow';

const CONTROL = 'min-h-10 rounded-md border border-border bg-background px-3 py-2 text-sm disabled:opacity-50';

/** Rendered by App as the native agy workspace, alongside the existing Codex/Claude/API workspace. */
export function AntigravityWorkspace() {
  const agent = useAntigravity();
  // Drafts belong to the current view and are never written over a server-owned conversation.
  const [draft, setDraft] = useState('');
  const [model, setModel] = useState('');
  const [cwd, setCwd] = useState('');
  const [attachments, setAttachments] = useState<NonNullable<AntigravityMessage['attachments']>>([]);
  // Only an explicit action opens account management; authorization text stays in memory until submitted.
  const [manager, setManager] = useState(false);
  const [alias, setAlias] = useState('');
  const [authorization, setAuthorization] = useState('');
  const [pending, setPending] = useState(false);
  // The mobile history is a collapsible region, retaining normal keyboard focus without a modal trap.
  const [historyOpen, setHistoryOpen] = useState(false);
  const end = useRef<HTMLDivElement | null>(null);
  const managerRef = useRef<HTMLDialogElement | null>(null);
  const active = agent.accounts.find(item => item.active);
  const visibleQuota = agent.quota && (!active?.email || active.email === 'unknown' || agent.quota.email === active.email) ? agent.quota : null;
  useEffect(() => { end.current?.scrollIntoView?.({ block: 'end' }); }, [agent.messages]);
  useEffect(() => {
    const dialog = managerRef.current;
    if (manager && dialog && !dialog.open) dialog.showModal();
    if (!manager && dialog?.open) dialog.close();
  }, [manager]);

  const act = async (action: () => Promise<unknown>) => {
    setPending(true); agent.setNotice('');
    try { await action(); }
    catch (error) { agent.setNotice(error instanceof Error ? error.message : '操作失败，请重试。'); }
    finally { setPending(false); }
  };
  const download = async (path: string, filename: string) => act(async () => {
    const response = await api.antigravity.download(path);
    if (!response.ok) { await readApiJson(response); return; }
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement('a'); link.href = url; link.download = filename; link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  const closeManager = () => { setManager(false); setAuthorization(''); };

  return <section aria-label="Antigravity 工作台" className="fixed inset-x-0 bottom-0 top-12 flex min-w-0 bg-background text-foreground">
    <aside aria-label="Antigravity 历史聊天" className={(historyOpen ? 'absolute inset-y-0 left-0 z-20 flex shadow-xl ' : 'hidden ') + 'w-72 max-w-[85vw] shrink-0 flex-col border-r border-border bg-background md:static md:flex md:shadow-none'}>
      <div className="flex items-center gap-2 border-b border-border p-3">
        <button type="button" className={CONTROL + ' flex-1'} disabled={agent.busy || agent.loading} onClick={() => { agent.newConversation(); setHistoryOpen(false); }}>＋ 新建 agy 聊天</button>
        <button type="button" className={CONTROL + ' md:hidden'} onClick={() => setHistoryOpen(false)} aria-label="收起历史聊天">✕</button>
      </div>
      <div className="flex-1 space-y-1 overflow-y-auto p-2">
        {agent.conversations.map(item => <button type="button" key={item.conversation_id} disabled={agent.busy || agent.loading}
          aria-current={item.conversation_id === agent.conversationId ? 'page' : undefined}
          className={'w-full break-words rounded-md p-3 text-left text-sm hover:bg-muted disabled:opacity-50 ' + (item.conversation_id === agent.conversationId ? 'bg-muted font-medium' : '')}
          onClick={() => { void agent.openConversation(item.conversation_id); setHistoryOpen(false); }}>
          {item.pinned ? '★ ' : ''}{item.title || '未命名聊天'}
        </button>)}
        {!agent.conversations.length && <p className="p-3 text-sm text-muted-foreground">{agent.loading ? '正在读取原有聊天…' : '还没有 agy 聊天。'}</p>}
      </div>
      <p className="border-t border-border p-3 text-xs leading-5 text-muted-foreground">沿用原站的 agy 账号与聊天记录。Codex 的账号和额度在另一个工作台中管理。</p>
    </aside>
    <div className="flex min-w-0 flex-1 flex-col">
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border p-3">
        <button type="button" className={CONTROL + ' md:hidden'} aria-expanded={historyOpen} aria-label="展开 agy 历史聊天" onClick={() => setHistoryOpen(value => !value)}>☰</button>
        <h1 className="mr-auto font-semibold">Antigravity</h1>
        <button type="button" className={CONTROL} disabled={agent.busy || agent.loading} onClick={() => void agent.sync()}>同步聊天</button>
        <button type="button" className={CONTROL} onClick={() => setManager(true)}>账号管理</button>
      </header>
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <label htmlFor="agy-account" className="text-xs">agy 账号</label>
        <select id="agy-account" className={CONTROL + ' min-w-0 flex-1 sm:max-w-sm'} value={active?.id || ''} disabled={agent.busy || pending || agent.loading}
          onChange={event => { setModel(''); void act(() => agent.switchAccount(event.target.value)); }}>
          {!agent.accounts.length && <option value="">请导入 agy 账号</option>}
          {agent.accounts.map(item => <option key={item.id} value={item.id}>{item.name || item.email || item.id}{item.active ? ' · 当前' : ''}</option>)}
        </select>
        <label htmlFor="agy-model" className="text-xs">模型</label>
        <select id="agy-model" className={CONTROL + ' min-w-0 flex-1 sm:max-w-xs'} value={model} disabled={agent.busy || pending}
          onChange={event => setModel(event.target.value)}>
          <option value="">沿用 agy 默认模型</option>
          {agent.models.map(item => <option key={item.id} value={item.id}>{item.name || item.id}</option>)}
        </select>
      </div>
      <div aria-label="当前 Antigravity 账号额度" aria-busy={agent.quotaLoading} className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-muted/30 px-3 py-2 text-xs">
        <span className="break-all font-medium">{active?.email && active.email !== 'unknown' ? active.email + ' · ' : ''}剩余额度</span>
        {Boolean(visibleQuota?.quotas.length) && <div className="flex w-full min-w-0 gap-2 overflow-x-auto pb-1">
          {visibleQuota?.quotas.map((item, index) => <div key={item.model + item.type + index} className="min-w-[14rem] flex-1"><QuotaWindow
            label={`${item.model} · ${item.type === 'five_hour' ? '5 小时' : item.type === 'weekly' ? '每周' : '每日'}`}
            remainingPercent={item.percentage} resetsAt={item.resets_at ? Date.parse(item.resets_at) / 1000 : null} /></div>)}
        </div>}
        {!visibleQuota?.quotas.length && <span className="text-muted-foreground">{agent.quotaLoading ? '正在读取原生 agy 额度…' : '尚未取得额度，请刷新或检查账号登录。'}</span>}
        <button type="button" className="ml-auto min-h-9 shrink-0 rounded border border-border px-2 disabled:opacity-50" disabled={agent.quotaLoading || pending || agent.busy} onClick={() => void agent.refreshQuota(true)}>刷新额度</button>
      </div>
      {agent.notice && <div role="status" className="shrink-0 border-b border-border bg-muted px-4 py-3 text-sm">{agent.notice}</div>}
      <div role="log" aria-label="agy 聊天消息" className="min-h-0 flex-1 overflow-y-auto p-4">
        <div className="mx-auto max-w-4xl space-y-5">
          {!agent.messages.length && <div className="py-10 text-center text-muted-foreground"><h2 className="mb-2 text-lg font-medium">继续你的 agy 项目</h2><p className="text-sm">选择左侧旧聊天，或在这里新建一段对话。</p></div>}
          {agent.messages.map((message, index) => <article key={message.id || index} className="min-w-0 rounded-xl border border-border p-4">
            <p className="mb-2 text-xs font-semibold text-muted-foreground">{message.role === 'user' ? '你' : 'Antigravity'}</p>
            {message.thinking && <details className="mb-3 text-sm text-muted-foreground"><summary className="cursor-pointer">查看 agy 返回的思考</summary><div className="mt-2 whitespace-pre-wrap break-words">{message.thinking}</div></details>}
            <div className="prose prose-sm max-w-none break-words dark:prose-invert prose-pre:overflow-x-auto">
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={{
                a: ({ href, children }) => href?.startsWith('/api/download?')
                  ? <button type="button" className="break-all text-primary underline" onClick={() => void download(new URL(href, window.location.origin).searchParams.get('path') || '', 'agy-file')}>{children}</button>
                  : <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
              }}>{message.content || (message.status === 'streaming' ? '正在等待 agy 回复…' : '')}</ReactMarkdown>
            </div>
            {message.attachments?.map(file => <button key={file.path} type="button" className={CONTROL + ' mr-2 mt-2 max-w-full truncate'} onClick={() => void download(file.path, file.filename)}>📎 {file.filename}</button>)}
            {message.tool && <p className="mt-3 break-words text-xs text-muted-foreground">工具：{message.tool}</p>}
            {message.errorText && <p role="alert" className="mt-2 whitespace-pre-wrap text-sm text-red-500">{message.errorText}</p>}
            {message.metrics && <p className="mt-3 text-xs text-muted-foreground">{message.metrics}</p>}
          </article>)}
          <div ref={end} />
        </div>
      </div>
      <form className="shrink-0 space-y-2 border-t border-border p-3 pb-[max(12px,env(safe-area-inset-bottom))]" onSubmit={event => {
        event.preventDefault();
        const text = draft; const files = attachments;
        setDraft(''); setAttachments([]);
        void agent.send(text, model, cwd, files).then(ok => { if (!ok) { setDraft(text); setAttachments(files); } });
      }}>
        <label className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">工作目录
          <input className={CONTROL + ' min-w-0 flex-1'} value={cwd} disabled={agent.busy} onChange={event => setCwd(event.target.value)} placeholder="留空使用 agy 默认目录" />
        </label>
        {attachments.length > 0 && <div className="flex flex-wrap gap-2">{attachments.map((file, index) => <button type="button" key={file.path} className={CONTROL + ' max-w-full truncate'} onClick={() => setAttachments(previous => previous.filter((_, i) => i !== index))}>{file.filename} ×</button>)}</div>}
        <label htmlFor="agy-prompt" className="sr-only">发送给 Antigravity 的消息</label>
        <textarea id="agy-prompt" className={CONTROL + ' block max-h-40 min-h-20 w-full resize-y'} value={draft} onChange={event => setDraft(event.target.value)} placeholder="给 agy 一个任务…" disabled={agent.busy || pending || agent.loading} />
        <div className="flex items-center gap-2">
          <label className={CONTROL + ' cursor-pointer'}>附加文件<input type="file" className="sr-only" multiple disabled={agent.busy || pending} onChange={event => {
            const files = Array.from(event.target.files || []); event.target.value = '';
            void act(async () => {
              for (const file of files) {
                const result = await readApiJson<NonNullable<AntigravityMessage['attachments']>[number]>(await api.antigravity.upload(file));
                setAttachments(previous => [...previous, result]);
              }
            });
          }} /></label>
          <span className="min-w-0 flex-1 text-xs text-muted-foreground">{agent.busy ? 'agy 正在服务器运行，切换工作台后仍会继续。' : '使用当前 agy 账号的额度'}</span>
          {agent.busy ? <button type="button" className={CONTROL} onClick={() => void act(agent.stop)}>停止生成</button>
            : <button type="submit" className={CONTROL + ' bg-primary text-primary-foreground'} disabled={pending || agent.loading || !active || !draft.trim() && !attachments.length}>发送</button>}
        </div>
      </form>
    </div>
    <dialog ref={managerRef} onCancel={closeManager} onClose={closeManager} aria-labelledby="agy-accounts-title" className="fixed inset-0 m-auto max-h-[90dvh] w-[min(95vw,640px)] overflow-y-auto rounded-xl border border-border bg-background p-5 text-foreground shadow-xl backdrop:bg-black/60">
      <div className="mb-4 flex items-center justify-between gap-3"><h2 id="agy-accounts-title" className="font-semibold">Antigravity 账号管理</h2><button type="button" className={CONTROL} onClick={closeManager} aria-label="关闭 agy 账号管理">✕</button></div>
      <div className="mb-5 space-y-2">{agent.accounts.map(item => <div key={item.id} className="flex items-center gap-3 rounded border border-border p-3">
        <div className="min-w-0 flex-1 break-all text-sm"><strong>{item.name || item.id}</strong><p className="text-muted-foreground">{item.email}</p></div>
        <button type="button" className={CONTROL} disabled={item.active || agent.busy || pending} onClick={() => void act(() => agent.switchAccount(item.id))}>{item.active ? '当前账号' : '使用此账号'}</button>
      </div>)}</div>
      <form className="space-y-3 border-t border-border pt-4" onSubmit={event => {
        event.preventDefault();
        void act(async () => {
          await readApiJson(await api.antigravity.addAccount({ alias, token_json: authorization, switch_now: false }));
          setAuthorization(''); setAlias(''); await agent.reloadAccounts(); agent.setNotice('agy 账号已添加，可在账号列表中选择。');
        });
      }}>
        <h3 className="font-medium">添加已有 agy 账号</h3>
        <p className="text-sm leading-6 text-muted-foreground">沿用原站的导入方式。先在原生 agy 完成登录，再导入该账号的授权 JSON 文件。授权内容仅发送到你的 VPS，不保存在浏览器。</p>
        <label className="block text-sm">账号名称<input className={CONTROL + ' mt-1 w-full'} value={alias} maxLength={80} onChange={event => setAlias(event.target.value)} required /></label>
        <label className="block text-sm">选择授权 JSON 文件<input type="file" accept=".json,application/json" className={CONTROL + ' mt-1 w-full'} onChange={event => {
          const file = event.target.files?.[0]; if (file) void file.text().then(setAuthorization);
        }} /></label>
        <label className="block text-sm">或粘贴授权 JSON<input type="password" autoComplete="off" className={CONTROL + ' mt-1 w-full'} value={authorization} onChange={event => setAuthorization(event.target.value)} /></label>
        <button type="submit" className={CONTROL + ' bg-primary text-primary-foreground'} disabled={pending || agent.busy || !authorization.trim()}>添加账号</button>
        <p className="text-xs text-muted-foreground">整合层不增加账号数量上限；账号切换由你手动选择。正在回复时请先等待结束或停止生成。</p>
      </form>
    </dialog>
  </section>;
}
