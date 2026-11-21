import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getGlobalImageAssetsDir } from '@/shared/image-attachments.js';
import { resolveManagedCli } from '@/shared/index.js';
import { probeCliVersion } from '@/shared/utils.js';
import { antigravityBridge } from '@/modules/antigravity/index.js';
import { sessionsDb } from '@/modules/database/index.js';
import { connectionService, validateConnectionEndpoint, startApiRelay } from '@/modules/codex-connections/index.js';
import type { IProvider, IProviderRuntime } from '@/shared/interfaces.js';
import type { AnyRecord, CliVersionProbe, FetchHistoryOptions, NormalizedMessage, ProviderAuthStatus } from '@/shared/types.js';
import { AppError, createNormalizedMessage, createCompleteMessage, sliceTailPage } from '@/shared/utils.js';

const provider = 'antigravity';
const endpoint = (id: string) => '/api/conversations/' + encodeURIComponent(id) + '/messages';
async function json(response: Response): Promise<AnyRecord> {
  if (!response.ok) { const body = await response.json().catch(() => ({})) as AnyRecord; throw new AppError(body.detail || 'agy 操作失败，请刷新后重试', { code: 'AGY_NATIVE_ERROR', statusCode: response.status }); }
  return response.json() as Promise<AnyRecord>;
}
/** Same normalization for live native snapshots and old transcripts. Stable ids prevent duplicate rows. */
export function normalizeAgy(message: AnyRecord, sessionId: string | null): NormalizedMessage[] {
  if (!['user', 'assistant'].includes(message.role)) return [];
  const base = { sessionId, provider, timestamp: typeof message.timestamp === 'string' ? message.timestamp : new Date().toISOString() } as const;
  const id = String(message.id || randomUUID());
  const result: NormalizedMessage[] = [];
  if (message.thinking) result.push(createNormalizedMessage({ ...base, id: id + ':thinking', kind: 'thinking', content: String(message.thinking) }));
  if (message.content || message.attachments?.length) result.push(createNormalizedMessage({ ...base, id, kind: 'text', role: message.role, content: String(message.content || ''), images: message.attachments?.filter((item: AnyRecord) => item.mimeType?.startsWith('image/')), files: message.attachments?.filter((item: AnyRecord) => !item.mimeType?.startsWith('image/')) }));
  if (message.errorText) result.push(createNormalizedMessage({ ...base, id: id + ':error', kind: 'error', content: String(message.errorText) }));
  return result;
}
const running = new Map<string, { turnId: string; controller: AbortController }>();
const runtime: IProviderRuntime = {
  async run(command, options, writer, context) {
    const api = connectionService.apiForAgent('antigravity', options.connectionId);
    if (api) await validateConnectionEndpoint(api.baseUrl!);
    const appId = String(options.sessionId);
    let cid = context.resolveProviderSessionId(appId);
    const history = cid ? await json(await antigravityBridge.request('GET', endpoint(cid))) : { messages: [], revision: null };
    if (history.active_turn?.status === 'running') throw new AppError('这段聊天仍在生成，请等待完成后再发送', { code: 'AGY_BUSY', statusCode: 409 });
    const attachments: AnyRecord[] = options.attachments || [];
    const nativeAttachments: AnyRecord[] = [];
    const assets = await fs.realpath(getGlobalImageAssetsDir()).catch(() => getGlobalImageAssetsDir());
    for (const item of attachments) {
      const file = await fs.realpath(item.path);
      if (path.dirname(file) !== assets || (await fs.stat(file)).size > 25 * 1024 * 1024) throw new Error('附件必须来自聊天上传区，且不超过 25 MB');
      nativeAttachments.push(await json(await antigravityBridge.request('POST', '/api/upload', { filename: item.name || path.basename(file), data: (await fs.readFile(file)).toString('base64') })));
    }
    const user = { id: randomUUID(), role: 'user', content: command, attachments };
    const turnId = randomUUID().replace(/-/g, '');
    const controller = new AbortController();
    running.set(appId, { turnId, controller });
    let message: AnyRecord = { id: turnId + ':assistant', role: 'assistant', content: '' };
    let failed = false;
    let relay: Awaited<ReturnType<typeof startApiRelay>> | null = null;
    const send = (value: NormalizedMessage) => writer.send(value);
    const capture = (value: unknown) => {
      if (!cid && typeof value === 'string' && value) {
        cid = value; writer.setSessionId?.(cid);
        send(createNormalizedMessage({ provider, kind: 'session_created', sessionId: cid, newSessionId: cid }));
      }
    };
    try {
      if (api?.protocol === 'chat_completions') relay = await startApiRelay('antigravity', { ...api, model: options.model || api.model });
      const payload = {
        messages: [{ ...user, attachments: nativeAttachments }], message_snapshot: [...history.messages, user], conversation_id: cid,
        history_revision: cid ? history.revision : undefined,
        model: options.model || api?.model, model_label: options.model || api?.model,
        cwd: options.cwd || options.projectPath, turn_id: turnId, continue_conversation: false,
        ...(options.useClaudeAgy === true ? { use_claude_agy: true } : {}),
        ...(api ? { api_connection: { base_url: relay?.baseUrl || api.baseUrl!.replace(/\/v1(?:beta)?$/, ''), api_key: relay?.apiKey || api.apiKey,
          proxy_port: relay ? 0 : Number(api.env.MINTCLI_SELECTED_EGRESS_PORT || 0), chat_compat: Boolean(relay) } } : {}),
      };
      const response = api
        ? await antigravityBridge.request('POST', '/api/chat', payload, controller.signal)
        : await antigravityBridge.startChatForAccount(options.connectionId, payload, controller.signal);
      if (!response.ok) { await json(response); return; }
      if (!response.body) throw new Error('agy 回复流为空');
      let pending = '', done = false, cursor = 0;
      const decoder = new TextDecoder();
      const processEvent = (block: string) => {
        const data = block.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (!data) return;
        const event = JSON.parse(data) as AnyRecord;
        if (event.cursor && event.cursor <= cursor) return;
        cursor = event.cursor || cursor;
        capture(event.conversation_id);
        if (event.event === 'snapshot' && event.message) message = { ...message, ...event.message };
        if (event.event === 'delta') message.content += String(event.delta ?? event.text ?? '');
        if (event.event === 'thinking') message.thinking = event.mode === 'snapshot' ? String(event.thinking || '') : (message.thinking || '') + String(event.thinking ?? event.delta ?? '');
        if (event.event === 'result' && event.response) message.content = event.response;
        if (event.event === 'tool') send(createNormalizedMessage({ provider, sessionId: appId, kind: 'status', text: String(event.tool || event.name || '正在执行工具') }));
        if (event.event === 'error') { failed = true; message.errorText = String(event.error || 'agy 生成失败'); }
        if (event.event === 'done') done = true;
        // Full text snapshots update the same transcript row and survive WebSocket replay.
        for (const normalized of normalizeAgy(message, appId)) send(normalized);
      };
      const consume = async (stream: ReadableStream<Uint8Array>) => {
        const reader = stream.getReader();
        try {
          while (!done) {
            const chunk = await reader.read(); pending += decoder.decode(chunk.value, { stream: !chunk.done });
            let boundary: RegExpExecArray | null;
            while ((boundary = /\r?\n\r?\n/.exec(pending))) { processEvent(pending.slice(0, boundary.index)); pending = pending.slice(boundary.index + boundary[0].length); }
            if (chunk.done) { if (pending.trim()) processEvent(pending); pending = ''; break; }
          }
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      };
      await consume(response.body).catch(error => { if (controller.signal.aborted) throw error; });
      // Native tasks continue when a subscriber drops. Reattach without resending the prompt.
      for (let retry = 0; !done && !controller.signal.aborted && retry < 3; retry++) {
        const replay = await antigravityBridge.request('GET', '/api/turns/' + turnId + '/events?cursor=' + cursor, undefined, controller.signal);
        if (!replay.ok || !replay.body) break;
        await consume(replay.body).catch(error => { if (controller.signal.aborted) throw error; });
      }
      if (!done && !controller.signal.aborted) throw new Error('agy 连接中断；原生任务可能仍在生成，请刷新聊天同步结果');
    } catch (error) {
      if (!controller.signal.aborted) { failed = true; throw error; }
    } finally {
      await relay?.close();
      running.delete(appId);
      if (cid) {
        const session = sessionsDb.getSessionById(appId);
        sessionsDb.createSession(cid, provider, session?.project_path || options.cwd || '/home/ubuntu', undefined, undefined, new Date().toISOString());
      }
      send(createCompleteMessage({ provider, sessionId: appId, exitCode: failed ? 1 : 0, aborted: controller.signal.aborted }));
    }
  },
  async abort(sessionId) {
    const turn = running.get(sessionId); if (!turn) return false;
    const response = await antigravityBridge.request('POST', '/api/turns/' + turn.turnId + '/stop');
    if (!response.ok) return false;
    turn.controller.abort(); return true;
  },
};

/** A native fifth provider: one composer, model menu, sidebar and run gateway for every agent. */
export class AntigravityProvider implements IProvider {
  readonly id = provider;
  declare readonly runtime: IProviderRuntime;
  constructor() { Object.defineProperty(this, 'runtime', { enumerable: true, get: () => runtime }); }
  readonly models = {
    async getSupportedModels() { const api = connectionService.apiForAgent('antigravity'); if (api) return connectionService.apiModelCatalog(api.id); const data = await json(await antigravityBridge.request('GET', '/api/models')); const OPTIONS = (data.models || []).map((item: AnyRecord) => ({ value: String(item.id), label: String(item.name || item.id) })); return { ACCOUNT_SCOPED: true, OPTIONS, DEFAULT: OPTIONS[0]?.value || '' }; },
    async getCurrentActiveModel() { return { model: (await this.getSupportedModels()).DEFAULT }; },
  };
  readonly auth = {
    // Managed bridges use mintcli's own executable; legacy remote bridges expose no local version.
    checkInstalled(): CliVersionProbe { const command = resolveManagedCli('antigravity'); return command ? probeCliVersion(command) : { installed: true, exitCode: null, version: null }; },
    async getStatus(): Promise<ProviderAuthStatus> { try { const api = connectionService.apiForAgent('antigravity'); if (api) return { provider, installedVersion: null, installed: true, authenticated: Boolean(api.apiKey), email: null, method: 'api-key' }; const data = await json(await antigravityBridge.request('GET', '/api/accounts')); const active = data.accounts?.find((item: AnyRecord) => item.active); return { provider, installedVersion: null, installed: true, authenticated: Boolean(active), email: active?.email || null, method: 'native' }; } catch { return { provider, installedVersion: null, installed: false, authenticated: false, email: null, method: null }; } } };
  readonly sessions = {
    normalizeMessage(raw: unknown, id: string | null) { return normalizeAgy(raw as AnyRecord, id); },
    async fetchHistory(sessionId: string, options: FetchHistoryOptions = {}) {
      const cid = options.providerSessionId || sessionsDb.getSessionById(sessionId)?.provider_session_id;
      if (!cid) return { messages: [], total: 0, hasMore: false, offset: 0, limit: null };
      const data = await json(await antigravityBridge.request('GET', endpoint(cid)));
      const messages: NormalizedMessage[] = (data.messages || []).flatMap((item: AnyRecord, index: number) => normalizeAgy({ ...item, id: item.id || `${cid}:${index}` }, sessionId));
      const { page, hasMore } = sliceTailPage(messages, options.limit ?? null, options.offset || 0);
      return { messages: page, total: messages.length, hasMore, offset: options.offset || 0, limit: options.limit ?? null };
    },
  };
  readonly sessionSynchronizer = {
    async synchronize() {
      const data = await json(await antigravityBridge.request('GET', '/api/conversations'));
      for (const item of data.conversations || []) {
        const existing = sessionsDb.getSessionByProviderSessionId(item.conversation_id);
        const when = typeof item.updated_at === 'number' ? new Date(item.updated_at * 1000).toISOString() : undefined;
        sessionsDb.createSession(item.conversation_id, provider, existing?.project_path || process.env.AGY_DEFAULT_PROJECT || '/home/ubuntu', item.title || 'agy 聊天', undefined, when);
      }
      return data.conversations?.length || 0;
    },
    async synchronizeFile() { return null; },
  };
  readonly mcp = {
    async listServers() { return { user: [], project: [], local: [] }; }, async listServersForScope() { return []; },
    async upsertServer(): Promise<never> { throw new Error('请在 agy 原生配置中管理 MCP'); }, async removeServer(): Promise<never> { throw new Error('请在 agy 原生配置中管理 MCP'); },
  };
  readonly skills = {
    async listSkills() { return []; }, async addSkills(): Promise<never> { throw new Error('请在 agy 原生配置中管理技能'); }, async removeSkill(): Promise<never> { throw new Error('请在 agy 原生配置中管理技能'); },
  };
}
