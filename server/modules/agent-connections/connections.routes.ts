import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { connectionService } from '@/modules/codex-connections/index.js';
import { claudeAccounts } from '@/modules/claude-accounts/index.js';
import { antigravityBridge } from '@/modules/antigravity/index.js';
import { antigravityQuotaSnapshot } from './antigravity-quota.service.js';
import { asyncHandler, AppError } from '@/shared/index.js';
import type { AnyRecord } from '@/shared/types.js';

const router = express.Router();
const selectionFile = () => path.join(process.env.AGENT_CONNECTIONS_ROOT || path.join(os.homedir(), 'unified'), 'selection.json');
function savedSelection(): string { try { return JSON.parse(fs.readFileSync(selectionFile(), 'utf8')).activeId || ''; } catch { return ''; } }
function remember(id: string) { fs.mkdirSync(path.dirname(selectionFile()), { recursive: true, mode: 0o700 }); const temp = selectionFile() + '.tmp'; fs.writeFileSync(temp, JSON.stringify({ activeId: id }), { mode: 0o600 }); fs.renameSync(temp, selectionFile()); }
function parse(id: string) { const index = id.indexOf(':'); const provider = id.slice(0, index), account = id.slice(index + 1); if (!['codex', 'claude', 'antigravity'].includes(provider) || !account || /[\\/\x00-\x1f]/.test(account)) throw new AppError('账号选择无效', { code: 'INVALID_ACCOUNT', statusCode: 400 }); return { provider, account }; }
async function nativeJson(response: Response): Promise<AnyRecord> { const body = await response.json() as AnyRecord; if (!response.ok) throw new AppError(body.detail || 'agy 操作失败', { code: 'AGY_ACCOUNT_ERROR', statusCode: response.status }); return body; }
async function catalog() {
  const codex = connectionService.list(); const claude = claudeAccounts.list();
  let agy: AnyRecord = { accounts: [] }, warning = '';
  try { agy = await nativeJson(await antigravityBridge.request('GET', '/api/accounts')); } catch { warning = 'agy 账号暂时无法读取，请稍后刷新'; }
  const connections = [
    ...codex.connections.map(item => ({ ...item, id: 'codex:' + item.id, accountId: item.id, provider: 'codex', current: item.id === codex.activeId })),
    ...claude.accounts.map(item => ({ ...item, id: 'claude:' + item.id, accountId: item.id, current: item.id === claude.activeId })),
    ...(agy.accounts || []).map((item: AnyRecord) => ({ id: 'antigravity:' + item.id, accountId: item.id, provider: 'antigravity', kind: 'antigravity', name: item.name || item.email || 'agy 账号', email: item.email, authorized: true, current: item.active })),
  ];
  const stored = savedSelection();
  const activeId = connections.some(item => item.id === stored) ? stored : 'codex:' + codex.activeId;
  return { connections, activeId, warning };
}
router.get('/', asyncHandler(async (_req, res) => { res.json(await catalog()); }));
router.post('/:id/select', asyncHandler(async (req, res) => {
  const id = String(req.params.id), { provider, account } = parse(id);
  if (provider === 'codex') connectionService.select(account);
  if (provider === 'claude') claudeAccounts.select(account);
  if (provider === 'antigravity') await nativeJson(await antigravityBridge.switchAccount({ id: account }));
  remember(id); res.json(await catalog());
}));
router.get('/:id/quota', asyncHandler(async (req, res) => {
  const id = String(req.params.id), { provider, account } = parse(id);
  let value: AnyRecord;
  if (provider === 'codex') value = await connectionService.quota(account);
  else if (provider === 'claude') value = await claudeAccounts.quota(account, req.query.force === 'true');
  else {
    const quota = await nativeJson(await antigravityBridge.quotaForAccount(account, req.query.force === 'true'));
    value = antigravityQuotaSnapshot({ timestamp: quota.timestamp, quotas: quota.quotas });
  }
  res.json({ ...value, connectionId: id });
}));
router.post('/claude/accounts', asyncHandler(async (req, res) => { res.json(claudeAccounts.save(req.body || {})); }));
router.delete('/claude/accounts/:id', asyncHandler(async (req, res) => { res.json(claudeAccounts.remove(String(req.params.id))); }));
router.get('/claude/accounts/:id/login', asyncHandler(async (req, res) => { res.json(claudeAccounts.loginStatus(String(req.params.id))); }));
router.post('/claude/accounts/:id/login', asyncHandler(async (req, res) => { res.json(claudeAccounts.startLogin(String(req.params.id))); }));
router.post('/claude/accounts/:id/login/code', asyncHandler(async (req, res) => { res.json(claudeAccounts.submitCode(String(req.params.id), req.body.code)); }));
router.delete('/claude/accounts/:id/login', asyncHandler(async (req, res) => { res.json(claudeAccounts.cancelLogin(String(req.params.id))); }));
/** JWT-protected account selector used by the single chat composer and manager. */
export const agentConnectionsRoutes = router;
