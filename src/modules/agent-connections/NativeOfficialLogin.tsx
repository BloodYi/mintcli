import { useEffect, useState } from 'react';
import { api, readApiJson } from '@/shared/api';
import type { OfficialAccountLogin } from '@/shared/types';
import { AccountAuthorization } from '@/modules/agent-connections/AccountAuthorization';
import { useAuthorizationPopup } from '@/modules/agent-connections/hooks/useAuthorizationPopup';

type Props = { provider: 'cursor' | 'opencode' | 'antigravity'; name?: string; disabled: boolean; onChanged: () => Promise<unknown> };
/** Used by the common account manager and native account cards for link-based official authorization. */
export function NativeOfficialLogin({ provider, name = '', disabled, onChanged }: Props) {
  // Only safe status and one-time return codes are held while this login card is open.
  const [login, setLogin] = useState<OfficialAccountLogin | null>(null);
  // A pasted code is cleared after submission or cancellation.
  const [code, setCode] = useState('');
  // Disable repeated actions while an authorization request is being submitted.
  const [busy, setBusy] = useState(false);
  // Transport failures remain visible without exposing raw CLI output or tokens.
  const [error, setError] = useState('');
  const { open, navigate, closePlaceholder } = useAuthorizationPopup();
  useEffect(() => { navigate(login?.url); }, [login?.url, navigate]);
  useEffect(() => {
    if (!login?.id || !['starting', 'pending', 'completing'].includes(login.status)) return;
    let alive = true;
    const timer = setInterval(() => {
      void api.agentConnections.officialLoginStatus(login.id!).then(readApiJson<OfficialAccountLogin>).then(async value => {
        if (!alive) return; setLogin(value);
        if (value.authorized) { setCode(''); await onChanged(); }
        if (['error', 'expired', 'cancelled'].includes(value.status)) closePlaceholder();
      }).catch(() => { if (alive) setError('授权状态暂时无法读取，请稍后重试'); });
    }, 2000);
    return () => { alive = false; clearInterval(timer); };
  }, [login?.id, login?.status, onChanged, closePlaceholder]);
  const perform = async (action: () => Promise<void>) => { setBusy(true); setError(''); try { await action(); } catch (failure) { setError(failure instanceof Error ? failure.message : '授权失败，请重试'); closePlaceholder(); } finally { setBusy(false); } };
  const waiting = Boolean(login && ['starting', 'pending', 'completing'].includes(login.status));
  return <div className="space-y-3">
    {provider === 'opencode' && <p className="text-xs text-muted-foreground">快速授权使用 OpenCode 官方支持的 ChatGPT 设备登录。其他服务可使用下方原生登录终端。</p>}
    <button type="button" disabled={disabled || busy || waiting} className="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50" onClick={() => {
      open(); setCode(''); setLogin(null);
      void perform(async () => { setLogin(await readApiJson<OfficialAccountLogin>(await api.agentConnections.startOfficialLogin(provider, name))); });
    }}>{busy ? '正在打开授权…' : '打开官方授权 / 添加账号'}</button>
    {login && <AccountAuthorization login={login} code={code} busy={busy} onCode={setCode}
      hint={provider === 'antigravity' ? '在 Google 官方网页完成授权，复制页面返回的授权码并粘贴到下方。账号会单独保存，当前账号保持选中。' : '在官方授权网页确认登录；页面会自动识别结果，无需复制凭证文件。'}
      onSubmit={() => void perform(async () => { const value = await readApiJson<OfficialAccountLogin>(await api.agentConnections.submitOfficialLogin(login.id!, code.trim())); setLogin(value); setCode(''); if (value.authorized) await onChanged(); })}
      onCancel={() => void perform(async () => { setLogin(await readApiJson<OfficialAccountLogin>(await api.agentConnections.cancelOfficialLogin(login.id!))); setCode(''); closePlaceholder(); })} />}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </div>;
}
