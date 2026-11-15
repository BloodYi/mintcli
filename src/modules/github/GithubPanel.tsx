import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, Copy, ExternalLink, GitBranch, Github, KeyRound, Loader2, LogOut, RefreshCw, Upload } from 'lucide-react';
import { api, readApiJson } from '@/shared/api';
import { copyTextToClipboard } from '@/shared/utils';
import type { GithubConnection, GithubLogin, GithubRepository, Project } from '@/shared/types';

type Props = { project?: Project | null; compact?: boolean };

/** Used by the plugins workspace and Git settings to sign in and upload the selected project's committed code. */
export function GithubPanel({ project, compact = false }: Props) {
  // Connection and authorization state stay in memory; access tokens never enter browser storage.
  const [connection, setConnection] = useState<GithubConnection | null>(null);
  // Device authorization can finish in another browser, so the panel tracks its server-owned state.
  const [login, setLogin] = useState<GithubLogin | null>(null);
  // The token is kept only while its password form is open and is cleared after successful login.
  const [token, setToken] = useState('');
  // Only an explicit user action opens the optional token form.
  const [tokenForm, setTokenForm] = useState(false);
  // One account mutation at a time prevents overlapping login and logout actions.
  const [accountBusy, setAccountBusy] = useState(false);
  // Associate the preview with its project to hide old data immediately on a project switch.
  const [preview, setPreview] = useState<{ projectId: string; data: GithubRepository | null; error: string | null } | null>(null);
  // Upload results belong to the project that was submitted, even if selection changes meanwhile.
  const [upload, setUpload] = useState<{ projectId: string; busy: boolean; message?: string; url?: string; error?: string } | null>(null);
  // Feedback reports account errors and copy outcomes without exposing credentials.
  const [notice, setNotice] = useState<{ error?: string; message?: string } | null>(null);
  // Manual refresh discards stale local Git metadata after the user commits or pulls.
  const [revision, setRevision] = useState(0);
  const mounted = useRef(true);
  const projectId = project?.projectId;
  const currentProject = useRef(projectId);
  currentProject.current = projectId;
  const repository = preview && preview.projectId === projectId ? preview.data : null;
  const projectUpload = upload?.projectId === projectId ? upload : null;
  const pending = login?.status === 'starting' || login?.status === 'waiting';
  const errorText = (error: unknown) => error instanceof Error ? error.message : '操作未完成，请稍后重试。';

  const refreshConnection = useCallback(async () => {
    const result = await readApiJson<GithubConnection>(await api.github.status());
    if (mounted.current) setConnection(result);
  }, []);

  useEffect(() => {
    mounted.current = true;
    let active = true;
    void Promise.all([api.github.status().then(readApiJson<GithubConnection>), api.github.loginStatus().then(readApiJson<{ login: GithubLogin | null }>)])
      .then(([status, authorization]) => { if (active) { setConnection(status); setLogin(authorization.login); } })
      .catch(error => { if (active) { setConnection({ connected: false, account: null }); setNotice({ error: errorText(error) }); } });
    return () => { active = false; mounted.current = false; };
  }, []);

  useEffect(() => {
    if (!pending) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const response = await readApiJson<{ login: GithubLogin | null }>(await api.github.loginStatus());
        if (!active) return;
        setLogin(response.login);
        if (response.login?.status === 'complete') { await refreshConnection(); return; }
        if (response.login?.status === 'failed') { setNotice({ error: response.login.error || '授权未完成，请重试。' }); return; }
        if (!response.login) return;
      } catch (error) { if (active) setNotice({ error: errorText(error) }); }
      if (active) timer = setTimeout(() => void poll(), 2000);
    };
    timer = setTimeout(() => void poll(), 1000);
    return () => { active = false; clearTimeout(timer); };
  }, [pending, refreshConnection]);

  useEffect(() => {
    if (!projectId) return;
    const controller = new AbortController();
    setPreview(null);
    void api.github.repository(projectId, controller.signal).then(readApiJson<{ repository: GithubRepository }>)
      .then(result => { if (!controller.signal.aborted) setPreview({ projectId, data: result.repository, error: null }); })
      .catch(error => { if (!controller.signal.aborted) setPreview({ projectId, data: null, error: errorText(error) }); });
    return () => controller.abort();
  }, [projectId, revision]);

  async function accountAction(action: () => Promise<void>) {
    setAccountBusy(true); setNotice(null);
    try { await action(); } catch (error) { if (mounted.current) setNotice({ error: errorText(error) }); }
    finally { if (mounted.current) setAccountBusy(false); }
  }

  async function push() {
    if (!projectId || !repository) return;
    const capturedProject = projectId;
    setUpload({ projectId, busy: true });
    try {
      const result = await readApiJson<{ url: string; head: string }>(await api.github.push(projectId, repository.head, repository.branch));
      if (!mounted.current) return;
      setUpload({ projectId: capturedProject, busy: false, message: `上传成功 · ${result.head.slice(0, 8)}`, url: result.url });
      if (currentProject.current === capturedProject) setRevision(value => value + 1);
    } catch (error) { if (mounted.current) setUpload({ projectId: capturedProject, busy: false, error: errorText(error) }); }
  }

  return <div className={compact ? 'space-y-4' : 'mx-auto w-full max-w-4xl space-y-5 p-4 sm:p-6'}>
    <section className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm" aria-label="GitHub 账号">
      <div className="flex items-center gap-4 border-b border-border bg-gradient-to-br from-muted/70 to-background p-5 sm:p-6">
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-foreground text-background"><Github className="h-7 w-7" /></div>
        <div className="min-w-0 flex-1"><h2 className="text-lg font-semibold">GitHub</h2><p className="mt-1 text-sm text-muted-foreground">连接账号，让项目上传更方便</p></div>
        <span className={'shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ' + (connection?.connected ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'bg-muted text-muted-foreground')}>{connection === null ? '检查中' : connection.connected ? '已连接' : '未登录'}</span>
      </div>
      <div className="space-y-4 p-5 sm:p-6">
        {connection?.connected && connection.account ? <div className="flex flex-wrap items-center gap-3">
          <CheckCircle2 className="h-5 w-5 text-emerald-500" /><div className="min-w-0 flex-1"><p className="font-medium">{connection.account.name}</p><a href={connection.account.url} target="_blank" rel="noopener noreferrer" className="text-sm text-muted-foreground">@{connection.account.login}</a></div>
          <button className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm hover:bg-muted disabled:opacity-50" disabled={accountBusy || !!projectUpload?.busy} onClick={() => void accountAction(async () => { await readApiJson(await api.github.logout()); setConnection({ connected: false, account: null }); setLogin(null); setToken(''); })}><LogOut className="h-4 w-4" />退出登录</button>
        </div> : <>
          <p className="text-sm leading-6 text-muted-foreground">使用浏览器授权登录。登录完成后，可在这里或 Git 面板上传已提交的代码。</p>
          {!pending && <div className="flex flex-wrap gap-3">
            <button className="inline-flex items-center gap-2 rounded-lg bg-foreground px-4 py-2.5 text-sm font-medium text-background disabled:opacity-50" disabled={accountBusy} onClick={() => void accountAction(async () => { const result = await readApiJson<{ login: GithubLogin }>(await api.github.startLogin()); setLogin(result.login); })}>{accountBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Github className="h-4 w-4" />}登录 GitHub</button>
            <button className="inline-flex items-center gap-2 rounded-lg border border-border px-4 py-2.5 text-sm hover:bg-muted" onClick={() => setTokenForm(value => !value)}><KeyRound className="h-4 w-4" />使用访问令牌</button>
          </div>}
        </>}
        {pending && <div className="space-y-3 rounded-xl border border-primary/20 bg-primary/5 p-4" aria-label="GitHub 浏览器授权">
          <p className="text-sm font-medium">在 GitHub 输入一次性授权码</p>
          {login?.code ? <div className="flex flex-wrap items-center gap-3"><code className="rounded-lg border border-border bg-background px-4 py-2 text-xl font-semibold tracking-widest" data-testid="github-device-code">{login.code}</code><button aria-label="复制授权码" className="rounded-lg p-2 hover:bg-muted" onClick={() => void copyTextToClipboard(login.code!).then(copied => setNotice(copied ? { message: '授权码已复制' } : { error: '请手动复制授权码。' }))}><Copy className="h-4 w-4" /></button></div> : <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />正在获取授权码…</p>}
          <div className="flex flex-wrap gap-3"><a className="inline-flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground" href="https://github.com/login/device" target="_blank" rel="noopener noreferrer">打开 GitHub 授权页<ExternalLink className="h-3.5 w-3.5" /></a><button className="rounded-lg px-3 py-2 text-sm text-muted-foreground hover:bg-muted" disabled={accountBusy} onClick={() => void accountAction(async () => { await readApiJson(await api.github.cancelLogin()); setLogin(null); })}>取消登录</button></div>
          <p className="text-xs leading-5 text-muted-foreground">请确认授权页地址为 github.com。完成授权后，此页面会自动连接。</p>
        </div>}
        {tokenForm && !connection?.connected && !pending && <form className="space-y-3 rounded-xl border border-border bg-muted/20 p-4" onSubmit={event => { event.preventDefault(); void accountAction(async () => { const result = await readApiJson<GithubConnection>(await api.github.tokenLogin(token)); setToken(''); setTokenForm(false); setLogin(null); setConnection(result); }); }}>
          <label htmlFor="github-access-token" className="block text-sm font-medium">GitHub 访问令牌</label>
          <input id="github-access-token" type="password" autoComplete="new-password" value={token} onChange={event => setToken(event.target.value)} placeholder="github_pat_… 或 ghp_…" className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm" />
          <p className="text-xs leading-5 text-muted-foreground">选择目标仓库，并授予 Contents 读写权限。上传工作流文件时还需工作流权限。</p>
          <div className="flex flex-wrap items-center gap-3"><button type="submit" disabled={accountBusy || !token.trim()} className="rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-50">验证并登录</button><a href="https://github.com/settings/tokens?type=beta" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-sm text-primary">创建访问令牌<ExternalLink className="h-3 w-3" /></a></div>
        </form>}
        {notice?.error && <p role="alert" className="rounded-lg bg-red-500/10 p-3 text-sm text-red-600 dark:text-red-400">{notice.error}</p>}
        {notice?.message && <p role="status" className="text-sm text-emerald-600 dark:text-emerald-400">{notice.message}</p>}
      </div>
    </section>
    {!compact && <section className="space-y-4 rounded-2xl border border-border bg-card p-5 shadow-sm sm:p-6" aria-label="上传到 GitHub">
      <div className="flex items-center justify-between gap-3"><h3 className="flex items-center gap-2 font-semibold"><Upload className="h-4 w-4" />上传到 GitHub</h3><button aria-label="刷新上传信息" className="rounded-lg p-2 text-muted-foreground hover:bg-muted disabled:opacity-50" disabled={!projectId || projectUpload?.busy} onClick={() => setRevision(value => value + 1)}><RefreshCw className="h-4 w-4" /></button></div>
      {!projectId ? <p className="text-sm text-muted-foreground">请先在侧栏选择要上传的项目。</p> : <>
        <p className="break-all text-sm text-muted-foreground">当前项目：{project?.displayName || projectId}</p>
        {preview?.projectId === projectId && preview.error ? <p role="alert" className="text-sm text-amber-600 dark:text-amber-400">{preview.error}</p> : repository ? <>
          <div className="space-y-3 rounded-xl border border-border bg-muted/20 p-4">
            {repository.url ? <a href={repository.url} target="_blank" rel="noopener noreferrer" className="inline-flex max-w-full items-center gap-2 break-all text-sm font-medium"><Github className="h-4 w-4 shrink-0" />{repository.name}<ExternalLink className="h-3 w-3 shrink-0" /></a> : <p className="text-sm text-amber-600">此项目尚未连接 GitHub 仓库。</p>}
            <div className="flex flex-wrap gap-x-5 gap-y-2 text-xs text-muted-foreground"><span className="inline-flex items-center gap-1.5"><GitBranch className="h-3.5 w-3.5" />{repository.branch} → {repository.remoteBranch}</span><code>提交 {repository.head.slice(0, 8)}</code>{repository.ahead !== null && <span>待上传 {repository.ahead} 个提交（本地记录）</span>}</div>
          </div>
          <p className="text-xs leading-5 text-muted-foreground">{repository.changedFiles > 0 ? `有 ${repository.changedFiles} 项未提交修改，请先在 Git 面板提交。` : '工作区已提交。'}上传仅包含下方按钮对应的提交，未提交文件会保留在本地。</p>
          <button className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-3 text-sm font-medium text-primary-foreground disabled:opacity-50 sm:w-auto" disabled={!connection?.connected || !repository.name || !!projectUpload?.busy || accountBusy} onClick={() => void push()}>{projectUpload?.busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}{projectUpload?.busy ? '正在上传…' : `上传已提交更改 · ${repository.head.slice(0, 8)}`}</button>
        </> : <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />正在读取项目信息…</p>}
        {projectUpload?.error && <p role="alert" className="rounded-lg bg-red-500/10 p-3 text-sm text-red-600 dark:text-red-400">{projectUpload.error}</p>}
        {projectUpload?.message && <div role="status" className="space-y-2 rounded-lg bg-emerald-500/10 p-3 text-sm text-emerald-600 dark:text-emerald-400"><p>{projectUpload.message}</p>{projectUpload.url && <a href={projectUpload.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 underline">在 GitHub 查看<ExternalLink className="h-3 w-3" /></a>}</div>}
      </>}
    </section>}
  </div>;
}
