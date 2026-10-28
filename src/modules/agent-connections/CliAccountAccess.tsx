import { useCallback, useEffect, useState } from 'react';
import { StandaloneShell } from '@/modules/standalone-shell';
import { api, readApiJson } from '@/shared/api';

type NativeStatus = { installed: boolean; authenticated: boolean; email: string | null; installedVersion?: string | null; error?: string };
const commands = { cursor: 'cursor-agent login', opencode: 'opencode auth login' };
const names = { cursor: 'Cursor', opencode: 'OpenCode' };

/** Used by AgentConnections to keep native CLI login inside the common account dialog. */
export function CliAccountAccess({ provider, disabled, onChanged }: { provider: 'cursor' | 'opencode'; disabled: boolean; onChanged: () => Promise<unknown> }) {
  // Native status is fetched when this account is opened and after its login command completes.
  const [status, setStatus] = useState<NativeStatus | null>(null);
  // The shell is mounted only after an explicit login action so browsing accounts never starts authorization.
  const [loggingIn, setLoggingIn] = useState(false);
  // Prevent overlapping account-status refreshes and expose readable failures.
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const refresh = useCallback(async () => {
    setBusy(true); setError('');
    try { const payload = await readApiJson<{ data: NativeStatus }>(await api.providers.authStatus(provider)); setStatus(payload.data); }
    catch (failure) { setError(failure instanceof Error ? failure.message : '登录状态读取失败'); }
    finally { setBusy(false); }
  }, [provider]);
  useEffect(() => { void refresh(); }, [refresh]);
  const complete = useCallback(async () => { await refresh(); await onChanged(); }, [refresh, onChanged]);
  return <section className="space-y-3 rounded-lg border border-border p-3" aria-label={`${names[provider]} 官方账号`}>
    <h3 className="font-medium">{names[provider]} 官方账号</h3>
    <p role="status" className="text-sm text-muted-foreground">{busy ? '正在检查登录…' : !status ? error : !status.installed ? 'CLI 尚未安装' : status.authenticated ? `已登录${status.email ? ' · ' + status.email : ''}` : '未登录'}</p>
    <div className="flex flex-wrap gap-2">
      <button type="button" disabled={disabled || busy || !status?.installed} className="rounded border border-border px-3 py-2 text-sm disabled:opacity-50" onClick={() => setLoggingIn(true)}>官方登录 / 重新授权</button>
      <button type="button" disabled={busy} className="rounded border border-border px-3 py-2 text-sm disabled:opacity-50" onClick={() => void complete()}>检查登录状态</button>
      {loggingIn && <button type="button" className="rounded border border-border px-3 py-2 text-sm" onClick={() => setLoggingIn(false)}>关闭登录终端</button>}
    </div>
    {loggingIn && <div className="h-80 overflow-hidden rounded-lg border border-border" aria-label={`${names[provider]} 登录终端`}>
      <StandaloneShell project={{ projectId: `login-${provider}`, displayName: names[provider], fullPath: '', path: '' }} command={commands[provider]} minimal onComplete={() => void complete()} />
    </div>}
  </section>;
}
