import { useCallback, useEffect, useState } from 'react';
import { api, readApiJson } from '@/shared/api';
import type { AntigravityAccount, AntigravityModel } from '@/shared/types';

export type ThinkTranslateAccount = AntigravityAccount & {
  platform?: 'agy' | 'codex';
  label?: string;
  raw_id?: string;
};

export function formatThinkTranslateAccountLabel(acc: ThinkTranslateAccount): string {
  if (acc.label && acc.label.trim()) return acc.label.trim();
  const platform = acc.platform || (acc.id.startsWith('codex:') ? 'codex' : 'agy');
  const identifier = acc.email || acc.name || acc.raw_id || acc.id.replace(/^(?:agy|codex):/, '');
  return `${platform}:${identifier}`;
}

export type ThinkTranslateConfig = {
  account_id: string;
  model: string;
  target_lang: string;
  updated_at?: string | null;
};

export type ThinkTranslateConfigResponse = ThinkTranslateConfig & {
  accounts: ThinkTranslateAccount[];
  models: AntigravityModel[];
};

type ConfigChangedPayload = {
  config: ThinkTranslateConfig;
  models?: AntigravityModel[];
};

const CONFIG_CHANGED_EVENT = 'mintcli:think-translate-config-changed';
const translationCache = new Map<string, string>();
const inFlightTranslations = new Map<string, Promise<string>>();
const MAX_CLIENT_CACHE = 200;

let latestConfigSnapshot: ThinkTranslateConfig = {
  account_id: '',
  model: '',
  target_lang: 'zh-CN',
  updated_at: null,
};

function cacheKeyFor(text: string): string {
  return `${latestConfigSnapshot.account_id}|${latestConfigSnapshot.model}|${latestConfigSnapshot.target_lang}|${text}`;
}

export function clearClientTranslationCache(): void {
  translationCache.clear();
}

export function getCachedThinkingTranslation(text: string): string | null {
  const cleaned = text.trim();
  if (!cleaned) return null;
  return translationCache.get(cacheKeyFor(cleaned)) ?? null;
}

/**
 * Heuristic used only by auto-translate: skip texts that are already predominantly Chinese
 * so we don't waste quota translating Chinese thoughts. Manual button clicks bypass this.
 */
export function shouldAutoTranslateThinking(text: string): boolean {
  const cleaned = text.trim();
  if (cleaned.length < 4) return false;
  const cjkCount = (cleaned.match(/[一-鿿]/g) || []).length;
  const latinCount = (cleaned.match(/[A-Za-z]/g) || []).length;
  if (latinCount < 8) return false;
  if (cjkCount >= 12 && cjkCount * 3 >= latinCount) return false;
  return true;
}

export async function translateThinkingText(text: string): Promise<string> {
  const cleaned = text.trim();
  if (!cleaned) return '';

  const key = cacheKeyFor(cleaned);
  const cached = translationCache.get(key);
  if (cached !== undefined) return cached;

  const existing = inFlightTranslations.get(key);
  if (existing) return existing;

  const promise = (async () => {
    const res = await api.antigravity.translateThinking({ text: cleaned });
    const data = await readApiJson<{ ok?: boolean; translated?: string; detail?: string; error?: string }>(res);
    if (!res.ok || !data?.translated) {
      throw new Error(data?.detail || data?.error || '思考翻译失败，请检查所选账号和模型');
    }
    if (translationCache.size >= MAX_CLIENT_CACHE) {
      const oldestKey = translationCache.keys().next().value;
      if (oldestKey !== undefined) translationCache.delete(oldestKey);
    }
    translationCache.set(key, data.translated);
    return data.translated;
  })();

  inFlightTranslations.set(key, promise);
  try {
    return await promise;
  } finally {
    inFlightTranslations.delete(key);
  }
}

export function useThinkTranslateConfig(enabled = true, eagerCatalog = false) {
  const [config, setConfig] = useState<ThinkTranslateConfig>(latestConfigSnapshot);
  const [accounts, setAccounts] = useState<ThinkTranslateAccount[]>([]);
  const [models, setModels] = useState<AntigravityModel[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (opts?: { lite?: boolean }) => {
    const isLite = Boolean(opts?.lite);
    if (!isLite) setLoading(true);
    try {
      const res = await api.antigravity.thinkTranslateConfig(isLite ? { lite: true } : undefined);
      if (!res.ok) return;
      const data = await readApiJson<ThinkTranslateConfigResponse>(res);
      const nextCfg: ThinkTranslateConfig = {
        account_id: data.account_id || '',
        model: data.model || '',
        target_lang: data.target_lang || 'zh-CN',
        updated_at: data.updated_at ?? null,
      };
      latestConfigSnapshot = nextCfg;
      setConfig(nextCfg);
      if (!isLite) {
        setAccounts(Array.isArray(data.accounts) ? data.accounts : []);
        setModels(Array.isArray(data.models) ? data.models : []);
      }
      setError(null);
    } catch {
      // Non-fatal while bridge starts up.
    } finally {
      if (!isLite) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void refresh({ lite: !eagerCatalog });
  }, [eagerCatalog, enabled, refresh]);

  useEffect(() => {
    const onChanged = (event: Event) => {
      const detail = (event as CustomEvent<ConfigChangedPayload>).detail;
      if (detail?.config) {
        latestConfigSnapshot = detail.config;
        setConfig(detail.config);
      }
      if (Array.isArray(detail?.models)) {
        setModels(detail.models);
      }
    };
    window.addEventListener(CONFIG_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(CONFIG_CHANGED_EVENT, onChanged);
  }, []);

  const saveConfig = useCallback(
    async (patch: Partial<Pick<ThinkTranslateConfig, 'account_id' | 'model' | 'target_lang'>>) => {
      setSaving(true);
      setMessage(null);
      setError(null);
      try {
        const res = await api.antigravity.saveThinkTranslateConfig(patch);
        const data = await readApiJson<ThinkTranslateConfig & { ok?: boolean; detail?: string; models?: AntigravityModel[] }>(res);
        if (!res.ok) {
          throw new Error(data?.detail || '保存翻译配置失败');
        }
        const nextCfg: ThinkTranslateConfig = {
          account_id: data.account_id || '',
          model: data.model || '',
          target_lang: data.target_lang || 'zh-CN',
          updated_at: data.updated_at ?? null,
        };
        const nextModels = Array.isArray(data.models) ? data.models : undefined;
        latestConfigSnapshot = nextCfg;
        clearClientTranslationCache();
        setConfig(nextCfg);
        if (nextModels !== undefined) {
          setModels(nextModels);
        }
        setMessage('已保存，后续翻译将一直使用所选账号和模型');
        window.dispatchEvent(new CustomEvent<ConfigChangedPayload>(CONFIG_CHANGED_EVENT, {
          detail: { config: nextCfg, models: nextModels },
        }));
      } catch (err) {
        setError(err instanceof Error ? err.message : '保存翻译配置失败');
      } finally {
        setSaving(false);
      }
    },
    [],
  );

  return {
    config,
    accounts,
    models,
    loading,
    saving,
    message,
    error,
    refresh,
    saveConfig,
  };
}
