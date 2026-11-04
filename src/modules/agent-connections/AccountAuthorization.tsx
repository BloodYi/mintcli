import { useState } from 'react';
import type { OfficialAccountLogin } from '@/shared/types';

type Props = {
  login: OfficialAccountLogin;
  code: string;
  busy: boolean;
  hint: string;
  onCode: (value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
};
const button = 'rounded-md border border-border px-3 py-2 text-sm disabled:opacity-50';
const statuses: Record<string, string> = { starting: '正在生成授权链接…', pending: '等待完成官方授权', completing: '正在保存授权…', authorized: '登录成功，账号已添加', logged_in: '登录成功', error: '授权未完成，请重新发起', failed: '授权未完成，请重新发起', expired: '授权已过期，请重新发起', cancelled: '授权已取消', idle: '尚未开始授权' };

/** Used by AgentConnections and NativeOfficialLogin to present a CLI URL, device code or return-code field. */
export function AccountAuthorization({ login, code, busy, hint, onCode, onSubmit, onCancel }: Props) {
  // Copy feedback belongs to this authorization card and contains no credential data.
  const [copied, setCopied] = useState(false);
  return <section className="grid gap-3 rounded-lg border border-border bg-muted/20 p-3 text-sm" aria-label="官方账号授权">
    <p role="status">{login.authorized ? '登录成功，账号已添加' : statuses[login.status] || '正在检查授权状态…'}</p>
    {!login.authorized && <p className="text-muted-foreground">{hint}</p>}
    {login.url && !login.authorized && <>
      <a className="inline-flex w-fit rounded-md bg-primary px-3 py-2 text-primary-foreground" href={login.url} target="_blank" rel="noopener noreferrer">打开官方授权页面</a>
      <label>授权链接<input aria-label="官方授权链接" className="mt-1 w-full rounded-md border border-border bg-background p-2 text-xs" readOnly value={login.url} onFocus={event => event.target.select()} /></label>
      <button type="button" className={button + ' w-fit'} onClick={() => { void navigator.clipboard?.writeText(login.url!).then(() => setCopied(true)).catch(() => setCopied(false)); }}>{copied ? '链接已复制' : '复制授权链接'}</button>
    </>}
    {login.code && !login.authorized && <div><p>在官方网页输入以下设备验证码：</p><p className="select-all break-all rounded border border-border bg-background p-2 font-mono text-lg">{login.code}</p></div>}
    {login.acceptsCode && !login.authorized && <>
      <label>授权返回码 / 回调地址<textarea aria-label="授权返回码 / 回调地址" rows={3} className="mt-1 w-full rounded-md border border-border bg-background p-2 font-mono text-xs" autoComplete="off" spellCheck={false} value={code} onChange={event => onCode(event.target.value)} placeholder="粘贴本次官方授权返回的内容" /></label>
      <button type="button" disabled={busy || !code.trim()} className={button + ' w-fit'} onClick={onSubmit}>提交授权并完成登录</button>
    </>}
    {['starting', 'pending'].includes(login.status) && <button type="button" disabled={busy} className={button + ' w-fit'} onClick={onCancel}>取消授权</button>}
  </section>;
}
