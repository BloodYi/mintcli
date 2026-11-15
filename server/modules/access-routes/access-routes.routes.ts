import { Router } from 'express';

import { asyncHandler } from '@/shared/index.js';

import { accessRouteStatus } from './access-routes.service.js';

/** Mounted by the server entrypoint behind its existing authentication middleware. */
export const accessRoutes = Router();
accessRoutes.get('/', asyncHandler(async (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(accessRouteStatus());
}));
