import { Router } from 'express';
import { AppError, asyncHandler } from '@/shared/index.js';
import { githubService } from './github.service.js';

/** Used by the server entrypoint to mount per-user login and explicit project uploads. */
export function createGithubRouter(service = githubService) {
  const router = Router();
  router.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    const id = Number((req as typeof req & { user?: { id?: number | string } }).user?.id);
    if (!Number.isSafeInteger(id) || id < 1) return next(new AppError('请先登录 mintcli。', { code: 'AUTH_REQUIRED', statusCode: 401 }));
    res.locals.userId = id; next();
  });
  const projectId = (value: unknown) => {
    if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,160}$/.test(value)) throw new AppError('请选择有效项目。', { code: 'PROJECT_REQUIRED', statusCode: 400 });
    return value;
  };
  router.get('/status', asyncHandler(async (_req, res) => { res.json(await service.status(res.locals.userId)); }));
  router.post('/login', asyncHandler(async (_req, res) => { res.status(202).json(await service.startLogin(res.locals.userId)); }));
  router.get('/login', asyncHandler(async (_req, res) => { res.json(service.loginStatus(res.locals.userId)); }));
  router.delete('/login', asyncHandler(async (_req, res) => { res.json(await service.cancelLogin(res.locals.userId)); }));
  router.post('/token', asyncHandler(async (req, res) => { res.json(await service.tokenLogin(res.locals.userId, req.body?.token)); }));
  router.post('/logout', asyncHandler(async (_req, res) => { res.json(await service.logout(res.locals.userId)); }));
  router.get('/repository', asyncHandler(async (req, res) => { res.json(await service.repository(projectId(req.query.project))); }));
  router.post('/push', asyncHandler(async (req, res) => {
    const { expectedHead, expectedBranch } = req.body ?? {};
    if (typeof expectedHead !== 'string' || !/^[a-f0-9]{40,64}$/.test(expectedHead) || typeof expectedBranch !== 'string' || !expectedBranch || expectedBranch.length > 255) throw new AppError('请刷新项目信息后重试。', { code: 'GITHUB_SNAPSHOT_REQUIRED', statusCode: 400 });
    res.json(await service.push(res.locals.userId, projectId(req.body?.project), expectedHead, expectedBranch));
  }));
  return router;
}

/** Authenticated GitHub API mounted by the server entrypoint. */
export const githubRoutes = createGithubRouter();
