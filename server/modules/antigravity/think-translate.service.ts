import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { antigravityBridge } from './antigravity.service.js';
import { connectionService, getCodexModelCatalog, resolveCodexConnection } from '@/modules/codex-connections/index.js';
import { AppError, resolveManagedCli } from '@/shared/index.js';

export type ThinkTranslatePlatform = 'agy' | 'codex';

export type ThinkTranslateAccountOption = {
  id: string;
  raw_id: string;
  platform: ThinkTranslatePlatform;
  email: string;
  name: string;
  label: string;
  active: boolean;
  subscription_tier?: string;
};

export type ThinkTranslateModelOption = {
  id: string;
  name: string;
};

export type ThinkTranslateConfigData = {
  account_id: string;
  model: string;
  target_lang: string;
  updated_at: string | null;
};

const DEFAULT_TARGET_LANG = 'zh-CN';
const MAX_TEXT_CHARS = 32000;
const MAX_CACHE_ENTRIES = 256;
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

const codexCache = new Map<string, string>();
let activeCodexJobs = 0;
const codexWaitQueue: Array<() => void> = [];

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

function configFilePath(): string {
  const root = process.env.AGENT_CONNECTIONS_ROOT || path.join(os.homedir(), 'unified');
  return path.join(root, 'think-translate.json');
}

function normalizeTargetLang(lang?: string | null): string {
  const cleaned = typeof lang === 'string' ? lang.trim() : '';
  return cleaned || DEFAULT_TARGET_LANG;
}

export function normalizeThinkTranslateAccountId(raw?: string | null): string {
  const cleaned = typeof raw === 'string' ? raw.trim() : '';
  if (!cleaned) return '';
  if (cleaned.startsWith('agy:') || cleaned.startsWith('codex:')) return cleaned;
  // Legacy unprefixed account_id values came from Antigravity bridge.
  return `agy:${cleaned}`;
}

export function parseThinkTranslateAccountId(accountId: string): { platform: ThinkTranslatePlatform; rawId: string } {
  const normalized = normalizeThinkTranslateAccountId(accountId);
  if (!normalized) return { platform: 'agy', rawId: '' };
  if (normalized.startsWith('codex:')) return { platform: 'codex', rawId: normalized.slice(6) };
  if (normalized.startsWith('agy:')) return { platform: 'agy', rawId: normalized.slice(4) };
  return { platform: 'agy', rawId: normalized };
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

export async function listThinkTranslateAccounts(): Promise<ThinkTranslateAccountOption[]> {
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
        accounts.push({
          id: `agy:${rawId}`,
          raw_id: rawId,
          platform: 'agy',
          email,
          name,
          label: `agy:${identifier}`,
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
      accounts.push({
        id: `codex:${rawId}`,
        raw_id: rawId,
        platform: 'codex',
        email,
        name,
        label: `codex:${identifier}`,
        active: item.id === codexList.activeId,
        ...(item.subscriptionTier ? { subscription_tier: item.subscriptionTier } : {}),
      });
    }
  } catch {
    // Non-fatal if codex store is unavailable.
  }

  return accounts;
}

export async function listThinkTranslateModels(accountId: string): Promise<ThinkTranslateModelOption[]> {
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

async function translateWithCodex(params: {
  text: string;
  targetLang: string;
  accountId: string;
  rawId: string;
  model: string;
}): Promise<{ ok: true; translated: string; account_id: string; model: string; target_lang: string; cached: boolean }> {
  const cleaned = params.text.trim().slice(0, MAX_TEXT_CHARS);
  if (!cleaned) {
    return {
      ok: true,
      translated: '',
      account_id: params.accountId,
      model: params.model,
      target_lang: params.targetLang,
      cached: false,
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
      translated: cached,
      account_id: params.accountId,
      model: params.model,
      target_lang: params.targetLang,
      cached: true,
    };
  }

  const conn = resolveCodexConnection(params.rawId);
  const codexBin = resolveManagedCli('codex') || 'codex';
  const prompt = buildTranslationPrompt(cleaned, params.targetLang);

  await acquireCodexSlot();
  try {
    const cachedAfterWait = codexCache.get(cacheKey);
    if (cachedAfterWait !== undefined) {
      return {
        ok: true,
        translated: cachedAfterWait,
        account_id: params.accountId,
        model: params.model,
        target_lang: params.targetLang,
        cached: true,
      };
    }

    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'codex-translate-'));
    const outFile = path.join(tmpDir, 'last-message.txt');
    try {
      const args = [
        'exec',
        '--ephemeral',
        '--skip-git-repo-check',
        '--sandbox', 'read-only',
        '--ignore-user-config',
        '--ignore-rules',
        '--color', 'never',
        '-o', outFile,
      ];
      if (params.model && params.model !== 'default') {
        args.push('-m', params.model);
      }
      args.push('-');

      const { exitCode, stderr } = await new Promise<{ exitCode: number | null; stderr: string }>((resolve, reject) => {
        const child = spawn(codexBin, args, {
          cwd: tmpDir,
          env: conn.env,
          stdio: ['pipe', 'ignore', 'pipe'],
        });
        let stderrBuf = '';
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
          resolve({ exitCode: code, stderr: stderrBuf.trim() });
        });
        child.stdin.end(prompt, 'utf8');
      });

      let translated = '';
      try {
        translated = (await fsp.readFile(outFile, 'utf8')).trim();
      } catch {
        translated = '';
      }
      if (!translated) {
        const detail = stderr.split('\n').filter(Boolean).pop() || `exit code ${exitCode}`;
        throw new AppError(`Codex 翻译失败：${detail.slice(0, 240)}`, { code: 'THINK_TRANSLATE_ERROR', statusCode: 502 });
      }

      codexCache.set(cacheKey, translated);
      while (codexCache.size > MAX_CACHE_ENTRIES) {
        const oldest = codexCache.keys().next().value;
        if (oldest === undefined) break;
        codexCache.delete(oldest);
      }
      return {
        ok: true,
        translated,
        account_id: params.accountId,
        model: params.model,
        target_lang: params.targetLang,
        cached: false,
      };
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  } finally {
    releaseCodexSlot();
  }
}

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

    // If the user switched accounts and did not explicitly specify a new model,
    // reset a model that is not available on the newly selected account.
    if (accountChanged && patch.model === undefined && next.model && models.length > 0) {
      if (!models.some(m => m.id === next.model)) {
        next.model = '';
      }
    }

    next.updated_at = new Date().toISOString();
    writeStoredConfig(next);
    codexCache.clear();

    return {
      ok: true,
      ...next,
      models,
    };
  },

  async translate(input: { text?: string; target_lang?: string; account_id?: string; model?: string }) {
    const text = typeof input.text === 'string' ? input.text : '';
    const cfg = await loadConfigWithLegacyFallback();
    const accountId = input.account_id !== undefined
      ? normalizeThinkTranslateAccountId(input.account_id)
      : cfg.account_id;
    const model = input.model !== undefined ? String(input.model || '').trim() : cfg.model;
    const targetLang = normalizeTargetLang(input.target_lang !== undefined ? input.target_lang : cfg.target_lang);

    const { platform, rawId } = parseThinkTranslateAccountId(accountId);
    if (platform === 'codex') {
      if (!rawId) {
        throw new AppError('所选 Codex 翻译账号无效，请重新选择。', { code: 'THINK_TRANSLATE_ACCOUNT_NOT_FOUND', statusCode: 404 });
      }
      return translateWithCodex({ text, targetLang, accountId, rawId, model });
    }

    const res = await antigravityBridge.request('POST', '/api/think-translate/translate', {
      text,
      target_lang: targetLang,
      account_id: rawId,
      model,
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const detail = typeof body.detail === 'string' ? body.detail : '思考翻译失败，请检查所选账号和模型';
      throw new AppError(detail, { code: 'THINK_TRANSLATE_ERROR', statusCode: res.status || 502 });
    }
    return {
      ...body,
      account_id: accountId,
    };
  },
};
