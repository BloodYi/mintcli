import fs from 'node:fs';
import { readOfficialCatalog } from './catalog.service.js';
import type { ProviderModelsDefinition } from '@/shared/types.js';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import type { ChildProcess } from 'node:child_process';
import { lookup } from 'node:dns/promises';

import { AppError, resolveManagedCli, stripAnsiSequences } from '@/shared/index.js';
import { readAccountQuota } from './quota.service.js';

type Connection = {
  id: string; name: string; kind: 'chatgpt' | 'api'; home: string;
  baseUrl?: string; apiKey?: string; model?: string;
  protocol?: 'responses' | 'chat_completions';
};
type Store = { activeId: string; connections: Connection[] };
type Login = { status: string; method: 'browser' | 'device'; url?: string; code?: string; state?: string; redirectUri?: string; expiresAt: number; process?: ChildProcess };
const BROWSER_LOGIN_PORT = 1455;
const logins = new Map<string, Login>();
const root = () => process.env.CODEX_CONNECTIONS_ROOT || path.join(os.homedir(), 'connections');
const storePath = () => path.join(root(), 'store.json');

function failure(message: string, statusCode = 400): never {
  throw new AppError(message, { code: 'CODEX_CONNECTION_ERROR', statusCode });
}

function readStore(): Store {
  if (!fs.existsSync(storePath())) return { activeId: '', connections: [] };
  // Do not replace a corrupt store: credential and account loss must be visible.
  return JSON.parse(fs.readFileSync(storePath(), 'utf8')) as Store;
}

function writeStore(store: Store): void {
  fs.mkdirSync(root(), { recursive: true, mode: 0o700 });
  const temp = storePath() + '.' + randomUUID() + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(store), { mode: 0o600, flag: 'wx' });
  fs.renameSync(temp, storePath());
}

function connection(id?: unknown): Connection {
  const store = readStore();
  const result = store.connections.find(item => item.id === (id || store.activeId));
  if (!result) failure('请先添加并选择 Codex 账号或第三方 API', 404);
  return result;
}

function publicConnection(item: Connection) {
  let email = '';
  try { const auth = JSON.parse(fs.readFileSync(path.join(item.home, 'auth.json'), 'utf8')); const payload = JSON.parse(Buffer.from(auth.tokens?.id_token?.split('.')[1] || '', 'base64url').toString('utf8')); email = typeof payload.email === 'string' ? payload.email : ''; } catch { /* API connections have no ChatGPT identity. */ }
  let authorized = Boolean(item.apiKey);
  if (item.kind === 'chatgpt') {
    try { authorized = Boolean(JSON.parse(fs.readFileSync(path.join(item.home, 'auth.json'), 'utf8')).tokens); }
    catch { authorized = false; }
  }
  return { id: item.id, name: item.name, kind: item.kind, baseUrl: item.baseUrl || '',
    protocol: item.protocol || 'responses', model: item.model || '', authorized, email, hasApiKey: Boolean(item.apiKey) };
}

function environment(home: string): Record<string, string> {
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  // A process gets a credential home of its own. Switching accounts never
  // overwrites another running turn's credentials or the server environment.
  env.CODEX_HOME = home;
  for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL']) delete env[key];
  return env;
}

function inputString(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length > max || value.includes('\0')) failure('配置格式不正确');
  return value.trim();
}

function normalizedUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { return failure('请填写有效的 HTTPS API 地址'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) failure('API 地址必须为 HTTPS，且不能包含密码或查询参数');
  if (!url.pathname || url.pathname === '/') url.pathname = '/v1';
  url.pathname = url.pathname.replace(/\/(chat\/completions|responses)\/?$/, '').replace(/\/$/, '');
  return url.toString().replace(/\/$/, '');
}

/** Used by the connections routes and compatibility runtime to reject private API targets. */
export async function validateConnectionEndpoint(baseUrl: string): Promise<void> {
  const url = new URL(baseUrl);
  const addresses = await lookup(url.hostname.replace(/^\[|\]$/g, ''), { all: true });
  if (!addresses.length || addresses.some(({ address }) => {
    if (address.includes(':')) return !/^2[0-9a-f]{3}:/i.test(address) && !/^3[0-9a-f]{3}:/i.test(address);
    const [a, b] = address.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a === 100 && b >= 64 && b <= 127;
  })) failure('API 地址必须指向公网服务');
}

/** Used by Codex runtime to capture one immutable connection before a turn starts. */
export function resolveCodexConnection(id?: unknown) {
  if (!fs.existsSync(storePath())) {
    const home = path.join(os.homedir(), '.codex');
    return { id: 'default', name: 'Codex', kind: 'chatgpt' as const, home, env: environment(home), baseUrl: undefined, apiKey: undefined, protocol: undefined, model: undefined };
  }
  const item = connection(id);
  return { ...item, env: environment(item.home) };
}

/** Used by the authenticated connections router for account and API workflows. */
export const connectionService = {
  list() {
    const store = readStore();
    return { activeId: store.activeId, connections: store.connections.map(publicConnection) };
  },
  async save(body: Record<string, unknown>) {
    let store = readStore();
    const id = typeof body.id === 'string' ? body.id : randomUUID();
    const previous = store.connections.find(item => item.id === id);
    if (body.id && !previous) failure('连接不存在', 404);
    const name = inputString(body.name, 80);
    if (!name) failure('请填写连接名称');
    const kind = previous?.kind || body.kind;
    if (kind !== 'chatgpt' && kind !== 'api') failure('连接类型不正确');
    const home = previous?.home || path.join(root(), 'accounts', id);
    const next: Connection = { id, name, kind, home };
    if (kind === 'api') {
      next.baseUrl = normalizedUrl(inputString(body.baseUrl, 1000));
      await validateConnectionEndpoint(next.baseUrl);
      next.model = inputString(body.model ?? '', 160);
      next.apiKey = body.apiKey ? inputString(body.apiKey, 4000) : previous?.apiKey;
      if (!next.apiKey) failure('请填写 API Key');
      next.protocol = body.protocol === 'chat_completions' ? 'chat_completions' : 'responses';
    }
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    // All credentials are separate while native transcripts and SQLite thread
    // indices stay shared, so the same conversation can resume across accounts.
    const sharedHome = path.join(os.homedir(), '.codex');
    for (const entry of ['sessions', 'archived_sessions']) {
      const target = path.join(sharedHome, entry);
      fs.mkdirSync(target, { recursive: true, mode: 0o700 });
      if (!fs.existsSync(path.join(home, entry))) fs.symlinkSync(target, path.join(home, entry));
    }
    for (const entry of fs.readdirSync(sharedHome).filter(name => /^state_.*\.sqlite$/.test(name))) {
      if (!fs.existsSync(path.join(home, entry))) fs.symlinkSync(path.join(sharedHome, entry), path.join(home, entry));
    }
    // DNS validation above yields: merge with the latest store so two devices
    // adding different connections cannot overwrite one another's additions.
    store = readStore();
    const index = store.connections.findIndex(item => item.id === id);
    if (index >= 0) store.connections[index] = next; else store.connections.push(next);
    if (!store.activeId) store.activeId = id;
    writeStore(store);
    return publicConnection(next);
  },
  select(id: string) {
    connection(id);
    const store = readStore(); store.activeId = id; writeStore(store);
    return this.list();
  },
  remove(id: string) {
    connection(id);
    const login = logins.get(id); login?.process?.kill(); logins.delete(id);
    const store = readStore(); store.connections = store.connections.filter(item => item.id !== id);
    if (store.activeId === id) store.activeId = store.connections[0]?.id || '';
    writeStore(store);
    // Keep private credential files for recovery; removing a connection never
    // deletes shared chat history or credentials in use by another process.
    return this.list();
  },
  loginStatus(id: string) {
    const item = connection(id), login = logins.get(id);
    return { status: login?.status || 'idle', method: login?.method, url: login?.url, code: login?.code,
      acceptsCode: login?.method === 'browser' && login.status === 'pending', expiresAt: login?.expiresAt,
      authorized: login ? login.status === 'authorized' : publicConnection(item).authorized };
  },
  async startLogin(id: string, method: 'browser' | 'device' = 'browser') {
    const item = connection(id);
    if (item.kind !== 'chatgpt') failure('仅 ChatGPT 账号需要官方授权');
    if (['starting', 'pending', 'completing'].includes(logins.get(id)?.status || '')) return this.loginStatus(id);
    if (method === 'browser' && [...logins.values()].some(login => login.method === 'browser' && ['starting', 'pending', 'completing'].includes(login.status))) {
      failure('已有一个 Codex 浏览器授权正在进行，请完成或取消后再添加其他账号', 409);
    }
    const login: Login = { status: 'starting', method, expiresAt: Date.now() + 15 * 60000 };
    logins.set(id, login);
    if (method === 'browser') {
      // The native CLI cancels an existing login listener when its port is occupied.
      // Check without sending requests so this workbench cannot cancel another project's authorization.
      try {
        await new Promise<void>((resolve, reject) => {
          const probe = createServer();
          probe.once('error', () => reject(new AppError('本机已有其他浏览器授权使用回调端口，请完成后重试，或改用设备验证码登录', { code: 'CODEX_CALLBACK_BUSY', statusCode: 409 })));
          probe.listen(BROWSER_LOGIN_PORT, '127.0.0.1', () => probe.close(() => resolve()));
        });
      } catch (error) { login.status = 'error'; throw error; }
    }
    if (login.status === 'cancelled') return this.loginStatus(id);
    const child = spawn(resolveManagedCli('codex') || 'codex', ['login', ...(method === 'device' ? ['--device-auth'] : []), '-c', 'cli_auth_credentials_store="file"'], {
      env: { ...environment(item.home), BROWSER: '/bin/true' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    login.process = child;
    let output = '';
    const consume = (chunk: Buffer) => {
      output = stripAnsiSequences(output + chunk.toString()).slice(-24000);
      for (const match of output.matchAll(/https:\/\/[^\s<>\x00-\x1f]+/g)) {
        try {
          const url = new URL(match[0]);
          if (!['auth.openai.com', 'chatgpt.com'].includes(url.hostname)) continue;
          if (method === 'browser' && /\/oauth\/authorize$/.test(url.pathname)) {
            const redirect = new URL(url.searchParams.get('redirect_uri') || '');
            if (redirect.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(redirect.hostname) || redirect.port !== String(BROWSER_LOGIN_PORT) || redirect.pathname !== '/auth/callback') continue;
            login.url = url.href; login.state = url.searchParams.get('state') || undefined; login.redirectUri = redirect.href;
          } else if (method === 'device' && /\/(?:codex\/device|auth\/device|device)$/.test(url.pathname)) login.url = url.href;
        } catch { /* Ignore wrapped or incomplete terminal URLs. */ }
      }
      if (method === 'device') login.code = output.match(/\b[A-Z0-9]{3,8}-[A-Z0-9]{3,8}(?:-[A-Z0-9]{3,8})?\b/)?.[0];
      if (login.url && (method === 'browser' ? login.state : login.code)) login.status = 'pending';
    };
    child.stdout?.on('data', consume); child.stderr?.on('data', consume);
    child.on('error', () => { login.status = 'error'; login.process = undefined; });
    child.on('close', code => {
      if (!['cancelled', 'expired'].includes(login.status)) login.status = code === 0 && publicConnection(item).authorized ? 'authorized' : 'error';
      login.process = undefined;
    });
    const timeout = setTimeout(() => { login.status = 'expired'; child.kill(); }, 15 * 60000); timeout.unref();
    child.on('close', () => clearTimeout(timeout));
    return this.loginStatus(id);
  },
  async submitLoginCode(id: string, value: unknown) {
    connection(id);
    const login = logins.get(id);
    if (!login?.process || login.method !== 'browser' || login.status !== 'pending' || !login.state || !login.redirectUri || login.expiresAt < Date.now()) failure('授权已结束或过期，请重新打开官方授权');
    if (typeof value !== 'string' || !value.trim() || value.length > 8192 || /[\x00-\x20\x7f]/.test(value.trim())) failure('请粘贴官方授权返回的完整地址或授权码');
    const text = value.trim();
    const callback = new URL(login.redirectUri);
    let code = text;
    if (/^https?:/i.test(text)) {
      let received: URL;
      try { received = new URL(text); } catch { return failure('回调地址格式不正确'); }
      if (received.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(received.hostname) || received.port !== String(BROWSER_LOGIN_PORT) || received.pathname !== '/auth/callback' || received.username || received.password || received.hash || received.searchParams.get('state') !== login.state) failure('回调地址与本次授权不匹配，请重新打开当前授权链接');
      code = received.searchParams.get('code') || '';
    }
    if (!code || code.length > 4096 || /[\s\x00-\x1f]/.test(code)) failure('回调中没有找到有效的授权码');
    callback.hostname = '127.0.0.1'; callback.searchParams.set('code', code); callback.searchParams.set('state', login.state);
    // The destination comes only from the CLI's fixed loopback callback, never from pasted input.
    login.status = 'completing';
    try {
      const response = await fetch(callback, { redirect: 'manual', signal: AbortSignal.timeout(30000) });
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (response.status >= 400) failure('官方授权码未通过验证，请检查是否使用了本次授权返回的地址');
      if (response.status >= 300 && response.status < 400 && location) {
        const target = new URL(location, callback);
        if (target.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(target.hostname) && target.port === String(BROWSER_LOGIN_PORT) && target.pathname === '/success' && !target.username && !target.password) {
          // Codex waits for its local success page before exiting. The redirect query
          // can contain credentials: request only the fixed path, never expose or forward it.
          const success = await fetch(`http://127.0.0.1:${BROWSER_LOGIN_PORT}/success`, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
          await success.body?.cancel();
          if (success.status >= 400) failure('CLI 尚未确认授权完成，请检查登录状态');
        }
      }
    } catch (error) {
      if (login.process && login.status === 'completing') login.status = 'pending';
      if (error instanceof AppError) throw error;
      failure('CLI 暂时未能完成授权，请稍后检查登录状态或重新授权');
    }
    return this.loginStatus(id);
  },
  cancelLogin(id: string) {
    connection(id);
    const login = logins.get(id); if (login) { login.status = 'cancelled'; login.process?.kill(); }
    return { status: 'cancelled' };
  },
  async quota(id: string) {
    const item = connection(id);
    if (item.kind === 'api') return { connectionId: id, status: 'unavailable', windows: [],
      reason: '第三方 API 未提供通用余额接口；请以服务商后台为准。' };
    return { connectionId: id, ...await readAccountQuota(environment(item.home)) };
  },
  async models(id: string) {
    const item = connection(id);
    if (item.kind === 'chatgpt') {
      const catalog = await getCodexModelCatalog(id);
      return { models: catalog.OPTIONS.map(option => option.value), catalog };
    }
    await validateConnectionEndpoint(item.baseUrl!);
    const response = await fetch(item.baseUrl + '/models', { headers: { Authorization: 'Bearer ' + item.apiKey }, redirect: 'error', signal: AbortSignal.timeout(20000) });
    if (!response.ok) failure(`模型接口返回 HTTP ${response.status}，请检查地址和密钥；也可手动填写模型名`);
    const data = await response.json() as { data?: { id?: unknown }[] };
    const models = (data.data || []).map(row => row.id).filter((id): id is string => typeof id === 'string' && id.length <= 160).slice(0, 2000);
    return { models };
  },
};

/** Used by native Codex model/auth adapters and the connections route to resolve one selected credential catalog. */
export async function getCodexModelCatalog(id?: unknown): Promise<ProviderModelsDefinition> {
  const item = resolveCodexConnection(id);
  if (item.kind === 'chatgpt') return readOfficialCatalog(item.home, item.env);
  let ids: string[] = [];
  try { ids = (await connectionService.models(item.id)).models; } catch { /* A configured model remains usable when discovery is unsupported. */ }
  if (item.model && !ids.includes(item.model)) ids.unshift(item.model);
  return { ACCOUNT_SCOPED: true, OPTIONS: ids.map(value => ({ value, label: value })), DEFAULT: item.model || ids[0] || '' };
}
