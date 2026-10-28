import express from 'express';
import { asyncHandler } from '@/shared/index.js';
import { connectionService } from './connections.service.js';

const router = express.Router();
router.get('/', (_req, res) => res.json(connectionService.list()));
router.post('/', asyncHandler(async (req, res) => { res.json(await connectionService.save(req.body || {})); }));
router.post('/:id/select', asyncHandler(async (req, res) => { res.json(connectionService.select(String(req.params.id))); }));
router.delete('/:id', asyncHandler(async (req, res) => { res.json(connectionService.remove(String(req.params.id))); }));
router.get('/:id/login', asyncHandler(async (req, res) => { res.json(connectionService.loginStatus(String(req.params.id))); }));
router.post('/:id/login', asyncHandler(async (req, res) => { res.json(connectionService.startLogin(String(req.params.id))); }));
router.delete('/:id/login', asyncHandler(async (req, res) => { res.json(connectionService.cancelLogin(String(req.params.id))); }));
router.get('/:id/quota', asyncHandler(async (req, res) => { res.json(await connectionService.quota(String(req.params.id))); }));
router.get('/:id/models', asyncHandler(async (req, res) => { res.json(await connectionService.models(String(req.params.id))); }));

/** Mounted by the server entrypoint behind native CloudCLI JWT authentication. */
export const codexConnectionsRoutes = router;
