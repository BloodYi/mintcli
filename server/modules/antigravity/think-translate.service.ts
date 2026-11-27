import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { antigravityBridge } from './antigravity.service.js';
import { connectionService, getCodexModelCatalog, resolveCodexConnection } from '@/modules/codex-connections/index.js';
import type {
  MonitorThinkTranslateCooldown,
  MonitorThinkTranslateEvent,
  MonitorThinkTranslateModelRow,
  MonitorThinkTranslateSummary,
  MonitorTokens,
} from '@/shared/index.js';
import { AppError, resolveManagedCli } from '@/shared/index.js';

type ThinkTranslatePlatform = 'agy' | 'codex';

type ThinkTranslateAccountOption = {
  id: string;
  raw_id: string;
  platform: ThinkTranslatePlatform;
  email: string;
  name: string;
  label: string;
  active: boolean;
  subscription_tier?: string;
};

type ThinkTranslateModelOption = {
  id: string;
  name: string;
};

type ThinkTranslateConfigData = {
  account_id: string;
  model: string;
  target_lang: string;
  updated_at: string | null;
};

type PersistedTelemetryModelBucket = {
  model: string;
  platforms: Array<'agy' | 'codex'>;
  callCount: number;
  tokens: MonitorTokens;
  timedOutputTokens: number;
  timedDurationMs: number;
};

type PersistedTelemetryStore = {
  totalCalls: number;
  cachedCalls: number;
  fallbackCalls: number;
  failedCalls: number;
  tokens: MonitorTokens;
  timedOutputTokens: number;
  timedDurationMs: number;
  models: Record<string, PersistedTelemetryModelBucket>;
  recent: MonitorThinkTranslateEvent[];
};

type CodexTranslateCacheEntry = {
  translated: string;
  reportedModel: string | null;
};

const DEFAULT_TARGET_LANG = 'zh-CN';
const MAX_TEXT_CHARS = 32000;
const MAX_CACHE_ENTRIES = 256;
const MAX_RECENT_TELEMETRY = 60;
const CODEX_TIMEOUT_MS = 65_000;
const MAX_CODEX_CONCURRENCY = 3;

const LANG_LABELS: Record<string, string> = {
  'zh-CN': 'Simplified Chinese (简体中文)',
  'zh-TW': 'Traditional Chinese (繁體中文)',
  en: 'English',
  ja: 'Japanese (日本語)',
  ko: 'Korean (한국어)',
  fr: 'French',
  de: 'German',
  es: 'Spanish',
};

const codexCache = new Map<string, CodexTranslateCacheEntry>();
const codexAccountCooldowns = new Map<string, { untilMs: number; reason: string }>();
let activeCodexJobs = 0;
const codexWaitQueue: Array<() => void> = [];

function emptyTokens(): MonitorTokens {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0 };
}

function safeNonNegative(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : 0;
}

function addTokensInto(target: MonitorTokens, delta: MonitorTokens | null | undefined): void {
  if (!delta) return;
  target.input += safeNonNegative(delta.input);
  target.output += safeNonNegative(delta.output);
  target.cacheRead += safeNonNegative(delta.cacheRead);
  target.cacheWrite += safeNonNegative(delta.cacheWrite);
  target.reasoning += safeNonNegative(delta.reasoning);
  target.total += safeNonNegative(delta.total);
}

function computeSpeed(timedOutput: number, timedDurationMs: number | null | undefined): number | null {
  if (typeof timedDurationMs !== 'number' || !Number.isFinite(timedDurationMs) || timedDurationMs <= 0) {
    return null;
  }
  if (timedOutput <= 0) return null;
  return Math.round(((timedOutput * 1000) / timedDurationMs) * 10) / 10;
}

function normalizeUsageTokens(raw: unknown): MonitorTokens | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const input = safeNonNegative(record.input ?? record.input_tokens ?? record.prompt_tokens);
  const output = safeNonNegative(record.output ?? record.output_tokens ?? record.completion_tokens);
  const cacheRead = safeNonNegative(
    record.cacheRead ?? record.cache_read_tokens ?? record.cached_input_tokens,
  );
  const cacheWrite = safeNonNegative(
    record.cacheWrite ?? record.cache_creation_tokens ?? record.cache_write_input_tokens,
  );
  const reasoning = safeNonNegative(
    record.reasoning ?? record.thinking_tokens ?? record.reasoning_output_tokens,
  );
  const totalRaw = safeNonNegative(record.total ?? record.total_tokens);
  const total = totalRaw > 0 ? totalRaw : input + output + cacheRead + cacheWrite;
  if (total <= 0 && input <= 0 && output <= 0) return null;
  return { input, output, cacheRead, cacheWrite, reasoning, total };
}

function acquireCodexSlot(): Promise<void> {
  if (activeCodexJobs < MAX_CODEX_CONCURRENCY) {
    activeCodexJobs += 1;
    return Promise.resolve();
  }
  return new Promise(resolve => {
    codexWaitQueue.push(() => {
      activeCodexJobs += 1;
      resolve();
    });
  });
}

function releaseCodexSlot(): void {
  activeCodexJobs = Math.max(0, activeCodexJobs - 1);
  const next = codexWaitQueue.shift();
  if (next) next();
}

function connectionsRootDir(): string {
  return process.env.AGENT_CONNECTIONS_ROOT || path.join(os.homedir(), 'unified');
}

function configFilePath(): string {
  return path.join(connectionsRootDir(), 'think-translate.json');
}

function telemetryFilePath(): string {
  return path.join(connectionsRootDir(), 'think-translate-telemetry.json');
}

function normalizeTargetLang(lang?: string | null): string {
  const cleaned = typeof lang === 'string' ? lang.trim() : '';
  return cleaned || DEFAULT_TARGET_LANG;
}

function normalizeThinkTranslateAccountId(raw?: string | null): string {
  const cleaned = typeof raw === 'string' ? raw.trim() : '';
  if (!cleaned) return '';
  if (cleaned.startsWith('agy:') || cleaned.startsWith('codex:')) return cleaned;
  // Legacy unprefixed account_id values came from Antigravity bridge.
  return `agy:${cleaned}`;
}

function parseThinkTranslateAccountId(accountId: string): { platform: ThinkTranslatePlatform; rawId: string } {
  const normalized = normalizeThinkTranslateAccountId(accountId);
  if (!normalized) return { platform: 'agy', rawId: '' };
  if (normalized.startsWith('codex:')) return { platform: 'codex', rawId: normalized.slice(6) };
  if (normalized.startsWith('agy:')) return { platform: 'agy', rawId: normalized.slice(4) };
  return { platform: 'agy', rawId: normalized };
}

function emptyTelemetryStore(): PersistedTelemetryStore {
  return {
    totalCalls: 0,
    cachedCalls: 0,
    fallbackCalls: 0,
    failedCalls: 0,
    tokens: emptyTokens(),
    timedOutputTokens: 0,
    timedDurationMs: 0,
    models: {},
    recent: [],
  };
}

function readTelemetryStore(): PersistedTelemetryStore {
  const file = telemetryFilePath();
  if (!fs.existsSync(file)) return emptyTelemetryStore();
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<PersistedTelemetryStore>;
    if (!parsed || typeof parsed !== 'object') return emptyTelemetryStore();
    return {
      totalCalls: safeNonNegative(parsed.totalCalls),
      cachedCalls: safeNonNegative(parsed.cachedCalls),
      fallbackCalls: safeNonNegative(parsed.fallbackCalls),
      failedCalls: safeNonNegative(parsed.failedCalls),
      tokens: normalizeUsageTokens(parsed.tokens) || emptyTokens(),
      timedOutputTokens: safeNonNegative(parsed.timedOutputTokens),
      timedDurationMs: safeNonNegative(parsed.timedDurationMs),
      models: parsed.models && typeof parsed.models === 'object' ? parsed.models : {},
      recent: Array.isArray(parsed.recent) ? parsed.recent.slice(0, MAX_RECENT_TELEMETRY) : [],
    };
  } catch {
    return emptyTelemetryStore();
  }
}

function writeTelemetryStore(store: PersistedTelemetryStore): void {
  try {
    const file = telemetryFilePath();
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temp = `${file}.${randomUUID()}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(store, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(temp, file);
  } catch {
    // Telemetry persistence is best-effort and never blocks translation responses.
  }
}

function recordTelemetryEvent(event: MonitorThinkTranslateEvent): void {
  const store = readTelemetryStore();
  store.totalCalls += 1;
  if (event.cached) store.cachedCalls += 1;
  if (event.fallbackUsed) store.fallbackCalls += 1;
  if (event.status === 'error') store.failedCalls += 1;

  if (event.status === 'ok' && !event.cached && event.tokens) {
    addTokensInto(store.tokens, event.tokens);
    if (event.durationMs && event.durationMs > 0 && event.tokens.output > 0) {
      store.timedOutputTokens += event.tokens.output;
      store.timedDurationMs += event.durationMs;
    }
    const modelKey = (event.reportedModel || event.requestedModel || 'default').trim() || 'default';
    let bucket = store.models[modelKey];
    if (!bucket) {
      bucket = {
        model: modelKey,
        platforms: [],
        callCount: 0,
        tokens: emptyTokens(),
        timedOutputTokens: 0,
        timedDurationMs: 0,
      };
      store.models[modelKey] = bucket;
    }
    if (!bucket.platforms.includes(event.platform)) {
      bucket.platforms.push(event.platform);
    }
    bucket.callCount += 1;
    addTokensInto(bucket.tokens, event.tokens);
    if (event.durationMs && event.durationMs > 0 && event.tokens.output > 0) {
      bucket.timedOutputTokens += event.tokens.output;
      bucket.timedDurationMs += event.durationMs;
    }
  }

  store.recent = [event, ...store.recent].slice(0, MAX_RECENT_TELEMETRY);
  writeTelemetryStore(store);
}

function readStoredConfig(): ThinkTranslateConfigData | null {
  const file = configFilePath();
  if (!fs.existsSync(file)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<ThinkTranslateConfigData>;
    return {
      account_id: normalizeThinkTranslateAccountId(raw.account_id),
      model: typeof raw.model === 'string' ? raw.model.trim() : '',
      target_lang: normalizeTargetLang(raw.target_lang),
      updated_at: typeof raw.updated_at === 'string' ? raw.updated_at : null,
    };
  } catch {
    return null;
  }
}

function writeStoredConfig(cfg: ThinkTranslateConfigData): void {
  const file = configFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temp, file);
}

async function loadConfigWithLegacyFallback(): Promise<ThinkTranslateConfigData> {
  const stored = readStoredConfig();
  if (stored) return stored;

  const fallback: ThinkTranslateConfigData = {
    account_id: '',
    model: '',
    target_lang: DEFAULT_TARGET_LANG,
    updated_at: null,
  };
  try {
    const res = await antigravityBridge.request('GET', '/api/think-translate/config?lite=1');
    if (res.ok) {
      const legacy = (await res.json()) as Partial<ThinkTranslateConfigData>;
      fallback.account_id = normalizeThinkTranslateAccountId(legacy.account_id);
      fallback.model = typeof legacy.model === 'string' ? legacy.model.trim() : '';
      fallback.target_lang = normalizeTargetLang(legacy.target_lang);
      fallback.updated_at = typeof legacy.updated_at === 'string' ? legacy.updated_at : null;
    }
  } catch {
    // Non-fatal if bridge is unavailable.
  }
  return fallback;
}

async function listThinkTranslateAccounts(): Promise<ThinkTranslateAccountOption[]> {
  const accounts: ThinkTranslateAccountOption[] = [];

  try {
    const res = await antigravityBridge.request('GET', '/api/accounts');
    if (res.ok) {
      const data = (await res.json()) as {
        accounts?: Array<{
          id?: string;
          email?: string;
          name?: string;
          active?: boolean;
          subscription_tier?: string;
        }>;
      };
      for (const acc of data.accounts || []) {
        const rawId = String(acc.id || '').trim();
        if (!rawId) continue;
        const email = String(acc.email || '').trim();
        const name = String(acc.name || email || rawId).trim();
        const identifier = email || name || rawId;
        const tierSuffix = typeof acc.subscription_tier === 'string' && acc.subscription_tier.trim()
          ? ` (${acc.subscription_tier.trim()})`
          : '';
        accounts.push({
          id: `agy:${rawId}`,
          raw_id: rawId,
          platform: 'agy',
          email,
          name,
          label: `agy:${identifier}${tierSuffix}`,
          active: Boolean(acc.active),
          ...(typeof acc.subscription_tier === 'string' && acc.subscription_tier
            ? { subscription_tier: acc.subscription_tier }
            : {}),
        });
      }
    }
  } catch {
    // Non-fatal if bridge is temporarily unreachable.
  }

  try {
    const codexList = connectionService.list();
    for (const item of codexList.connections) {
      if (item.kind !== 'chatgpt' || !item.authorized) continue;
      const rawId = String(item.id || '').trim();
      if (!rawId) continue;
      const email = String(item.email || '').trim();
      const name = String(item.name || email || rawId).trim();
      const identifier = email || name || rawId;
      const tierSuffix = item.subscriptionTier ? ` (${item.subscriptionTier})` : '';
      accounts.push({
        id: `codex:${rawId}`,
        raw_id: rawId,
        platform: 'codex',
        email,
        name,
        label: `codex:${identifier}${tierSuffix}`,
        active: item.id === codexList.activeId,
        ...(item.subscriptionTier ? { subscription_tier: item.subscriptionTier } : {}),
      });
    }
  } catch {
    // Non-fatal if codex store is unavailable.
  }

  return accounts;
}

async function listThinkTranslateModels(accountId: string): Promise<ThinkTranslateModelOption[]> {
  const { platform, rawId } = parseThinkTranslateAccountId(accountId);
  if (platform === 'codex') {
    if (!rawId) return [];
    const catalog = await getCodexModelCatalog(rawId);
    return (catalog.OPTIONS || []).map(opt => ({
      id: opt.value,
      name: opt.label || opt.value,
    }));
  }

  const target = rawId
    ? `/api/models?account_id=${encodeURIComponent(rawId)}`
    : '/api/models?account_id=__active__';
  const res = await antigravityBridge.request('GET', target);
  if (!res.ok) return [];
  const data = (await res.json()) as { models?: Array<{ id?: string; name?: string }> };
  return (data.models || [])
    .filter(m => typeof m.id === 'string' && m.id.trim())
    .map(m => ({ id: m.id!.trim(), name: (m.name || m.id!).trim() }));
}

function buildTranslationPrompt(text: string, targetLang: string): string {
  const langLabel = LANG_LABELS[targetLang] || targetLang;
  return (
    `You are a precise technical translator. Translate the following AI thinking/reasoning text into ${langLabel}.\n`
    + 'Strict rules:\n'
    + '1. Output ONLY the translated text itself. Do NOT add any preamble, explanation, notes, or surrounding quotes.\n'
    + '2. Preserve all code blocks, inline code, file paths, CLI commands, identifiers, symbol names, URLs, and exact log/error quotes verbatim.\n'
    + '3. Preserve paragraph breaks, bullet lists, and Markdown formatting.\n'
    + '4. Do NOT call any tools, do NOT read/write any files, and do NOT answer or continue the reasoning — only translate it.\n\n'
    + 'Text to translate:\n'
    + text
  );
}

function parseCodexJsonlTelemetry(stdout: string): { usage: MonitorTokens | null; reportedModel: string | null } {
  let usage: MonitorTokens | null = null;
  let reportedModel: string | null = null;
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || !line.startsWith('{')) continue;
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      const topModel = obj.model ?? (obj.payload && typeof obj.payload === 'object' ? (obj.payload as Record<string, unknown>).model : null);
      if (typeof topModel === 'string' && topModel.trim()) {
        reportedModel = topModel.trim();
      }
      if (obj.usage && typeof obj.usage === 'object') {
        const parsed = normalizeUsageTokens(obj.usage);
        if (parsed) usage = parsed;
      }
      const payload = obj.payload && typeof obj.payload === 'object' ? (obj.payload as Record<string, unknown>) : null;
      if (payload?.info && typeof payload.info === 'object') {
        const info = payload.info as Record<string, unknown>;
        if (info.total_token_usage && typeof info.total_token_usage === 'object') {
          const parsed = normalizeUsageTokens(info.total_token_usage);
          if (parsed) usage = parsed;
        }
      }
    } catch {
      // Ignore non-JSON lines.
    }
  }
  return { usage, reportedModel };
}

function isRetryableCodexFailure(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes('429')
    || lower.includes('quota')
    || lower.includes('limit')
    || lower.includes('rate')
    || lower.includes('401')
    || lower.includes('403')
    || lower.includes('unauthorized')
    || lower.includes('expired')
    || lower.includes('超时')
    || lower.includes('timeout')
  );
}

async function translateWithCodex(params: {
  text: string;
  targetLang: string;
  accountId: string;
  rawId: string;
  model: string;
}): Promise<{
  ok: true;
  translated: string;
  account_id: string;
  account_label: string;
  model: string;
  reported_model: string | null;
  target_lang: string;
  cached: boolean;
  duration_ms: number;
  usage: MonitorTokens | null;
}> {
  const cleaned = params.text.trim().slice(0, MAX_TEXT_CHARS);
  if (!cleaned) {
    return {
      ok: true,
      translated: '',
      account_id: params.accountId,
      account_label: params.accountId,
      model: params.model,
      reported_model: null,
      target_lang: params.targetLang,
      cached: false,
      duration_ms: 0,
      usage: null,
    };
  }

  const digest = createHash('sha256').update(cleaned, 'utf8').digest('hex');
  const cacheKey = `${params.accountId}|${params.model}|${params.targetLang}|${digest}`;
  const cached = codexCache.get(cacheKey);
  if (cached !== undefined) {
    codexCache.delete(cacheKey);
    codexCache.set(cacheKey, cached);
    return {
      ok: true,
      translated: cached.translated,
      account_id: params.accountId,
      account_label: params.accountId,
      model: params.model,
      reported_model: cached.reportedModel,
      target_lang: params.targetLang,
      cached: true,
      duration_ms: 0,
      usage: null,
    };
  }

  const conn = resolveCodexConnection(params.rawId);
  const codexBin = resolveManagedCli('codex') || 'codex';
  const prompt = buildTranslationPrompt(cleaned, params.targetLang);
  const accountLabel = `codex:${conn.name || params.rawId}`;

  await acquireCodexSlot();
  try {
    const cachedAfterWait = codexCache.get(cacheKey);
    if (cachedAfterWait !== undefined) {
      return {
        ok: true,
        translated: cachedAfterWait.translated,
        account_id: params.accountId,
        account_label: accountLabel,
        model: params.model,
        reported_model: cachedAfterWait.reportedModel,
        target_lang: params.targetLang,
        cached: true,
        duration_ms: 0,
        usage: null,
      };
    }

    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'codex-translate-'));
    const outFile = path.join(tmpDir, 'last-message.txt');
    const startedAt = Date.now();
    try {
      const args = [
        'exec',
        '--ephemeral',
        '--skip-git-repo-check',
        '--sandbox', 'read-only',
        '--ignore-user-config',
        '--ignore-rules',
        '--color', 'never',
        '--json',
        '-o', outFile,
      ];
      if (params.model && params.model !== 'default') {
        args.push('-m', params.model);
      }
      args.push('-');

      const { exitCode, stdout, stderr } = await new Promise<{ exitCode: number | null; stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn(codexBin, args, {
          cwd: tmpDir,
          env: conn.env,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        let stdoutBuf = '';
        let stderrBuf = '';
        child.stdout.on('data', chunk => {
          if (stdoutBuf.length < 256_000) stdoutBuf += String(chunk);
        });
        child.stderr.on('data', chunk => {
          stderrBuf += String(chunk);
        });
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new AppError('思考翻译超时，请更换更快的翻译模型或稍后重试。', { code: 'THINK_TRANSLATE_TIMEOUT', statusCode: 504 }));
        }, CODEX_TIMEOUT_MS);
        child.on('error', err => {
          clearTimeout(timer);
          reject(new AppError(`Codex 翻译进程启动失败：${err.message}`, { code: 'THINK_TRANSLATE_ERROR', statusCode: 502 }));
        });
        child.on('close', code => {
          clearTimeout(timer);
          resolve({ exitCode: code, stdout: stdoutBuf, stderr: stderrBuf.trim() });
        });
        child.stdin.end(prompt, 'utf8');
      });

      const durationMs = Math.max(1, Date.now() - startedAt);
      let translated = '';
      try {
        translated = (await fsp.readFile(outFile, 'utf8')).trim();
      } catch {
        translated = '';
      }
      if (!translated) {
        const detail = stderr.split('\n').filter(Boolean).pop() || `exit code ${exitCode}`;
        const errMessage = `Codex 翻译失败：${detail.slice(0, 240)}`;
        if (isRetryableCodexFailure(errMessage)) {
          codexAccountCooldowns.set(params.rawId, { untilMs: Date.now() + 10 * 60_000, reason: errMessage });
        }
        throw new AppError(errMessage, { code: 'THINK_TRANSLATE_ERROR', statusCode: 502 });
      }

      const { usage, reportedModel } = parseCodexJsonlTelemetry(stdout);
      codexCache.set(cacheKey, { translated, reportedModel });
      while (codexCache.size > MAX_CACHE_ENTRIES) {
        const oldest = codexCache.keys().next().value;
        if (oldest === undefined) break;
        codexCache.delete(oldest);
      }
      return {
        ok: true,
        translated,
        account_id: params.accountId,
        account_label: accountLabel,
        model: params.model,
        reported_model: reportedModel,
        target_lang: params.targetLang,
        cached: false,
        duration_ms: durationMs,
        usage,
      };
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  } finally {
    releaseCodexSlot();
  }
}

function listHealthyCodexBackupIds(excludeRawId?: string): string[] {
  try {
    const now = Date.now();
    const list = connectionService.list();
    return list.connections
      .filter(item => {
        if (item.kind !== 'chatgpt' || !item.authorized) return false;
        const id = String(item.id || '').trim();
        if (!id || id === excludeRawId) return false;
        const cd = codexAccountCooldowns.get(id);
        if (cd && cd.untilMs > now) return false;
        return true;
      })
      .sort((a, b) => Number(b.id === list.activeId) - Number(a.id === list.activeId))
      .map(item => String(item.id).trim());
  } catch {
    return [];
  }
}

/** Used by Token Monitor to expose aggregate thinking-translation token usage, throughput, and quota-failover telemetry. */
export async function getThinkTranslateMonitorSummary(): Promise<MonitorThinkTranslateSummary> {
  const cfg = await loadConfigWithLegacyFallback();
  const store = readTelemetryStore();
  const cooldowns: MonitorThinkTranslateCooldown[] = [];

  const now = Date.now();
  for (const [rawId, cd] of codexAccountCooldowns.entries()) {
    if (cd.untilMs <= now) {
      codexAccountCooldowns.delete(rawId);
      continue;
    }
    cooldowns.push({
      accountId: `codex:${rawId}`,
      model: '',
      reason: cd.reason,
      remainingSeconds: Math.max(1, Math.round((cd.untilMs - now) / 1000)),
    });
  }

  try {
    const res = await antigravityBridge.request('GET', '/api/think-translate/config?lite=1', undefined, AbortSignal.timeout(3000));
    if (res.ok) {
      const bridgeCfg = (await res.json()) as {
        cooldowns?: Array<{
          account_id?: string;
          model?: string;
          reason?: string;
          remaining_seconds?: number;
        }>;
      };
      for (const item of bridgeCfg.cooldowns || []) {
        const acc = String(item.account_id || '').trim();
        if (!acc) continue;
        cooldowns.push({
          accountId: acc.startsWith('agy:') ? acc : `agy:${acc}`,
          model: String(item.model || '').trim(),
          reason: String(item.reason || '额度冷却中').trim(),
          remainingSeconds: safeNonNegative(item.remaining_seconds),
        });
      }
    }
  } catch {
    // Bridge cooldowns are optional diagnostic metadata.
  }

  const models: MonitorThinkTranslateModelRow[] = Object.values(store.models)
    .map(bucket => {
      const platform: 'agy' | 'codex' | 'mixed' =
        bucket.platforms.length > 1 ? 'mixed' : (bucket.platforms[0] || 'agy');
      return {
        model: bucket.model,
        platform,
        callCount: bucket.callCount,
        tokens: bucket.tokens,
        timedOutputTokens: bucket.timedOutputTokens,
        timedDurationMs: bucket.timedDurationMs,
        speed: computeSpeed(bucket.timedOutputTokens, bucket.timedDurationMs),
      };
    })
    .sort((a, b) => b.tokens.total - a.tokens.total || b.callCount - a.callCount);

  return {
    configuredAccountId: cfg.account_id,
    configuredModel: cfg.model,
    totalCalls: store.totalCalls,
    cachedCalls: store.cachedCalls,
    fallbackCalls: store.fallbackCalls,
    failedCalls: store.failedCalls,
    tokens: store.tokens,
    timedOutputTokens: store.timedOutputTokens,
    timedDurationMs: store.timedDurationMs,
    speed: computeSpeed(store.timedOutputTokens, store.timedDurationMs),
    models,
    cooldowns,
    recent: store.recent,
  };
}

/** Used by Antigravity routes to manage thinking-translation configuration and resilient AGY/Codex execution. */
export const thinkTranslateService = {
  async getConfig(overrideAccountId?: string, options?: { lite?: boolean }) {
    const cfg = await loadConfigWithLegacyFallback();
    if (options?.lite) {
      return {
        ...cfg,
        accounts: [],
        models: [],
      };
    }
    const accounts = await listThinkTranslateAccounts();
    const targetAccountId = overrideAccountId !== undefined
      ? normalizeThinkTranslateAccountId(overrideAccountId)
      : cfg.account_id;

    let models: ThinkTranslateModelOption[] = [];
    try {
      models = await listThinkTranslateModels(targetAccountId);
    } catch {
      models = [];
    }
    return {
      ...cfg,
      accounts,
      models,
    };
  },

  async saveConfig(patch: { account_id?: string; model?: string; target_lang?: string }) {
    const current = await loadConfigWithLegacyFallback();
    const next: ThinkTranslateConfigData = { ...current };
    let accountChanged = false;

    if (patch.account_id !== undefined) {
      const normalized = normalizeThinkTranslateAccountId(patch.account_id);
      if (normalized) {
        const accounts = await listThinkTranslateAccounts();
        if (!accounts.some(acc => acc.id === normalized)) {
          throw new AppError('所选翻译账号不存在，请刷新账号列表后重试。', { code: 'THINK_TRANSLATE_ACCOUNT_NOT_FOUND', statusCode: 404 });
        }
      }
      accountChanged = normalized !== current.account_id;
      next.account_id = normalized;
    }

    if (patch.model !== undefined) {
      next.model = typeof patch.model === 'string' ? patch.model.trim() : '';
    }
    if (patch.target_lang !== undefined) {
      next.target_lang = normalizeTargetLang(patch.target_lang);
    }

    let models: ThinkTranslateModelOption[] = [];
    try {
      models = await listThinkTranslateModels(next.account_id);
    } catch {
      models = [];
    }

    if (accountChanged && patch.model === undefined && next.model && models.length > 0) {
      if (!models.some(m => m.id === next.model)) {
        next.model = '';
      }
    }

    next.updated_at = new Date().toISOString();
    writeStoredConfig(next);
    codexCache.clear();
    codexAccountCooldowns.clear();

    // Reset bridge-side account cooldowns when user explicitly updates translation settings.
    try {
      const { platform, rawId } = parseThinkTranslateAccountId(next.account_id);
      if (platform === 'agy') {
        await antigravityBridge.request('POST', '/api/think-translate/config', {
          account_id: rawId,
          model: next.model,
          target_lang: next.target_lang,
        });
      }
    } catch {
      // Non-fatal if bridge is offline when saving a Codex config.
    }

    return {
      ok: true,
      ...next,
      models,
    };
  },

  async translate(input: { text?: string; target_lang?: string; account_id?: string; model?: string }) {
    const text = typeof input.text === 'string' ? input.text : '';
    if (!text.trim()) {
      return {
        ok: true,
        translated: '',
        account_id: '',
        model: '',
        target_lang: DEFAULT_TARGET_LANG,
        cached: false,
      };
    }

    const cfg = await loadConfigWithLegacyFallback();
    const accountId = input.account_id !== undefined
      ? normalizeThinkTranslateAccountId(input.account_id)
      : cfg.account_id;
    const model = input.model !== undefined ? String(input.model || '').trim() : cfg.model;
    const targetLang = normalizeTargetLang(input.target_lang !== undefined ? input.target_lang : cfg.target_lang);

    const { platform, rawId } = parseThinkTranslateAccountId(accountId);

    const callAgyBridge = async (agyRawId: string, agyModel: string) => {
      const res = await antigravityBridge.request('POST', '/api/think-translate/translate', {
        text,
        target_lang: targetLang,
        account_id: agyRawId,
        model: agyModel,
      });
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        const detail = typeof body.detail === 'string' ? body.detail : '思考翻译失败，请检查所选账号和模型';
        throw new AppError(detail, { code: 'THINK_TRANSLATE_ERROR', statusCode: res.status || 502 });
      }
      const usedRawAcc = typeof body.account_id === 'string' && body.account_id.trim() ? body.account_id.trim() : agyRawId;
      const usedEmail = typeof body.account_email === 'string' && body.account_email.trim() ? body.account_email.trim() : usedRawAcc;
      const usedModel = typeof body.model === 'string' ? body.model.trim() : agyModel;
      const reportedModel = typeof body.reported_model === 'string' && body.reported_model.trim() ? body.reported_model.trim() : null;
      const tokens = normalizeUsageTokens(body.usage);
      const durationMs = typeof body.duration_ms === 'number' && body.duration_ms > 0 ? Math.round(body.duration_ms) : null;
      const cached = Boolean(body.cached);
      const fallbackUsed = Boolean(body.fallback_used);
      const fallbackReason = typeof body.fallback_reason === 'string' && body.fallback_reason.trim() ? body.fallback_reason.trim() : null;

      return {
        body,
        usedAccountId: usedRawAcc ? `agy:${usedRawAcc}` : accountId,
        accountLabel: usedEmail ? `agy:${usedEmail}` : 'agy:active',
        usedModel,
        reportedModel,
        tokens,
        durationMs,
        cached,
        fallbackUsed,
        fallbackReason,
      };
    };

    if (platform === 'codex') {
      if (!rawId) {
        throw new AppError('所选 Codex 翻译账号无效，请重新选择。', { code: 'THINK_TRANSLATE_ACCOUNT_NOT_FOUND', statusCode: 404 });
      }
      let primaryError: Error | null = null;
      const codexCandidates: Array<{ rawId: string; model: string; isFallback: boolean }> = [
        { rawId, model, isFallback: false },
        ...listHealthyCodexBackupIds(rawId).slice(0, 2).map(id => ({ rawId: id, model: '', isFallback: true })),
      ];

      for (const cand of codexCandidates) {
        const cd = codexAccountCooldowns.get(cand.rawId);
        if (cd && cd.untilMs > Date.now()) {
          if (!primaryError) primaryError = new AppError(cd.reason, { code: 'THINK_TRANSLATE_ERROR', statusCode: 502 });
          continue;
        }
        try {
          const res = await translateWithCodex({
            text,
            targetLang,
            accountId: `codex:${cand.rawId}`,
            rawId: cand.rawId,
            model: cand.model,
          });
          const fallbackUsed = cand.isFallback || Boolean(primaryError);
          const fallbackReason = fallbackUsed && primaryError ? primaryError.message : null;
          recordTelemetryEvent({
            timestamp: new Date().toISOString(),
            platform: 'codex',
            accountLabel: res.account_label,
            requestedModel: cand.model || null,
            reportedModel: res.reported_model,
            tokens: res.usage,
            durationMs: res.duration_ms || null,
            tokensPerSec: res.usage ? computeSpeed(res.usage.output, res.duration_ms) : null,
            cached: res.cached,
            fallbackUsed,
            fallbackReason,
            status: 'ok',
            errorMessage: null,
          });
          return {
            ...res,
            fallback_used: fallbackUsed,
            fallback_reason: fallbackReason,
          };
        } catch (err) {
          const asErr = err instanceof Error ? err : new Error(String(err));
          if (!primaryError) primaryError = asErr;
          if (!isRetryableCodexFailure(asErr.message)) break;
        }
      }

      // Cross-platform failover from Codex -> AGY if all Codex candidates failed
      try {
        const agyRes = await callAgyBridge('', '');
        const fallbackReason = primaryError ? primaryError.message : '原 Codex 翻译账号不可用';
        recordTelemetryEvent({
          timestamp: new Date().toISOString(),
          platform: 'agy',
          accountLabel: agyRes.accountLabel,
          requestedModel: agyRes.usedModel || null,
          reportedModel: agyRes.reportedModel,
          tokens: agyRes.tokens,
          durationMs: agyRes.durationMs,
          tokensPerSec: agyRes.tokens ? computeSpeed(agyRes.tokens.output, agyRes.durationMs) : null,
          cached: agyRes.cached,
          fallbackUsed: true,
          fallbackReason,
          status: 'ok',
          errorMessage: null,
        });
        return {
          ...agyRes.body,
          account_id: agyRes.usedAccountId,
          fallback_used: true,
          fallback_reason: fallbackReason,
        };
      } catch {
        recordTelemetryEvent({
          timestamp: new Date().toISOString(),
          platform: 'codex',
          accountLabel: `codex:${rawId}`,
          requestedModel: model || null,
          reportedModel: null,
          tokens: null,
          durationMs: null,
          tokensPerSec: null,
          cached: false,
          fallbackUsed: false,
          fallbackReason: null,
          status: 'error',
          errorMessage: primaryError?.message || '思考翻译失败',
        });
        throw primaryError || new AppError('思考翻译失败，请检查所选账号和模型', { code: 'THINK_TRANSLATE_ERROR', statusCode: 502 });
      }
    }

    // Default platform: Antigravity (bridge handles multi-account + lightweight-model failover internally)
    try {
      const agyRes = await callAgyBridge(rawId, model);
      recordTelemetryEvent({
        timestamp: new Date().toISOString(),
        platform: 'agy',
        accountLabel: agyRes.accountLabel,
        requestedModel: (agyRes.usedModel || model || '').trim() || null,
        reportedModel: agyRes.reportedModel,
        tokens: agyRes.tokens,
        durationMs: agyRes.durationMs,
        tokensPerSec: agyRes.tokens ? computeSpeed(agyRes.tokens.output, agyRes.durationMs) : null,
        cached: agyRes.cached,
        fallbackUsed: agyRes.fallbackUsed,
        fallbackReason: agyRes.fallbackReason,
        status: 'ok',
        errorMessage: null,
      });
      return {
        ...agyRes.body,
        account_id: agyRes.usedAccountId,
      };
    } catch (agyErr) {
      const primaryMessage = agyErr instanceof Error ? agyErr.message : 'AGY 思考翻译失败';
      // Cross-platform failover from AGY -> Codex if authorized ChatGPT accounts exist
      const codexBackups = listHealthyCodexBackupIds();
      for (const codexId of codexBackups.slice(0, 2)) {
        try {
          const codexRes = await translateWithCodex({
            text,
            targetLang,
            accountId: `codex:${codexId}`,
            rawId: codexId,
            model: '',
          });
          recordTelemetryEvent({
            timestamp: new Date().toISOString(),
            platform: 'codex',
            accountLabel: codexRes.account_label,
            requestedModel: null,
            reportedModel: codexRes.reported_model,
            tokens: codexRes.usage,
            durationMs: codexRes.duration_ms || null,
            tokensPerSec: codexRes.usage ? computeSpeed(codexRes.usage.output, codexRes.duration_ms) : null,
            cached: codexRes.cached,
            fallbackUsed: true,
            fallbackReason: primaryMessage,
            status: 'ok',
            errorMessage: null,
          });
          return {
            ...codexRes,
            fallback_used: true,
            fallback_reason: primaryMessage,
          };
        } catch {
          // Continue to next backup if available.
        }
      }

      recordTelemetryEvent({
        timestamp: new Date().toISOString(),
        platform: 'agy',
        accountLabel: rawId ? `agy:${rawId}` : 'agy:active',
        requestedModel: model || null,
        reportedModel: null,
        tokens: null,
        durationMs: null,
        tokensPerSec: null,
        cached: false,
        fallbackUsed: false,
        fallbackReason: null,
        status: 'error',
        errorMessage: primaryMessage,
      });
      throw agyErr;
    }
  },
};
