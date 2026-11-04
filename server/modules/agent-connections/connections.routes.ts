import express from 'express';
import { claudeAccounts } from '@/modules/claude-accounts/index.js';
import { AppError, asyncHandler } from '@/shared/index.js';
import { officialLoginService } from './official-login.service.js';
import type { LLMProvider } from '@/shared/types.js';
import { agentConnectionsService } from './connections.service.js';

const router = express.Router();
router.post('/official-logins', asyncHandler(async (req, res) => {
  const provider = req.body?.provider;
  const name = req.body?.name ?? '';
  if (!['cursor', 'opencode', 'antigravity'].includes(provider) || typeof name !== 'string' || name.length > 80) throw new AppError('官方账号类型或名称无效', { code: 'INVALID_ACCOUNT_LOGIN', statusCode: 400 });
  res.json(await officialLoginService.start(provider as LLMProvider, name.trim()));
}));
router.get('/official-logins/:flowId', asyncHandler(async (req, res) => { res.json(officialLoginService.status(String(req.params.flowId))); }));
router.post('/official-logins/:flowId/code', asyncHandler(async (req, res) => { res.json(officialLoginService.submit(String(req.params.flowId), req.body?.code)); }));
router.delete('/official-logins/:flowId', asyncHandler(async (req, res) => { res.json(officialLoginService.cancel(String(req.params.flowId))); }));

router.get('/', asyncHandler(async (_req, res) => { res.json(await agentConnectionsService.catalog(_req.query.refresh === 'true')); }));
router.post('/:id/select', asyncHandler(async (req, res) => {
  const sessionId = req.body?.sessionId;
  if (sessionId !== undefined && (typeof sessionId !== 'string' || !sessionId.trim())) {
    throw new AppError('sessionId 必须是非空字符串', { code: 'INVALID_SESSION_ID', statusCode: 400 });
  }
  res.json(await agentConnectionsService.select(String(req.params.id), sessionId?.trim()));
}));
router.get('/:id/quota', asyncHandler(async (req, res) => { res.json(await agentConnectionsService.quota(String(req.params.id), req.query.force === 'true')); }));
router.post('/claude/accounts', asyncHandler(async (req, res) => { res.json(claudeAccounts.save(req.body || {})); }));
router.delete('/claude/accounts/:id', asyncHandler(async (req, res) => { res.json(claudeAccounts.remove(String(req.params.id))); }));
router.get('/claude/accounts/:id/login', asyncHandler(async (req, res) => { res.json(claudeAccounts.loginStatus(String(req.params.id))); }));
router.post('/claude/accounts/:id/login', asyncHandler(async (req, res) => { res.json(claudeAccounts.startLogin(String(req.params.id))); }));
router.post('/claude/accounts/:id/login/code', asyncHandler(async (req, res) => { res.json(claudeAccounts.submitCode(String(req.params.id), req.body.code)); }));
router.delete('/claude/accounts/:id/login', asyncHandler(async (req, res) => { res.json(claudeAccounts.cancelLogin(String(req.params.id))); }));
/** JWT-protected account selector used by the single chat composer and manager. */
export const agentConnectionsRoutes = router;
