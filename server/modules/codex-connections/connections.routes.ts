import express from 'express';
import { AppError, asyncHandler } from '@/shared/index.js';
import type { ApiProtocol } from '@/shared/types.js';
import { connectionService } from './connections.service.js';

const router = express.Router();
router.get('/', (_req, res) => res.json(connectionService.list()));
router.post('/', asyncHandler(async (req, res) => { res.json(await connectionService.save(req.body || {})); }));
router.post('/models', asyncHandler(async (req, res) => {
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.baseUrl !== 'string'
    || (body.id !== undefined && (typeof body.id !== 'string' || !body.id || body.id.length > 120))
    || (body.apiKey !== undefined && typeof body.apiKey !== 'string')
    || (body.protocol !== undefined && !['responses', 'anthropic', 'gemini', 'chat_completions'].includes(body.protocol))) {
    throw new AppError('模型请求格式不正确', { code: 'INVALID_MODEL_REQUEST', statusCode: 400 });
  }
  res.json(await connectionService.discoverModels({ id: body.id, baseUrl: body.baseUrl, apiKey: body.apiKey, ...(body.protocol ? { protocol: body.protocol as ApiProtocol } : {}) }));
}));
router.post('/:id/select', asyncHandler(async (req, res) => { res.json(connectionService.select(String(req.params.id))); }));
router.delete('/:id', asyncHandler(async (req, res) => { res.json(connectionService.remove(String(req.params.id))); }));
router.get('/:id/login', asyncHandler(async (req, res) => { res.json(connectionService.loginStatus(String(req.params.id))); }));
router.post('/:id/login', asyncHandler(async (req, res) => { const method = req.body?.method ?? 'device'; if (!['browser', 'device'].includes(method)) throw new AppError('授权方式无效', { code: 'INVALID_LOGIN_METHOD', statusCode: 400 }); res.json(await connectionService.startLogin(String(req.params.id), method)); }));
router.post('/:id/login/code', asyncHandler(async (req, res) => { res.json(await connectionService.submitLoginCode(String(req.params.id), req.body?.code)); }));
router.delete('/:id/login', asyncHandler(async (req, res) => { res.json(connectionService.cancelLogin(String(req.params.id))); }));
router.get('/:id/quota', asyncHandler(async (req, res) => { res.json(await connectionService.quota(String(req.params.id))); }));
router.post('/:id/reset', asyncHandler(async (req, res) => {
  const body = req.body;
  if (!body || body.confirmed !== true || typeof body.idempotencyKey !== 'string'
    || (body.creditId !== undefined && typeof body.creditId !== 'string')) {
    throw new AppError('请确认使用重置卡后重试', { code: 'INVALID_RESET_REQUEST', statusCode: 400 });
  }
  res.json(await connectionService.consumeReset(String(req.params.id), body.idempotencyKey, body.creditId));
}));
router.get('/:id/models', asyncHandler(async (req, res) => { res.json(await connectionService.models(String(req.params.id))); }));

/** Mounted by the server entrypoint behind native CloudCLI JWT authentication. */
export const codexConnectionsRoutes = router;
