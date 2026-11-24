import { egressEnvironment, egressFetch } from '@/modules/egress/index.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import * as pty from 'node-pty';
import { AppError, resolveManagedCli } from '@/shared/index.js';
import type { AnyRecord } from '@/shared/types.js';

type Account = { id: string; name: string; email?: string; subscriptionType?: string; rateLimitTier?: string; seatTier?: string };

const CLAUDE_ORG_TYPE_TO_SUB: Record<string, string> = {
  claude_max: 'max',
  claude_pro: 'pro',
  claude_team: 'team',
  claude_enterprise: 'enterprise',
  claude_free: 'free',
};

const CLAUDE_SEAT_TIER_KIND: Record<string, 'premium' | 'standard' | 'usage_based' | 'other'> = {
  team_tier_1: 'premium',
  team_bendep_nonprofit_premium: 'premium',
  team_labs_premium: 'premium',
  enterprise_tier_1: 'premium',
  enterprise_bendep_premium: 'premium',
  team_standard: 'standard',
  team_bendep_nonprofit_standard: 'standard',
  team_labs_standard: 'standard',
  enterprise_standard: 'standard',
  enterprise_nonprofit: 'standard',
  enterprise_higher_ed: 'standard',
  enterprise_usage_based: 'usage_based',
  enterprise_usage_based_chat: 'usage_based',
  enterprise_hipaa_chat: 'usage_based',
  enterprise_hipaa_chat_and_code: 'usage_based',
  enterprise_lite: 'other',
  enterprise_bendep_global_access: 'other',
};

function resolveClaudeSeatKind(seatTier: unknown): 'premium' | 'standard' | 'usage_based' | 'other' | undefined {
  if (typeof seatTier !== 'string') return undefined;
  const seat = seatTier.trim().toLowerCase();
  if (!seat) return undefined;
  if (Object.hasOwn(CLAUDE_SEAT_TIER_KIND, seat)) return CLAUDE_SEAT_TIER_KIND[seat];
  if (seat.includes('premium')) return 'premium';
  if (seat.includes('standard')) return 'standard';
  if (seat.includes('usage_based')) return 'usage_based';
  return undefined;
}

export function formatClaudeSubscriptionTier(
  subscriptionType: unknown,
  rateLimitTier?: unknown,
  seatTier?: unknown,
): string | undefined {
  const rawSub = typeof subscriptionType === 'string' ? subscriptionType.trim().toLowerCase() : '';
  const sub = Object.hasOwn(CLAUDE_ORG_TYPE_TO_SUB, rawSub) ? CLAUDE_ORG_TYPE_TO_SUB[rawSub] : rawSub;
  const tier = typeof rateLimitTier === 'string' ? rateLimitTier.trim().toLowerCase() : '';
  const seatKind = resolveClaudeSeatKind(seatTier);
  const multMatch = tier.match(/(?:^|_)(\d+x)(?:$|_)/);
  const mult = multMatch ? multMatch[1] : '';
  if (sub === 'max') return mult ? `Max ${mult}` : 'Max';
  if (sub === 'pro') return mult ? `Pro ${mult}` : 'Pro';
  if (sub === 'team') {
    if (seatKind === 'premium') return 'Team Premium';
    if (seatKind === 'standard') return 'Team Standard';
    if (tier === 'default_claude_max_5x') return 'Team Premium';
    return mult ? `Team ${mult}` : 'Team';
  }
  if (sub === 'enterprise') {
    if (seatKind === 'premium') return 'Enterprise Premium';
    if (seatKind === 'standard') return 'Enterprise Standard';
    return mult ? `Enterprise ${mult}` : 'Enterprise';
  }
  if (sub === 'free') return 'Free';
  if (!sub) {
    if (tier.includes('max') && mult) return `Max ${mult}`;
    if (tier.includes('max')) return 'Max';
    if (tier.includes('pro')) return 'Pro';
    return undefined;
  }
  const label = sub.split(/[_-]+/).filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
  return mult ? `${label} ${mult}` : label;
}
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
function oauthAccountMeta(id: string): AnyRecord | null {
  const candidates = id === 'legacy'
    ? [path.join(home(id), '.claude.json'), path.join(os.homedir(), '.claude.json')]
    : [path.join(home(id), '.claude.json')];
  for (const filePath of candidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as AnyRecord;
      if (parsed?.oauthAccount && typeof parsed.oauthAccount === 'object') return parsed.oauthAccount as AnyRecord;
    } catch { /* optional profile metadata */ }
  }
  return null;
}
const busy = new Map<string, number>();
const quotas = new Map<string, AnyRecord>();
const logins = new Map<string, { process: pty.IPty; url?: string; status: string; timer: ReturnType<typeof setTimeout> }>();
const quotaJobs = new Map<string, Promise<AnyRecord>>();
const identityJobs = new Map<string, Promise<void>>();
const identityRetryAt = new Map<string, number>();
const IDENTITY_RETRY_MS = 120_000;
const nativeBinary = () => process.env.CLAUDE_CLI_PATH || resolveManagedCli('claude') || path.join(path.dirname(createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk-linux-x64/package.json')), 'claude');
function ensureProfile(id: string) {
  const target = home(id);
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(legacyHome(), 'projects'), { recursive: true, mode: 0o700 });
  if (id !== 'legacy' && !fs.existsSync(path.join(target, 'projects'))) fs.symlinkSync(path.join(legacyHome(), 'projects'), path.join(target, 'projects'), 'dir');
}
function publicAccount(account: Account) {
  const cred = credentials(account.id);
  const oauth = cred?.claudeAiOauth && typeof cred.claudeAiOauth === 'object' ? cred.claudeAiOauth as AnyRecord : undefined;
  const meta = oauthAccountMeta(account.id);
  const subType = oauth?.subscriptionType ?? account.subscriptionType;
  const rateLimitTier = oauth?.rateLimitTier ?? account.rateLimitTier;
  const seatTier = oauth?.seatTier ?? meta?.seatTier ?? account.seatTier;
  const subscriptionTier = formatClaudeSubscriptionTier(subType, rateLimitTier, seatTier);
  return { ...account, provider: 'claude', kind: 'claude', authorized: Boolean(oauth?.accessToken), subscriptionTier };
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
  return { ...egressEnvironment('claude', env), CLAUDE_CONFIG_DIR: home(id), BROWSER: '/bin/true' };
}
async function fetchOAuthProfile(accessToken: string): Promise<{
  email?: string;
  subscriptionType?: string;
  rateLimitTier?: string;
  seatTier?: string;
} | null> {
  if (!accessToken || process.env.NODE_ENV === 'test' || process.env.CLAUDE_DISABLE_PROFILE_FETCH === '1') return null;
  try {
    const response = await egressFetch('claude')('https://api.anthropic.com/api/oauth/profile', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;
    const data = await response.json() as AnyRecord;
    const org = data?.organization && typeof data.organization === 'object' ? data.organization as AnyRecord : undefined;
    const acct = data?.account && typeof data.account === 'object' ? data.account as AnyRecord : undefined;
    const orgType = typeof org?.organization_type === 'string' ? org.organization_type.trim().toLowerCase() : '';
    const subscriptionType = orgType && Object.hasOwn(CLAUDE_ORG_TYPE_TO_SUB, orgType) ? CLAUDE_ORG_TYPE_TO_SUB[orgType] : undefined;
    return {
      email: typeof acct?.email_address === 'string' && acct.email_address ? acct.email_address : undefined,
      subscriptionType,
      rateLimitTier: typeof org?.rate_limit_tier === 'string' && org.rate_limit_tier ? org.rate_limit_tier : undefined,
      seatTier: typeof org?.seat_tier === 'string' && org.seat_tier ? org.seat_tier : undefined,
    };
  } catch {
    return null;
  }
}
async function refreshIdentity(id: string) {
  const existing = identityJobs.get(id);
  if (existing) return existing;
  const job = (async () => {
    let email: string | undefined;
    let subscriptionType: string | undefined;
    let rateLimitTier: string | undefined;
    let seatTier: string | undefined;

    const cred = credentials(id);
    const accessToken = typeof cred?.claudeAiOauth?.accessToken === 'string' ? cred.claudeAiOauth.accessToken : '';
    if (accessToken) {
      const profile = await fetchOAuthProfile(accessToken);
      if (profile) {
        email = profile.email;
        subscriptionType = profile.subscriptionType;
        rateLimitTier = profile.rateLimitTier;
        seatTier = profile.seatTier;
      }
    }

    await new Promise<void>(done => execFile(nativeBinary(), ['auth', 'status'], { env: accountEnv(id), timeout: 15000, maxBuffer: 65536 }, (_error, stdout) => {
      try {
        const status = JSON.parse(stdout);
        if (!email && typeof status.email === 'string' && status.email) email = status.email;
        if (!subscriptionType && typeof status.subscriptionType === 'string' && status.subscriptionType) subscriptionType = status.subscriptionType;
        if (!rateLimitTier && typeof status.rateLimitTier === 'string' && status.rateLimitTier) rateLimitTier = status.rateLimitTier;
        if (!seatTier && typeof status.seatTier === 'string' && status.seatTier) seatTier = status.seatTier;
      } catch { /* Missing identity is distinct from successful native authorization. */ }
      done();
    }));

    const meta = oauthAccountMeta(id);
    if (!seatTier && typeof meta?.seatTier === 'string' && meta.seatTier) seatTier = meta.seatTier;

    try {
      const store = read();
      const item = store.accounts.find(value => value.id === id);
      if (item) {
        let changed = false;
        if (email && email !== item.email) { item.email = email; changed = true; }
        if (subscriptionType && subscriptionType !== item.subscriptionType) { item.subscriptionType = subscriptionType; changed = true; }
        if (rateLimitTier && rateLimitTier !== item.rateLimitTier) { item.rateLimitTier = rateLimitTier; changed = true; }
        if (seatTier && seatTier !== item.seatTier) { item.seatTier = seatTier; changed = true; }
        if (changed) write(store);
      }
    } catch { /* Ignore store write failures during background refresh. */ }
    identityRetryAt.set(id, Date.now() + IDENTITY_RETRY_MS);
  })().finally(() => { identityJobs.delete(id); });
  identityJobs.set(id, job);
  return job;
}
function scheduleIdentityRefreshIfNeeded(accounts: Account[]) {
  if (process.env.NODE_ENV === 'test' || process.env.CLAUDE_DISABLE_PROFILE_FETCH === '1') return;
  const now = Date.now();
  for (const account of accounts) {
    if (identityJobs.has(account.id)) continue;
    if ((identityRetryAt.get(account.id) || 0) > now) continue;
    const cred = credentials(account.id);
    const oauth = cred?.claudeAiOauth && typeof cred.claudeAiOauth === 'object' ? cred.claudeAiOauth as AnyRecord : undefined;
    if (!oauth?.accessToken) continue;
    const meta = oauthAccountMeta(account.id);
    const sub = String(oauth.subscriptionType ?? account.subscriptionType ?? '').trim().toLowerCase();
    const rate = oauth.rateLimitTier ?? account.rateLimitTier;
    const seat = oauth.seatTier ?? meta?.seatTier ?? account.seatTier;
    const needsSeat = (sub === 'team' || sub === 'enterprise') && !seat;
    const needsTier = !sub || ((sub === 'max' || sub === 'team') && !rate);
    if (needsSeat || needsTier) void refreshIdentity(account.id);
  }
}

/** Native account profiles share transcripts, while authorization stays isolated per selected account. */
export const claudeAccounts = {
  list() {
    const store = read();
    scheduleIdentityRefreshIfNeeded(store.accounts);
    return { activeId: store.activeId, accounts: store.accounts.map(publicAccount) };
  },
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
    let updatedCredentials: AnyRecord | null = null;
    if (input.credentials) {
      let value: AnyRecord;
      try { value = typeof input.credentials === 'string' ? JSON.parse(input.credentials) : input.credentials; } catch { throw fail('请提供原生 Claude .credentials.json 文件内容'); }
      if (typeof value?.claudeAiOauth?.accessToken !== 'string' || !value.claudeAiOauth.accessToken) throw fail('没有找到 Claude 官方登录凭据');
      fs.writeFileSync(path.join(home(id), '.credentials.json'), JSON.stringify(value), { mode: 0o600 });
      quotas.delete(id);
      updatedCredentials = value;
    }
    const account: Account = updatedCredentials
      ? { id, name }
      : { ...previous, id, name };
    if (previous) store.accounts = store.accounts.map(item => item.id === id ? account : item); else store.accounts.push(account);
    write(store);
    if (updatedCredentials) {
      const oauth = updatedCredentials.claudeAiOauth as AnyRecord;
      const sub = String(oauth?.subscriptionType || '').trim().toLowerCase();
      if (!sub || !oauth?.rateLimitTier || ((sub === 'team' || sub === 'enterprise') && !oauth?.seatTier)) {
        void refreshIdentity(id);
      }
    }
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
