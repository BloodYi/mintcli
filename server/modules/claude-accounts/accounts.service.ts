import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import * as pty from 'node-pty';
import { AppError, resolveManagedCli } from '@/shared/index.js';
import type { AnyRecord } from '@/shared/types.js';

type Account = { id: string; name: string; email?: string };
type Store = { activeId: string; accounts: Account[] };
const root = () => process.env.CLAUDE_ACCOUNTS_ROOT || path.join(os.homedir(), 'unified', 'claude');
const fail = (message: string) => new AppError(message, { code: 'CLAUDE_ACCOUNT_ERROR', statusCode: 400 });
const legacyHome = () => path.join(os.homedir(), '.claude');
const home = (id: string) => {
  if (id !== 'legacy' && !/^[a-f0-9-]{36}$/.test(id)) throw fail('Claude 账号不存在');
  return id === 'legacy' ? legacyHome() : path.join(root(), 'accounts', id);
};
function read(): Store {
  try { return JSON.parse(fs.readFileSync(path.join(root(), 'store.json'), 'utf8')) as Store; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw fail('Claude 账号列表读取失败');
    return { activeId: 'legacy', accounts: [{ id: 'legacy', name: 'Claude 默认账号' }] };
  }
}
function write(value: Store) {
  fs.mkdirSync(root(), { recursive: true, mode: 0o700 });
  const temp = path.join(root(), 'store-' + randomUUID() + '.tmp');
  fs.writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(temp, path.join(root(), 'store.json'));
}
function credentials(id: string): AnyRecord | null {
  try { return JSON.parse(fs.readFileSync(path.join(home(id), '.credentials.json'), 'utf8')); } catch { return null; }
}
const busy = new Map<string, number>();
const quotas = new Map<string, AnyRecord>();
const logins = new Map<string, { process: pty.IPty; url?: string; status: string; timer: ReturnType<typeof setTimeout> }>();
const quotaJobs = new Map<string, Promise<AnyRecord>>();
const nativeBinary = () => process.env.CLAUDE_CLI_PATH || resolveManagedCli('claude') || path.join(path.dirname(createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk-linux-x64/package.json')), 'claude');
function ensureProfile(id: string) {
  const target = home(id);
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(legacyHome(), 'projects'), { recursive: true, mode: 0o700 });
  if (id !== 'legacy' && !fs.existsSync(path.join(target, 'projects'))) fs.symlinkSync(path.join(legacyHome(), 'projects'), path.join(target, 'projects'), 'dir');
}
function publicAccount(account: Account) {
  const cred = credentials(account.id);
  return { ...account, provider: 'claude', kind: 'claude', authorized: Boolean(cred?.claudeAiOauth?.accessToken) };
}
function resolve(id?: string) {
  const store = read();
  const account = store.accounts.find(item => item.id === (id || store.activeId));
  if (!account) throw fail('Claude 账号不存在，请重新选择');
  return account;
}
function accountEnv(id: string): Record<string, string> {
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  for (const key of Object.keys(env)) if (/^(?:ANTHROPIC_|CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_CODE_USE_(?:BEDROCK|VERTEX|FOUNDRY))/.test(key)) delete env[key];
  delete env.CLAUDECODE;
  return { ...env, CLAUDE_CONFIG_DIR: home(id), BROWSER: '/bin/true' };
}
async function refreshIdentity(id: string) {
  await new Promise<void>(done => execFile(nativeBinary(), ['auth', 'status'], { env: accountEnv(id), timeout: 15000, maxBuffer: 65536 }, (_error, stdout) => {
    try {
      const status = JSON.parse(stdout);
      const store = read();
      const item = store.accounts.find(value => value.id === id);
      if (item && typeof status.email === 'string') { item.email = status.email; write(store); }
    } catch { /* Missing identity is distinct from successful native authorization. */ }
    done();
  }));
}

/** Native account profiles share transcripts, while authorization stays isolated per selected account. */
export const claudeAccounts = {
  list() { const store = read(); return { activeId: store.activeId, accounts: store.accounts.map(publicAccount) }; },
  resolve,
  env: accountEnv,
  select(id: string) { resolve(id); const store = read(); store.activeId = id; write(store); return this.list(); },
  save(input: AnyRecord) {
    const store = read();
    const previous = input.id ? resolve(input.id) : undefined;
    const id = previous?.id || randomUUID();
    const name = String(input.name || '').trim();
    if (!name || name.length > 80) throw fail('请填写 1–80 字的账号名称');
    if (input.credentials && busy.get(id)) throw fail('此账号正在生成回复，请结束后再更新授权');
    ensureProfile(id);
    if (input.credentials) {
      let value: AnyRecord;
      try { value = typeof input.credentials === 'string' ? JSON.parse(input.credentials) : input.credentials; } catch { throw fail('请提供原生 Claude .credentials.json 文件内容'); }
      if (typeof value?.claudeAiOauth?.accessToken !== 'string' || !value.claudeAiOauth.accessToken) throw fail('没有找到 Claude 官方登录凭据');
      fs.writeFileSync(path.join(home(id), '.credentials.json'), JSON.stringify(value), { mode: 0o600 });
      quotas.delete(id);
    }
    const account = { ...previous, id, name };
    if (previous) store.accounts = store.accounts.map(item => item.id === id ? account : item); else store.accounts.push(account);
    write(store);
    return publicAccount(account);
  },
  remove(id: string) {
    resolve(id);
    if (busy.get(id)) throw fail('此账号正在生成回复，请结束后再移除');
    this.cancelLogin(id);
    const store = read(); store.accounts = store.accounts.filter(item => item.id !== id);
    if (store.activeId === id) store.activeId = store.accounts[0]?.id || '';
    write(store); quotas.delete(id);
    // Profiles remain recoverable on disk; removing an entry never deletes shared conversations.
    return this.list();
  },
  begin(id?: string) {
    const account = resolve(id);
    if (!publicAccount(account).authorized) throw fail('请先在账号管理中登录这个 Claude 账号');
    if (logins.get(account.id)?.status === 'pending') throw fail('此账号正在重新登录，请完成后再发送');
    busy.set(account.id, (busy.get(account.id) || 0) + 1);
    return { account, env: accountEnv(account.id), end: () => busy.set(account.id, Math.max(0, (busy.get(account.id) || 1) - 1)) };
  },
  loginStatus(id: string) {
    const account = resolve(id); const login = logins.get(id);
    return { status: login?.status || (publicAccount(account).authorized ? 'authorized' : 'idle'), url: login?.url, authorized: login ? login.status === 'authorized' : publicAccount(account).authorized };
  },
  startLogin(id: string) {
    resolve(id);
    if (busy.get(id)) throw fail('此账号正在生成回复，请结束后再登录');
    this.cancelLogin(id); ensureProfile(id);
    const child = pty.spawn(nativeBinary(), ['auth', 'login', '--claudeai'], { name: 'xterm-256color', cols: 2400, rows: 40, cwd: home(id), env: accountEnv(id) });
    const state = { process: child, status: 'pending', url: undefined as string | undefined, timer: setTimeout(() => this.cancelLogin(id), 10 * 60 * 1000) };
    state.timer.unref(); logins.set(id, state);
    let text = '';
    child.onData(chunk => {
      text = (text + chunk.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')).slice(-24000);
      const urls = text.match(/https:\/\/[^\s<>\x00-\x1f]+/g) || [];
      for (const candidate of urls) {
        try { const url = new URL(candidate); if (['claude.ai', 'claude.com', 'console.anthropic.com', 'platform.claude.com'].includes(url.hostname) && /oauth|authorize/.test(url.pathname)) state.url = url.href; } catch { /* Ignore terminal fragments. */ }
      }
    });
    child.onExit(({ exitCode }) => { clearTimeout(state.timer); if (state.status === 'cancelled') return; try { state.status = exitCode === 0 && publicAccount(resolve(id)).authorized ? 'authorized' : 'failed'; void refreshIdentity(id); } catch { state.status = 'cancelled'; } });
    return this.loginStatus(id);
  },
  submitCode(id: string, code: unknown) {
    resolve(id); const login = logins.get(id);
    if (!login || login.status !== 'pending' || typeof code !== 'string' || !code.trim() || code.length > 4096 || /[\r\n\x00-\x1f]/.test(code)) throw fail('授权码无效或登录已结束，请重新授权');
    login.process.write(code.trim() + '\r'); return this.loginStatus(id);
  },
  cancelLogin(id: string) { const login = logins.get(id); if (login) { clearTimeout(login.timer); login.status = 'cancelled'; try { login.process.kill(); } catch { /* Already exited. */ } } return { status: 'cancelled' }; },
  recordQuota(id: string, event: AnyRecord) {
    const info = event.rate_limit_info;
    if (event.type !== 'rate_limit_event' || !info || typeof info.utilization !== 'number' || info.utilization < 0 || info.utilization > 1) return;
    const previous = quotas.get(id)?.windows || [];
    const bucket = String(info.rateLimitType || '额度窗口');
    const window = { bucket, remainingPercent: Math.round((1 - info.utilization) * 1000) / 10, resetsAt: info.resetsAt || null };
    quotas.set(id, { status: 'available', checkedAt: Date.now(), source: 'Claude 原生运行事件', windows: [...previous.filter((value: AnyRecord) => value.bucket !== bucket), window] });
  },
  async quota(id: string, force = false): Promise<AnyRecord> {
    const account = resolve(id);
    if (!publicAccount(account).authorized) return { status: 'unavailable', windows: [], reason: '请先登录 Claude 账号' };
    if (!force) return quotas.get(id) || { status: 'unavailable', windows: [], reason: '尚未取得额度，点击刷新或发送消息后读取原生额度' };
    if (quotaJobs.has(id)) return quotaJobs.get(id)!;
    const job = new Promise<AnyRecord>(done => {
      // /usage is a native CLI command, never a model completion or a proxy endpoint.
      let child: pty.IPty;
      try { child = pty.spawn(nativeBinary(), [], { name: 'xterm-256color', cols: 180, rows: 60, cwd: home(id), env: accountEnv(id) }); }
      catch { done({ status: 'unavailable', windows: [], reason: 'Claude 原生额度命令暂不可用' }); return; }
      let text = '', settled = false;
      const finish = (value: AnyRecord) => { if (settled) return; settled = true; clearTimeout(timer); try { child.kill(); } catch { /* Exited. */ } if (value.windows.length) quotas.set(id, value); done(value); };
      const timer = setTimeout(() => finish(quotas.get(id) || { status: 'unavailable', windows: [], reason: '原生 CLI 暂未返回额度；完成首次登录设置后再刷新' }), 20000);
      const send = setTimeout(() => child.write('/usage\r'), 2500);
      child.onData(chunk => {
        text = (text + chunk.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')).slice(-32000);
        const windows: AnyRecord[] = [];
        const regex = /Current (session|week[^\r\n]*)([\s\S]*?)(?=Current (?:session|week)|$)/g;
        for (const match of text.matchAll(regex)) {
          const used = match[2].match(/(\d+(?:\.\d+)?)%\s*used/i);
          if (used && Number(used[1]) <= 100) windows.push({ bucket: match[1] === 'session' ? '5 小时' : '7 天' + match[1].replace(/^week/, ''), remainingPercent: 100 - Number(used[1]), resetsAt: null });
        }
        if (windows.length >= 2) finish({ status: 'available', windows, checkedAt: Date.now(), source: 'Claude 原生 /usage' });
      });
      child.onExit(() => { clearTimeout(send); finish(quotas.get(id) || { status: 'unavailable', windows: [], reason: '原生 CLI 未返回可读取的额度' }); });
    }).finally(() => quotaJobs.delete(id));
    quotaJobs.set(id, job); return job;
  },
};
