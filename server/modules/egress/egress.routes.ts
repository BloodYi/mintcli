import { Router } from 'express';
import { AppError, asyncHandler } from '@/shared/index.js';
import { egressService, validEgressTarget } from './egress.service.js';

/** Mounted by the server entrypoint behind its existing authentication middleware. */
export const egressRoutes = Router();
egressRoutes.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
egressRoutes.get('/', (_req, res) => { res.json(egressService.status()); });
egressRoutes.put('/', asyncHandler(async (req, res) => {
  if (!validEgressTarget(req.body?.target) || typeof req.body?.nodeId !== 'string') throw new AppError('节点选择格式无效', { statusCode: 400, code: 'INVALID_EGRESS' });
  res.json(egressService.save(req.body.target, req.body.nodeId));
}));
egressRoutes.post('/probe', asyncHandler(async (req, res) => {
  if (typeof req.body?.nodeId !== 'string') throw new AppError('请选择检测节点', { statusCode: 400, code: 'INVALID_EGRESS' });
  res.json(await egressService.probe(req.body.nodeId));
}));
egressRoutes.post('/sync', asyncHandler(async (_req, res) => { res.json(await egressService.sync()); }));
