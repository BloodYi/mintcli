import fs from 'node:fs';
import { readOfficialCatalog } from './catalog.service.js';
import type { ProviderModelsDefinition } from '@/shared/types.js';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { lookup } from 'node:dns/promises';

import { AppError } from '@/shared/index.js';
import { readAccountQuota } from './quota.service.js';

type Connection = {
  id: string; name: string; kind: 'chatgpt' | 'api'; home: string;
  baseUrl?: string; apiKey?: string; model?: string;
  protocol?: 'responses' | 'chat_completions';
};
type Store = { activeId: string; connections: Connection[] };
type Login = { status: string; url?: string; code?: string; process?: ChildProcess };
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
    return { status: login?.status || 'idle', url: login?.url, code: login?.code, authorized: !login?.process && publicConnection(item).authorized };
  },
  startLogin(id: string) {
    const item = connection(id);
    if (item.kind !== 'chatgpt') failure('仅 ChatGPT 账号需要设备授权');
    if (logins.get(id)?.process) return this.loginStatus(id);
    const child = spawn('codex', ['login', '--device-auth'], { env: environment(item.home), stdio: ['ignore', 'pipe', 'pipe'] });
    const login: Login = { status: 'starting', process: child };
    logins.set(id, login);
    let output = '';
    const consume = (chunk: Buffer) => {
      output = (output + chunk.toString()).replace(/\x1b\[[0-9;]*m/g, '').slice(-16000);
      login.url = output.match(/https:\/\/(?:auth\.openai\.com|chatgpt\.com)\/(?:codex\/device|auth\/device|device)\b/)?.[0];
      login.code = output.match(/\b[A-Z0-9]{3,8}-[A-Z0-9]{3,8}(?:-[A-Z0-9]{3,8})?\b/)?.[0];
      if (login.url && login.code) login.status = 'pending';
    };
    child.stdout?.on('data', consume); child.stderr?.on('data', consume);
    child.on('error', () => { login.status = 'error'; login.process = undefined; });
    child.on('close', code => { login.status = code === 0 && publicConnection(item).authorized ? 'logged_in' : 'error'; login.process = undefined; });
    const timeout = setTimeout(() => child.kill(), 15 * 60000); timeout.unref();
    child.on('close', () => clearTimeout(timeout));
    return this.loginStatus(id);
  },
  cancelLogin(id: string) {
    const login = logins.get(id); login?.process?.kill(); logins.delete(id);
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
