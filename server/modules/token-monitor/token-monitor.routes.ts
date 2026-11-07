import { Router } from 'express';
import type { AnyRecord } from '@/shared/index.js';
import { AppError, asyncHandler } from '@/shared/index.js';
import { monitorUpdateTaskService } from './update-task.service.js';
import { tokenMonitorService } from './token-monitor.service.js';

/** Used by the server entrypoint for session monitoring, release checks and user-triggered update tasks. */
export const tokenMonitorRoutes = Router();
tokenMonitorRoutes.get('/updates', asyncHandler(async (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(await tokenMonitorService.updates());
}));
tokenMonitorRoutes.get('/sessions', asyncHandler(async (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(await tokenMonitorService.sessions());
}));
tokenMonitorRoutes.get('/sessions/:sessionId', asyncHandler(async (req, res) => {
  const sessionId = req.params.sessionId;
  if (typeof sessionId !== 'string' || !/^[a-zA-Z0-9._-]{1,120}$/.test(sessionId)) {
    throw new AppError('Invalid session id', { code: 'INVALID_SESSION_ID', statusCode: 400 });
  }
  res.setHeader('Cache-Control', 'no-store');
  res.json(await tokenMonitorService.snapshot(sessionId));
}));

tokenMonitorRoutes.get('/update-task', asyncHandler(async (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ task: await monitorUpdateTaskService.status() });
}));
tokenMonitorRoutes.post('/update-task', asyncHandler(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const user = (req as typeof req & { user?: AnyRecord }).user;
  res.status(202).json({ task: await monitorUpdateTaskService.start(user?.id ?? user?.userId ?? null) });
}));
