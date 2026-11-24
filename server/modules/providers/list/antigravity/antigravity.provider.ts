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
function normalizeAgyToolStatus(raw: unknown): 'in_progress' | 'failed' | 'completed' {
  const value = String(raw || 'running').trim().toLowerCase();
  if (value === 'error' || value === 'failed') return 'failed';
  if (value === 'completed' || value === 'done' || value === 'success' || value === 'succeeded') return 'completed';
  return 'in_progress';
}

function resolveAgyTimestamp(message: AnyRecord): string {
  if (typeof message.timestamp === 'string' && message.timestamp) return message.timestamp;
  if (typeof message.created_at === 'number' && Number.isFinite(message.created_at)) {
    const ms = message.created_at < 1e12 ? message.created_at * 1000 : message.created_at;
    return new Date(ms).toISOString();
  }
  return new Date().toISOString();
}

function readAgyModelLabel(message: AnyRecord): string | undefined {
  const requested = typeof message.requestedModel === 'string' ? message.requestedModel.trim() : '';
  if (requested && requested !== 'default') return requested;
  const model = typeof message.model === 'string' ? message.model.trim() : '';
  return model || undefined;
}

/** Same normalization for live native snapshots and old transcripts. Stable ids prevent duplicate rows. */
export function normalizeAgy(
  message: AnyRecord,
  sessionId: string | null,
  options?: { streaming?: boolean },
): NormalizedMessage[] {
  if (!['user', 'assistant'].includes(message.role)) return [];
  const timestamp = resolveAgyTimestamp(message);
  const base = { sessionId, provider, timestamp } as const;
  const id = String(message.id || randomUUID());
  const isLiveStreaming = options?.streaming ?? message.status === 'streaming';
  const model = message.role === 'assistant' ? readAgyModelLabel(message) : undefined;
  const result: NormalizedMessage[] = [];

  if (message.role === 'assistant' && Array.isArray(message.steps) && message.steps.length > 0) {
    const steps = message.steps as AnyRecord[];
    for (let index = 0; index < steps.length; index++) {
      const step = steps[index];
      if (!step || typeof step !== 'object') continue;
      const stepId = String(step.id || `${id}:step:${index}`);
      const stepTimestamp = typeof step.timestamp === 'string' && step.timestamp ? step.timestamp : timestamp;
      const isLastActiveStep = isLiveStreaming && index === steps.length - 1;

      if (step.type === 'thinking') {
        const content = String(step.content || '');
        if (content.trim()) {
          result.push(createNormalizedMessage({
            ...base,
            timestamp: stepTimestamp,
            id: stepId,
            kind: 'thinking',
            content,
            ...(isLastActiveStep ? { isStreaming: true } : {}),
          }));
        }
      } else if (step.type === 'text') {
        const content = String(step.content || '');
        if (content.trim()) {
          result.push(createNormalizedMessage({
            ...base,
            timestamp: stepTimestamp,
            id: stepId,
            kind: 'text',
            role: 'assistant',
            content,
            ...(model ? { model } : {}),
            ...(isLastActiveStep ? { isStreaming: true } : {}),
          }));
        }
      } else if (step.type === 'tool_use') {
        const toolId = String(step.toolId || stepId);
        const toolName = String(step.toolName || step.toolLabel || 'Tool');
        const status = normalizeAgyToolStatus(step.status);
        const rawResult = step.toolResult && typeof step.toolResult === 'object' ? step.toolResult as AnyRecord : null;
        const toolResult = rawResult
          ? {
              content: String(rawResult.content ?? ''),
              isError: Boolean(rawResult.isError),
              ...(rawResult.toolUseResult !== undefined ? { toolUseResult: rawResult.toolUseResult } : {}),
            }
          : undefined;
        result.push(createNormalizedMessage({
          ...base,
          timestamp: stepTimestamp,
          id: stepId,
          kind: 'tool_use',
          toolId,
          toolName,
          toolInput: step.toolInput ?? {},
          status,
          ...(toolResult ? { toolResult } : {}),
        }));
      }
    }
    if (message.errorText) result.push(createNormalizedMessage({ ...base, id: id + ':error', kind: 'error', content: String(message.errorText) }));
    return result;
  }

  if (message.thinking) {
    result.push(createNormalizedMessage({
      ...base,
      id: id + ':thinking',
      kind: 'thinking',
      content: String(message.thinking),
      ...(isLiveStreaming && !message.content ? { isStreaming: true } : {}),
    }));
  }
  if (message.content || message.attachments?.length) {
    result.push(createNormalizedMessage({
      ...base,
      id,
      kind: 'text',
      role: message.role,
      content: String(message.content || ''),
      ...(model ? { model } : {}),
      ...(isLiveStreaming && message.role === 'assistant' ? { isStreaming: true } : {}),
      ...(message.role === 'user' ? { transcriptAnchorId: id } : {}),
      images: message.attachments?.filter((item: AnyRecord) => item.mimeType?.startsWith('image/')),
      files: message.attachments?.filter((item: AnyRecord) => !item.mimeType?.startsWith('image/')),
    }));
  }
  if (message.errorText) result.push(createNormalizedMessage({ ...base, id: id + ':error', kind: 'error', content: String(message.errorText) }));
  return result;
}

export function applyAgyStreamEvent(
  message: AnyRecord,
  event: AnyRecord,
  state: { stepSeq: number },
): AnyRecord {
  const ensureSteps = (target: AnyRecord): AnyRecord[] => {
    if (!Array.isArray(target.steps)) target.steps = [];
    return target.steps as AnyRecord[];
  };
  const nextStepId = (target: AnyRecord, prefix: string, preferred?: unknown) => {
    if (typeof preferred === 'string' && preferred) return preferred;
    state.stepSeq += 1;
    return `${String(target.id || 'agy')}:${prefix}:${state.stepSeq}`;
  };
  const nowIso = () => new Date().toISOString();

  if (event.event === 'snapshot' && event.message) {
    const incoming = event.message as AnyRecord;
    const merged: AnyRecord = {
      ...message,
      ...incoming,
      steps: Array.isArray(incoming.steps)
        ? (incoming.steps as AnyRecord[]).map((step) => ({
            ...step,
            ...(step.toolResult && typeof step.toolResult === 'object' ? { toolResult: { ...step.toolResult } } : {}),
          }))
        : ensureSteps(message),
    };
    state.stepSeq = Math.max(state.stepSeq, (merged.steps as AnyRecord[]).length);
    return merged;
  }

  const steps = ensureSteps(message);

  if (event.event === 'delta') {
    const chunk = String(event.delta ?? event.text ?? '');
    message.content = String(message.content || '') + chunk;
    if (chunk) {
      const preferredId = typeof event.step_id === 'string' ? event.step_id : '';
      let target = preferredId ? steps.find((step) => step.id === preferredId && step.type === 'text') : undefined;
      if (!target && !preferredId && steps.length > 0 && steps[steps.length - 1]?.type === 'text') {
        target = steps[steps.length - 1];
      }
      if (!target) {
        target = { id: nextStepId(message, 'text', preferredId), type: 'text', content: '', timestamp: nowIso() };
        steps.push(target);
      }
      target.content = String(target.content || '') + chunk;
    }
    return message;
  }

  if (event.event === 'thinking') {
    const chunk = String(event.thinking ?? event.delta ?? '');
    const isSnapshotMode = event.mode === 'snapshot';
    message.thinking = isSnapshotMode ? chunk : String(message.thinking || '') + chunk;
    const stepIndex = typeof event.step_index === 'number' && Number.isInteger(event.step_index) && event.step_index >= 0
      ? event.step_index
      : null;
    const preferredId = typeof event.step_id === 'string' ? event.step_id : '';
    if (stepIndex !== null) {
      let target = steps.find((step) => step.type === 'thinking' && (step.stepIndex === stepIndex || (preferredId && step.id === preferredId)));
      if (!target) {
        target = { id: nextStepId(message, 'thinking', preferredId), type: 'thinking', stepIndex, content: '', timestamp: nowIso() };
        steps.push(target);
      }
      target.content = isSnapshotMode ? chunk : String(target.content || '') + chunk;
    } else if (chunk) {
      let target = preferredId ? steps.find((step) => step.id === preferredId && step.type === 'thinking') : undefined;
      if (!target && !preferredId && steps.length > 0 && steps[steps.length - 1]?.type === 'thinking' && steps[steps.length - 1]?.stepIndex === undefined) {
        target = steps[steps.length - 1];
      }
      if (!target) {
        target = { id: nextStepId(message, 'thinking', preferredId), type: 'thinking', content: '', timestamp: nowIso() };
        steps.push(target);
      }
      target.content = isSnapshotMode ? chunk : String(target.content || '') + chunk;
    }
    return message;
  }

  if (event.event === 'tool') {
    const rawToolId = String(event.tool_id || event.toolId || '');
    const toolLabel = String(event.tool || event.tool_name || event.name || 'Tool');
    const toolName = String(event.tool_name || event.toolName || event.name || toolLabel);
    const toolInput = event.tool_input !== undefined ? event.tool_input : event.args;
    const rawStatus = String(event.status || 'running').toLowerCase();
    const mappedStatus = rawStatus === 'error' || rawStatus === 'failed'
      ? 'error'
      : rawStatus === 'completed' || rawStatus === 'done' || rawStatus === 'success' || rawStatus === 'succeeded'
        ? 'completed'
        : 'running';
    const isGenericToolName = (value: string) => {
      const normalized = value.trim().toLowerCase();
      return !normalized || normalized === 'tool' || normalized === 'executing';
    };
    let target = rawToolId ? steps.find((step) => step.type === 'tool_use' && step.toolId === rawToolId) : undefined;
    if (!target) {
      const toolId = rawToolId || nextStepId(message, 'tool');
      target = {
        id: typeof event.step_id === 'string' && event.step_id ? event.step_id : `${String(message.id || 'agy')}:tool:${toolId}`,
        type: 'tool_use',
        toolId,
        toolName,
        toolLabel,
        toolInput: toolInput !== undefined ? toolInput : { summary: toolLabel },
        status: mappedStatus,
        timestamp: nowIso(),
      };
      steps.push(target);
    } else {
      if (!isGenericToolName(toolName) || isGenericToolName(String(target.toolName || ''))) {
        target.toolName = toolName;
      }
      if (!isGenericToolName(toolLabel) || isGenericToolName(String(target.toolLabel || ''))) {
        target.toolLabel = toolLabel;
      }
      if (toolInput !== undefined) target.toolInput = toolInput;
      target.status = mappedStatus;
    }
    if (event.tool_output !== undefined) {
      const isError = Boolean(event.is_error || event.isError) || mappedStatus === 'error';
      target.toolResult = { content: String(event.tool_output), isError };
      if (mappedStatus === 'running') target.status = isError ? 'error' : 'completed';
    }
    return message;
  }

  if (event.event === 'tool_result') {
    const toolId = String(event.tool_id || event.toolId || '');
    let target = toolId ? steps.find((step) => step.type === 'tool_use' && step.toolId === toolId) : undefined;
    if (!target) {
      for (let index = steps.length - 1; index >= 0; index--) {
        if (steps[index]?.type === 'tool_use' && steps[index]?.status === 'running') {
          target = steps[index];
          break;
        }
      }
    }
    if (target) {
      const isError = Boolean(event.is_error || event.isError);
      target.toolResult = {
        content: String(event.content ?? ''),
        isError,
        ...(event.tool_use_result !== undefined ? { toolUseResult: event.tool_use_result } : {}),
      };
      target.status = isError ? 'error' : 'completed';
    }
    return message;
  }

  if (event.event === 'result' && event.response) {
    message.content = String(event.response);
    if (!steps.some((step) => step.type === 'text' && String(step.content || '').trim())) {
      steps.push({
        id: nextStepId(message, 'text', event.step_id),
        type: 'text',
        content: String(event.response),
        timestamp: nowIso(),
      });
    }
    return message;
  }

  if (event.event === 'error') {
    message.errorText = String(event.error || 'agy 生成失败');
    for (const step of steps) {
      if (step.type === 'tool_use' && step.status === 'running') step.status = 'error';
    }
    return message;
  }

  if (event.event === 'done') {
    const outcome = String(event.status || 'complete');
    message.status = outcome;
    for (const step of steps) {
      if (step.type === 'tool_use' && step.status === 'running') {
        step.status = outcome === 'complete' ? 'completed' : 'error';
      }
    }
    return message;
  }

  return message;
}
type RunningAgyTurn = {
  turnId: string;
  controller: AbortController;
  ready: Promise<boolean>;
};

async function uploadNativeAttachments(attachments: AnyRecord[]): Promise<AnyRecord[]> {
  if (!attachments.length) return [];
  const nativeAttachments: AnyRecord[] = [];
  const assets = await fs.realpath(getGlobalImageAssetsDir()).catch(() => getGlobalImageAssetsDir());
  for (const item of attachments) {
    const file = await fs.realpath(item.path);
    if (path.dirname(file) !== assets || (await fs.stat(file)).size > 25 * 1024 * 1024) {
      throw new Error('附件必须来自聊天上传区，且不超过 25 MB');
    }
    nativeAttachments.push(await json(await antigravityBridge.request('POST', '/api/upload', {
      filename: item.name || path.basename(file),
      data: (await fs.readFile(file)).toString('base64'),
    })));
  }
  return nativeAttachments;
}

const running = new Map<string, RunningAgyTurn>();
const runtime: IProviderRuntime = {
  async run(command, options, writer, context) {
    const appId = String(options.sessionId);
    const turnId = randomUUID().replace(/-/g, '');
    const controller = new AbortController();
    let resolveReady!: (ok: boolean) => void;
    const ready = new Promise<boolean>((resolve) => { resolveReady = resolve; });
    const runEntry: RunningAgyTurn = { turnId, controller, ready };
    running.set(appId, runEntry);
    let cid = context.resolveProviderSessionId(appId);
    let message: AnyRecord = { id: turnId + ':assistant', role: 'assistant', content: '', status: 'streaming', steps: [] };
    const turnAssistants = new Map<string, AnyRecord>([[String(message.id), message]]);
    let failed = false;
    let done = false;
    const streamState = { stepSeq: 0 };
    const emittedSignatures = new Map<string, string>();
    let relay: Awaited<ReturnType<typeof startApiRelay>> | null = null;
    const send = (value: NormalizedMessage) => writer.send(value);
    const emitChanged = (items: NormalizedMessage[]) => {
      for (const normalized of items) {
        const signature = JSON.stringify({
          kind: normalized.kind,
          role: normalized.role ?? null,
          content: normalized.content ?? null,
          isStreaming: Boolean(normalized.isStreaming),
          status: normalized.status ?? null,
          toolId: normalized.toolId ?? null,
          toolName: normalized.toolName ?? null,
          toolInput: normalized.toolInput ?? null,
          toolResult: normalized.toolResult ?? null,
          model: normalized.model ?? null,
          images: normalized.images ?? null,
          files: normalized.files ?? null,
        });
        if (emittedSignatures.get(normalized.id) === signature) continue;
        emittedSignatures.set(normalized.id, signature);
        send(normalized);
      }
    };
    const capture = (value: unknown) => {
      if (!cid && typeof value === 'string' && value) {
        cid = value; writer.setSessionId?.(cid);
        send(createNormalizedMessage({ provider, kind: 'session_created', sessionId: cid, newSessionId: cid }));
      }
    };
    const findAssistantOwningTool = (event: AnyRecord): AnyRecord | null => {
      const explicitId = typeof event.assistant_id === 'string' ? event.assistant_id : '';
      if (explicitId && explicitId !== String(message.id) && turnAssistants.has(explicitId)) {
        return turnAssistants.get(explicitId) ?? null;
      }
      const toolId = String(event.tool_id || event.toolId || '');
      if (!toolId) return null;
      for (const candidate of turnAssistants.values()) {
        if (candidate === message) continue;
        const steps = Array.isArray(candidate.steps) ? (candidate.steps as AnyRecord[]) : [];
        if (steps.some((step) => step.type === 'tool_use' && step.toolId === toolId)) {
          return candidate;
        }
      }
      return null;
    };
    try {
      const api = connectionService.apiForAgent('antigravity', options.connectionId);
      if (api) await validateConnectionEndpoint(api.baseUrl!);
      const history = cid ? await json(await antigravityBridge.request('GET', endpoint(cid))) : { messages: [], revision: null };
      if (history.active_turn?.status === 'running') throw new AppError('这段聊天仍在生成，请等待完成后再发送', { code: 'AGY_BUSY', statusCode: 409 });
      const attachments: AnyRecord[] = options.attachments || [];
      const nativeAttachments = await uploadNativeAttachments(attachments);
      const user = { id: randomUUID(), role: 'user', content: command, attachments };
      if (api?.protocol === 'chat_completions') relay = await startApiRelay('antigravity', { ...api, model: options.model || api.model });
      const payload = {
        messages: [{ ...user, attachments: nativeAttachments }], message_snapshot: [...history.messages, user], conversation_id: cid,
        history_revision: cid ? history.revision : undefined,
        model: options.model || api?.model, model_label: options.model || api?.model,
        cwd: options.cwd || options.projectPath, turn_id: turnId, continue_conversation: false,
        ...(options.useClaudeAgy === true ? { use_claude_agy: true } : {}),
        ...(options.useArmor === true || options.armor === true ? { use_armor: true } : {}),
        ...(api ? { api_connection: { base_url: relay?.baseUrl || api.baseUrl!.replace(/\/v1(?:beta)?$/, ''), api_key: relay?.apiKey || api.apiKey,
          proxy_port: relay ? 0 : Number(api.env.MINTCLI_SELECTED_EGRESS_PORT || 0), chat_compat: Boolean(relay) } } : {}),
      };
      const response = api
        ? await antigravityBridge.request('POST', '/api/chat', payload, controller.signal)
        : await antigravityBridge.startChatForAccount(options.connectionId, payload, controller.signal);
      if (!response.ok) { resolveReady(false); await json(response); return; }
      if (!response.body) { resolveReady(false); throw new Error('agy 回复流为空'); }
      resolveReady(true);
      let pending = '', cursor = 0;
      const decoder = new TextDecoder();
      const processEvent = (block: string) => {
        const data = block.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (!data) return;
        const event = JSON.parse(data) as AnyRecord;
        if (event.cursor && event.cursor <= cursor) return;
        cursor = event.cursor || cursor;
        capture(event.conversation_id);
        if (event.event === 'user_message_applied') {
          emitChanged(normalizeAgy(message, appId, { streaming: false }));
          if (event.assistant && typeof event.assistant === 'object') {
            const incoming = event.assistant as AnyRecord;
            message = {
              ...incoming,
              steps: Array.isArray(incoming.steps) ? (incoming.steps as AnyRecord[]).map((step) => ({ ...step })) : [],
            };
            turnAssistants.set(String(message.id), message);
            streamState.stepSeq = Math.max(0, (message.steps as AnyRecord[]).length);
          }
          return;
        }
        if (event.event === 'tool' || event.event === 'tool_result') {
          const owner = findAssistantOwningTool(event);
          if (owner) {
            const updated = applyAgyStreamEvent(owner, event, streamState);
            turnAssistants.set(String(updated.id), updated);
            emitChanged(normalizeAgy(updated, appId, { streaming: false }));
            return;
          }
        }
        if (event.event === 'error') failed = true;
        if (event.event === 'done') done = true;
        message = applyAgyStreamEvent(message, event, streamState);
        turnAssistants.set(String(message.id), message);
        if (done) {
          for (const previous of turnAssistants.values()) {
            if (previous === message) continue;
            const settled = applyAgyStreamEvent(previous, event, streamState);
            emitChanged(normalizeAgy(settled, appId, { streaming: false }));
          }
        }
        // Emit only changed step rows so thinking, tool calls, tool results and
        // text stream inline in the conversation without flooding unchanged rows.
        emitChanged(normalizeAgy(message, appId, { streaming: !done }));
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
      resolveReady(false);
      if (!done) {
        const doneEvent = { event: 'done', status: failed ? 'error' : 'stopped' };
        for (const previous of turnAssistants.values()) {
          if (previous === message) continue;
          const settled = applyAgyStreamEvent(previous, doneEvent, streamState);
          emitChanged(normalizeAgy(settled, appId, { streaming: false }));
        }
        if ((Array.isArray(message.steps) && message.steps.length > 0) || message.content || message.thinking || message.errorText) {
          message = applyAgyStreamEvent(message, doneEvent, streamState);
          emitChanged(normalizeAgy(message, appId, { streaming: false }));
        }
      }
      await relay?.close();
      if (running.get(appId) === runEntry) {
        running.delete(appId);
      }
      if (cid) {
        const session = sessionsDb.getSessionById(appId);
        sessionsDb.createSession(cid, provider, session?.project_path || options.cwd || '/home/ubuntu', undefined, undefined, new Date().toISOString());
      }
      send(createCompleteMessage({ provider, sessionId: appId, exitCode: failed ? 1 : 0, aborted: controller.signal.aborted }));
    }
  },
  async injectMessage(sessionId, command, options) {
    const turn = running.get(sessionId);
    if (!turn) return false;
    const isReady = await turn.ready;
    if (!isReady || turn.controller.signal.aborted || running.get(sessionId) !== turn) {
      return false;
    }
    const attachments: AnyRecord[] = Array.isArray(options.attachments) ? options.attachments : [];
    let nativeAttachments: AnyRecord[] = [];
    try {
      nativeAttachments = await uploadNativeAttachments(attachments);
    } catch {
      return false;
    }
    if (turn.controller.signal.aborted || running.get(sessionId) !== turn) {
      return false;
    }
    try {
      const response = await antigravityBridge.request(
        'POST',
        '/api/turns/' + turn.turnId + '/messages',
        {
          content: command,
          attachments: nativeAttachments,
          client_attachments: attachments,
          message_id: randomUUID(),
        },
        turn.controller.signal,
      );
      return response.ok;
    } catch {
      return false;
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
    async recallMessage(sessionId: string, input: { messageId?: string; userTurnFromEnd?: number }) {
      const cid = sessionsDb.getSessionById(sessionId)?.provider_session_id;
      if (!cid) return false;
      const response = await antigravityBridge.request(
        'POST',
        '/api/conversations/' + encodeURIComponent(cid) + '/recall',
        {
          ...(input.messageId ? { message_id: input.messageId } : {}),
          ...(typeof input.userTurnFromEnd === 'number' ? { user_turn_from_end: input.userTurnFromEnd } : {}),
        },
      );
      if (response.status === 404) return false;
      await json(response);
      return true;
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
