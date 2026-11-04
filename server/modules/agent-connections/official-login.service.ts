import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as pty from 'node-pty';
import { antigravityBridge } from '@/modules/antigravity/index.js';
import { providerAuthService, sessionsService } from '@/modules/providers/index.js';
import { AppError, resolveManagedCli, stripAnsiSequences } from '@/shared/index.js';
import type { LLMProvider } from '@/shared/types.js';

type Flow = {
  id: string; provider: LLMProvider; status: string; url?: string; code?: string; acceptsCode: boolean;
  expiresAt: number; child: pty.IPty; home?: string; choseGoogle: boolean; importing: boolean;
  accountId?: string; email?: string; codeSubmitted: boolean; timer: ReturnType<typeof setTimeout>; poll?: ReturnType<typeof setInterval>;
};
const TTL_MS = 10 * 60000;
const fail = (message: string, statusCode = 400) => new AppError(message, { code: 'OFFICIAL_LOGIN_ERROR', statusCode });

/** Used by the account routes and regression tests to wrap the installed CLI's own OAuth flow. */
export function createOfficialLoginService(overrides: { spawn?: typeof pty.spawn; importAgy?: (body: unknown) => Promise<Response>; busy?: () => Promise<LLMProvider[]> } = {}) {
  const flows = new Map<string, Flow>();
  const spawn = overrides.spawn || pty.spawn;
  const busy = overrides.busy || (async () => (await sessionsService.listRunningSessions()).map(item => item.provider));
  const importAgy = overrides.importAgy || (body => antigravityBridge.request('POST', '/api/accounts/add', body));
  const get = (id: string) => { const flow = flows.get(id); if (!flow) throw fail('授权不存在或已结束，请重新发起', 404); return flow; };
  const publicStatus = (flow: Flow) => ({ id: flow.id, status: flow.status, url: flow.url, code: flow.code, acceptsCode: flow.acceptsCode,
    expiresAt: flow.expiresAt, authorized: flow.status === 'authorized', accountId: flow.accountId, email: flow.email });
  const finish = (flow: Flow, status: string) => {
    flow.status = status; flow.acceptsCode = false; clearTimeout(flow.timer); clearInterval(flow.poll);
    try { flow.child.kill(); } catch { /* Already exited. */ }
    if (flow.home) void fs.rm(flow.home, { recursive: true, force: true }).catch(() => {});
    // Retain only safe status briefly; credentials and CLI output are never returned to the browser.
    const cleanup = setTimeout(() => flows.delete(flow.id), TTL_MS); cleanup.unref();
  };
  return {
    status(id: string) { return publicStatus(get(id)); },
    async start(provider: LLMProvider, name: string) {
      if (!['cursor', 'opencode', 'antigravity'].includes(provider)) throw fail('此账号不支持该授权入口');
      const pending = () => [...flows.values()].find(flow => flow.provider === provider && ['starting', 'pending', 'completing'].includes(flow.status));
      const existing = pending();
      if (existing) return publicStatus(existing);
      if (provider !== 'antigravity' && (await busy()).includes(provider)) throw fail('此 CLI 正在执行任务，请等待结束后再重新登录', 409);
      const startedMeanwhile = pending();
      if (startedMeanwhile) return publicStatus(startedMeanwhile);
      const id = randomUUID();
      const home = provider === 'antigravity' ? await fs.mkdtemp(path.join(os.tmpdir(), 'mintcli-agy-login-')) : undefined;
      const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
      env.BROWSER = '/bin/true'; env.NO_OPEN_BROWSER = '1';
      if (home) {
        env.HOME = home; env.XDG_CONFIG_HOME = path.join(home, '.config'); env.XDG_DATA_HOME = path.join(home, '.local/share');
        for (const key of Object.keys(env)) if (/^(?:GOOGLE_|GEMINI_|AGY_|ANTIGRAVITY_)/.test(key)) delete env[key];
      }
      const command = resolveManagedCli(provider) || (provider === 'cursor' ? 'cursor-agent' : provider === 'opencode' ? 'opencode' : 'agy');
      const args = provider === 'cursor' ? ['login'] : provider === 'opencode' ? ['auth', 'login', '--provider', 'openai', '--method', 'ChatGPT Pro/Plus (headless)'] : [];
      let child: pty.IPty;
      try { child = spawn(command, args, { name: 'xterm-256color', cols: 2400, rows: 40, cwd: home || os.homedir(), env }); }
      catch { if (home) await fs.rm(home, { recursive: true, force: true }); throw fail('无法启动官方 CLI 授权，请检查安装状态'); }
      const flow: Flow = { id, provider, child, home, status: 'starting', acceptsCode: false, expiresAt: Date.now() + TTL_MS,
        choseGoogle: false, importing: false, codeSubmitted: false, timer: setTimeout(() => finish(flow, 'expired'), TTL_MS) };
      flow.timer.unref(); flows.set(id, flow);
      let output = '';
      const importCredentials = async () => {
        if (!home || flow.importing || !['starting', 'pending'].includes(flow.status)) return;
        let tokenJson: string;
        try { tokenJson = await fs.readFile(path.join(home, '.gemini/antigravity-cli/antigravity-oauth-token'), 'utf8'); if (!JSON.parse(tokenJson)?.token) return; }
        catch { return; }
        flow.importing = true; flow.status = 'completing';
        try {
          // A unique alias prevents a new authorization from overwriting any saved agy account.
          const response = await importAgy({ alias: `${name || 'agy'}-${id.slice(0, 8)}`, token_json: tokenJson, switch_now: false });
          if (!response.ok) throw fail('新账号授权保存失败');
          const result = await response.json() as { id?: string; email?: string };
          flow.accountId = result.id; flow.email = result.email; finish(flow, 'authorized');
        } catch { finish(flow, 'error'); }
      };
      child.onData(chunk => {
        if (!['starting', 'pending'].includes(flow.status)) return;
        output = stripAnsiSequences(output + chunk).slice(-32000);
        if (provider === 'antigravity' && !flow.choseGoogle && /Select login method/.test(output)) { flow.choseGoogle = true; child.write('\r'); }
        const hosts = provider === 'cursor' ? ['cursor.com', 'www.cursor.com'] : provider === 'opencode' ? ['auth.openai.com', 'chatgpt.com'] : ['accounts.google.com'];
        for (const match of output.matchAll(/https:\/\/[^\s<>\x00-\x1f]+/g)) {
          try { const url = new URL(match[0]); if (hosts.includes(url.hostname) && !url.username && !url.password) { flow.url = url.href; flow.status = 'pending'; } } catch { /* Incomplete CLI output. */ }
        }
        if (provider === 'opencode') flow.code = output.match(/\b[A-Z0-9]{3,8}-[A-Z0-9]{3,8}(?:-[A-Z0-9]{3,8})?\b/)?.[0];
        if (provider === 'antigravity' && !flow.codeSubmitted && /paste the authorization code|authorization code\.\.\./i.test(output)) flow.acceptsCode = true;
      });
      if (home) { flow.poll = setInterval(() => void importCredentials(), 500); flow.poll.unref(); }
      child.onExit(({ exitCode }) => {
        if (!['starting', 'pending'].includes(flow.status)) return;
        if (home) { void importCredentials().then(() => { if (['starting', 'pending'].includes(flow.status)) finish(flow, 'error'); }); }
        else if (exitCode !== 0) finish(flow, 'error');
        else {
          flow.status = 'completing';
          void providerAuthService.getProviderAuthStatus(provider).then(status => { flow.email = status.email || undefined; finish(flow, status.authenticated ? 'authorized' : 'error'); }).catch(() => finish(flow, 'error'));
        }
      });
      return publicStatus(flow);
    },
    submit(id: string, code: unknown) {
      const flow = get(id);
      if (flow.status !== 'pending' || !flow.acceptsCode || typeof code !== 'string' || !code.trim() || code.length > 4096 || /[\x00-\x1f\x7f]/.test(code)) throw fail('授权码无效或授权已结束，请重新发起');
      // This CLI remains interactive after login; never send a second copy as a chat prompt.
      flow.codeSubmitted = true; flow.acceptsCode = false;
      clearTimeout(flow.timer); flow.timer = setTimeout(() => finish(flow, 'error'), 60000); flow.timer.unref();
      flow.child.write(code.trim() + '\r'); return publicStatus(flow);
    },
    cancel(id: string) { const flow = get(id); if (['starting', 'pending'].includes(flow.status)) finish(flow, 'cancelled'); return publicStatus(flow); },
  };
}

/** Used only by the JWT-protected account routes; native credential files remain server-side. */
export const officialLoginService = createOfficialLoginService();
