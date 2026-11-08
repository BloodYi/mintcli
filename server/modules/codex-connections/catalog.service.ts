import { egressFetch } from '@/modules/egress/index.js';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { ProviderModelsDefinition, ProviderModelOption } from '@/shared/types.js';
import { AppError, readCodexVersion } from '@/shared/index.js';
import { refreshOfficialAccount } from './quota.service.js';

const pending = new Map<string, { fingerprint: string; expires: number; value: Promise<ProviderModelsDefinition> }>();
const authError = () => new AppError('此账号的官方授权已失效，请在账号管理中重新授权。', { code: 'CODEX_REAUTH_REQUIRED', statusCode: 409 });

/** Used by connections and provider adapters; catalog is live, scoped to one credential home and never merged with bundled defaults. */
export async function readOfficialCatalog(home: string, env: Record<string, string>): Promise<ProviderModelsDefinition> {
  const loadAuth = async () => {
    try { return JSON.parse(await readFile(path.join(home, 'auth.json'), 'utf8')) as { tokens?: { access_token?: string; account_id?: string } }; }
    catch { throw authError(); }
  };
  const auth = await loadAuth();
  const token = auth.tokens?.access_token;
  if (!token) throw authError();
  const fingerprint = createHash('sha256').update(token).digest('hex');
  const cached = pending.get(home);
  if (cached && cached.fingerprint === fingerprint && cached.expires > Date.now()) return cached.value;
  const value = (async () => {
    const request = async (tokens: NonNullable<typeof auth.tokens>) => egressFetch('codex', env)(`https://chatgpt.com/backend-api/codex/models?client_version=${encodeURIComponent(readCodexVersion())}`, {
      headers: { Authorization: `Bearer ${tokens.access_token}`, ...(tokens.account_id ? { 'ChatGPT-Account-Id': tokens.account_id } : {}), originator: 'codex_cli_rs' },
      redirect: 'error', signal: AbortSignal.timeout(20000),
    });
    let response = await request(auth.tokens!);
    if (response.status === 401 && await refreshOfficialAccount(env)) response = await request((await loadAuth()).tokens!);
    if (response.status === 401) throw authError();
    if (!response.ok) throw new AppError(`官方模型目录暂时无法读取（HTTP ${response.status}），请稍后刷新。`, { code: 'CODEX_CATALOG_UNAVAILABLE', statusCode: 502 });
    const data = await response.json() as { models?: Record<string, unknown>[] };
    if (!Array.isArray(data.models)) throw new AppError('官方没有返回有效模型目录。', { code: 'CODEX_CATALOG_UNAVAILABLE', statusCode: 502 });
    const options: ProviderModelOption[] = [];
    const seen = new Set<string>();
    for (const row of data.models) {
      if (row.visibility !== 'list' || row.hidden === true || row.disabled === true || typeof row.slug !== 'string' || !row.slug || seen.has(row.slug)) continue;
      if (typeof row.shutdown_date === 'string' && Date.parse(row.shutdown_date) <= Date.now()) continue;
      seen.add(row.slug);
      const levels = Array.isArray(row.supported_reasoning_levels) ? row.supported_reasoning_levels as { effort?: unknown; description?: unknown }[] : [];
      const values = levels.filter(x => typeof x.effort === 'string').map(x => ({ value: x.effort as string, ...(typeof x.description === 'string' ? { description: x.description } : {}) }));
      options.push({ value: row.slug, label: typeof row.display_name === 'string' ? row.display_name : row.slug,
        ...(typeof row.description === 'string' ? { description: row.description } : {}),
        ...(values.length ? { effort: { ...(typeof row.default_reasoning_level === 'string' && values.some(x => x.value === row.default_reasoning_level) ? { default: row.default_reasoning_level } : {}), values } } : {}) });
    }
    return { OPTIONS: options, DEFAULT: options[0]?.value || '', ACCOUNT_SCOPED: true };
  })().catch(error => {
    pending.delete(home);
    if (error instanceof AppError) throw error;
    throw new AppError('官方模型目录读取失败，请稍后刷新。', { code: 'CODEX_CATALOG_UNAVAILABLE', statusCode: 502 });
  });
  pending.set(home, { fingerprint, expires: Date.now() + 30000, value });
  return value;
}
