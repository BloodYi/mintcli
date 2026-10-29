import { Router } from 'express';
import { AppError, asyncHandler, createApiSuccessResponse } from '@/shared/index.js';
import { tokenMonitorService } from './token-monitor.service.js';

/** Used by the server entrypoint for read-only session monitoring and release checks. */
export const tokenMonitorRoutes = Router();
tokenMonitorRoutes.get('/updates', asyncHandler(async (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(createApiSuccessResponse(await tokenMonitorService.updates()));
}));
tokenMonitorRoutes.get('/sessions/:sessionId', asyncHandler(async (req, res) => {
  const sessionId = req.params.sessionId;
  if (typeof sessionId !== 'string' || !/^[a-zA-Z0-9._-]{1,120}$/.test(sessionId)) {
    throw new AppError('Invalid session id', { code: 'INVALID_SESSION_ID', statusCode: 400 });
  }
  res.setHeader('Cache-Control', 'no-store');
  res.json(createApiSuccessResponse(await tokenMonitorService.snapshot(sessionId)));
}));
