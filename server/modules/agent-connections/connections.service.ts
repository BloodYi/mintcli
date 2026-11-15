import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { connectionService } from '@/modules/codex-connections/index.js';
import { claudeAccounts } from '@/modules/claude-accounts/index.js';
import { antigravityBridge } from '@/modules/antigravity/index.js';
import { antigravityQuotaSnapshot } from './antigravity-quota.service.js';
import { AppError } from '@/shared/index.js';
import { sessionsService } from '@/modules/providers/index.js';
import type { AnyRecord, LLMProvider } from '@/shared/types.js';

import { cliAccounts } from './cli-accounts.service.js';
const selectionFile = () => path.join(process.env.AGENT_CONNECTIONS_ROOT || path.join(os.homedir(), 'unified'), 'selection.json');
function savedSelection(): string { try { return JSON.parse(fs.readFileSync(selectionFile(), 'utf8')).activeId || ''; } catch { return ''; } }
function remember(id: string) { fs.mkdirSync(path.dirname(selectionFile()), { recursive: true, mode: 0o700 }); const temp = selectionFile() + '.tmp'; fs.writeFileSync(temp, JSON.stringify({ activeId: id }), { mode: 0o600 }); fs.renameSync(temp, selectionFile()); }
function parse(id: string) {
  const index = id.indexOf(':');
  let provider = id.slice(0, index);
  const account = id.slice(index + 1);
  if (!['api', 'codex', 'claude', 'antigravity', 'cursor', 'opencode'].includes(provider) || !account || /[\\/\x00-\x1f]/.test(account)) throw new AppError('账号选择无效', { code: 'INVALID_ACCOUNT', statusCode: 400 });
  // Accept old codex:<api-id> bookmarks while resolving the API's actual engine.
  const api = ['api', 'codex'].includes(provider) ? connectionService.list().connections.find(item => item.id === account && item.kind === 'api') : undefined;
  if (provider === 'api' && !api) throw new AppError('API 账号不存在', { code: 'INVALID_ACCOUNT', statusCode: 404 });
  if (api) provider = api.agent === 'chat' ? 'codex' : api.agent;
  if (['cursor', 'opencode'].includes(provider)) cliAccounts.validate(provider, account);
  return { provider, account, api: Boolean(api) };
}
async function nativeJson(response: Response): Promise<AnyRecord> { const body = await response.json() as AnyRecord; if (!response.ok) throw new AppError(body.detail || 'agy 操作失败', { code: 'AGY_ACCOUNT_ERROR', statusCode: response.status }); return body; }
async function catalog(force = false) {
  const codex = connectionService.list(); const claude = claudeAccounts.list();
  let agy: AnyRecord = { accounts: [] }, warning = '';
  try { agy = await nativeJson(await antigravityBridge.request('GET', '/api/accounts')); } catch { warning = 'agy 账号暂时无法读取，请稍后刷新'; }
  const connections = [
    ...await cliAccounts.list(force),
    ...codex.connections.map(item => {
      const api = item.kind === 'api';
      const provider = api && item.agent !== 'chat' ? item.agent : 'codex';
      return { ...item, id: (api ? 'api:' : 'codex:') + item.id, accountId: (api ? 'api:' : '') + item.id, provider,
        current: ['claude', 'antigravity'].includes(provider) ? codex.apiSelections[provider as 'claude' | 'antigravity'] === item.id : item.id === codex.activeId };
    }),
    ...claude.accounts.map(item => ({ ...item, id: 'claude:' + item.id, accountId: item.id, current: !codex.apiSelections.claude && item.id === claude.activeId })),
    ...(agy.accounts || []).map((item: AnyRecord) => ({ id: 'antigravity:' + item.id, accountId: item.id, provider: 'antigravity', kind: 'antigravity', name: item.name || item.email || 'agy 账号', email: item.email, authorized: true, current: !codex.apiSelections.antigravity && item.active })),
  ];
  let stored = savedSelection();
  if (stored.startsWith('codex:') && codex.connections.some(item => item.kind === 'api' && item.id === stored.slice(6))) stored = 'api:' + stored.slice(6);
  const fallback = codex.connections.find(item => item.id === codex.activeId);
  const activeId = connections.some(item => item.id === stored) ? stored : (fallback?.kind === 'api' ? 'api:' : 'codex:') + codex.activeId;
  return { connections, activeId, warning };
}

/** Used by authenticated routes to keep account selection and quotas outside transport handlers. */
export const agentConnectionsService = {
  catalog,
  async select(id: string, sessionId?: string) {
    const { provider, account, api } = parse(id);
    const selectAccount = async () => {
      if (api || provider === 'codex') connectionService.select(account);
      else if (provider === 'claude') { claudeAccounts.select(account); connectionService.useNativeAgent('claude'); }
      else if (provider === 'antigravity') { await nativeJson(await antigravityBridge.switchAccount({ id: account })); connectionService.useNativeAgent('antigravity'); }
      remember(api ? 'api:' + account : id);
    };
    if (sessionId) await sessionsService.switchSessionProvider(sessionId, provider as LLMProvider, selectAccount);
    else await selectAccount();
    return catalog();
  },
  async quota(id: string, force: boolean) {
    const { provider, account, api } = parse(id);
    if (provider === 'cursor' || provider === 'opencode') return cliAccounts.quota(provider, force);
    let value: AnyRecord;
    if (api || provider === 'codex') value = await connectionService.quota(account);
    else if (provider === 'claude') value = await claudeAccounts.quota(account, force);
    else {
      const quota = await nativeJson(await antigravityBridge.quotaForAccount(account, force));
      value = antigravityQuotaSnapshot({ timestamp: quota.timestamp, quotas: quota.quotas });
    }
    return { ...value, connectionId: id };
  },
};
