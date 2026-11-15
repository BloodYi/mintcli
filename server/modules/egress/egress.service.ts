import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Agent, ProxyAgent } from 'undici';
import type { Dispatcher } from 'undici';
import { AppError } from '@/shared/index.js';

type Node = { id: string; name: string; port: number };
type Inventory = { updatedAt: string | null; nodes: Node[]; source?: string };
type Selection = { selections: Record<string, string> };
const runFile = promisify(execFile);
const direct = new Agent();
const agents = new Map<number, ProxyAgent>();
const root = () => process.env.MINTCLI_EGRESS_ROOT || '/var/lib/cloudcli/egress';
const fail = (message: string, statusCode = 400) => new AppError(message, { code: 'EGRESS_ERROR', statusCode });
function read<T>(file: string, fallback: T): T {
  try { return JSON.parse(fs.readFileSync(path.join(root(), file), 'utf8')) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback; throw fail('节点配置读取失败，请检查配置文件', 503); }
}
function inventory(): Inventory { return read('inventory.json', { updatedAt: null, nodes: [] }); }
function selection(): Selection { return read('selection.json', { selections: {} }); }
function nodeFor(target: string) {
  const id = selection().selections[target] || 'legacy';
  if (id === 'direct') return { id, name: '本机直连', port: 0 };
  if (id === 'legacy') return { id, name: '诺联狗根', port: 17890 };
  const node = inventory().nodes.find(value => value.id === id);
  if (!node) throw fail('所选节点已不可用，请重新选择；请求未改走其他出口', 503);
  return node;
}
function dispatcher(port: number): Dispatcher {
  if (!port) return direct;
  if (!agents.has(port)) agents.set(port, new ProxyAgent(`http://127.0.0.1:${port}`));
  return agents.get(port)!;
}
function proxyEnvironment(port: number, source: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) if (value !== undefined && !/^(?:(?:http|https|all|ws|wss|no)_proxy|node_use_env_proxy)$/i.test(key)) env[key] = value;
  if (port) {
    for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'WS_PROXY', 'WSS_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'ws_proxy', 'wss_proxy']) env[key] = `http://127.0.0.1:${port}`;
    env.NODE_USE_ENV_PROXY = '1';
  } else env.NODE_USE_ENV_PROXY = '0';
  env.MINTCLI_SELECTED_EGRESS_PORT = String(port);
  env.NO_PROXY = env.no_proxy = 'localhost,127.0.0.1,::1';
  return env;
}

/** Used by CLI account, auth and runtime modules to bind one run without changing process.env. The returned environment pins its relay port too. */
export function egressEnvironment(target: string, source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  // Preserve the installed environment on hosts where routing has not been configured.
  if (!fs.existsSync(path.join(root(), 'inventory.json')) && !fs.existsSync(path.join(root(), 'selection.json'))) return Object.fromEntries(Object.entries(source).filter((entry): entry is [string, string] => entry[1] !== undefined));
  return proxyEnvironment(nodeFor(target).port, source);
}

/** Used by Codex HTTP relays, catalog and compatible APIs; captures a dispatcher for one request/run, optionally from the CLI environment snapshot. */
export function egressFetch(target: string, environment?: Record<string, string>): typeof globalThis.fetch {
  if (!fs.existsSync(path.join(root(), 'inventory.json')) && !fs.existsSync(path.join(root(), 'selection.json'))) return globalThis.fetch;
  // A CLI's captured environment also pins the relay across asynchronous model discovery.
  const capturedPort = environment?.MINTCLI_SELECTED_EGRESS_PORT;
  const selectedDispatcher = dispatcher(capturedPort !== undefined ? Number(capturedPort) : nodeFor(target).port);
  return (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    return globalThis.fetch(input, { ...init, dispatcher: local ? direct : selectedDispatcher } as RequestInit);
  };
}

/** Used by authenticated egress routes to validate targets without accepting arbitrary proxy addresses. */
export function validEgressTarget(value: unknown): value is string {
  return typeof value === 'string' && /^(?:codex|claude|cursor|opencode|antigravity|api:[a-zA-Z0-9_-]{1,120})$/.test(value);
}

function recordProbe(nodeId: string, value: unknown) {
  // Diagnostic persistence is best effort and must never change a measured result.
  try {
    const previous = read<Record<string, unknown>>('probes.json', {}); previous[nodeId] = value;
    fs.mkdirSync(root(), { recursive: true, mode: 0o700 });
    const temp = path.join(root(), randomUUID() + '.tmp');
    fs.writeFileSync(temp, JSON.stringify(previous), { mode: 0o600 });
    fs.renameSync(temp, path.join(root(), 'probes.json'));
  } catch { /* The on-demand result remains usable when the diagnostics file is unavailable. */ }
}

let syncing: Promise<unknown> | null = null;
/** Used by egress routes for persisted routing, subscription refresh and bounded diagnostics. */
export const egressService = {
  status() {
    const data = inventory();
    return { updatedAt: data.updatedAt, source: data.source, configured: fs.existsSync(path.join(root(), 'inventory.json')), nodes: [{ id: 'legacy', name: '诺联狗根', port: 17890 }, { id: 'direct', name: '本机直连', port: 0 }, ...data.nodes], selections: selection().selections, probes: read<Record<string, unknown>>('probes.json', {}) };
  },
  save(target: string, nodeId: string) {
    if (!validEgressTarget(target)) throw fail('不支持的 CLI 或 API');
    if (!this.status().nodes.some(node => node.id === nodeId)) throw fail('节点不存在，请刷新节点列表');
    const state = selection(); state.selections[target] = nodeId;
    fs.mkdirSync(root(), { recursive: true, mode: 0o700 });
    const temp = path.join(root(), randomUUID() + '.tmp');
    fs.writeFileSync(temp, JSON.stringify(state), { mode: 0o600, flag: 'wx' });
    fs.renameSync(temp, path.join(root(), 'selection.json'));
    return this.status();
  },
  async probe(nodeId: string) {
    const node = this.status().nodes.find(value => value.id === nodeId);
    if (!node) throw fail('节点不存在');
    const started = Date.now();
    try {
      const response = await globalThis.fetch('https://www.cloudflare.com/cdn-cgi/trace', {
        dispatcher: dispatcher(node.port), signal: AbortSignal.timeout(12000), redirect: 'error',
      } as RequestInit);
      if (!response.ok) throw new Error();
      const result = (await response.text()).slice(0, 8192);
      const ip = result.match(/^ip=([a-fA-F0-9.:]+)$/m)?.[1];
      if (!ip) throw new Error();
      const value = { nodeId, ok: true, ip, country: result.match(/^loc=([A-Z]{2})$/m)?.[1], latencyMs: Date.now() - started, checkedAt: Date.now() };
      recordProbe(nodeId, value); return value;
    } catch { const value = { nodeId, ok: false, error: '连接失败或超时；未回退到其他出口', checkedAt: Date.now() }; recordProbe(nodeId, value); return value; }
  },
  async sync() {
    if (!syncing) syncing = runFile('/usr/local/libexec/mintcli-egress-sync', [], { timeout: 90000, maxBuffer: 65536 })
      .catch(() => { throw fail('本地节点刷新失败，已保留现有配置；请检查订阅链接或代理内核', 502); })
      .finally(() => { syncing = null; });
    await syncing; return this.status();
  },
};
