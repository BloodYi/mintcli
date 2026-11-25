import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { once } from 'node:events';
import { antigravityBridge } from './antigravity.service.js';
import { thinkTranslateService } from './think-translate.service.js';
import { AppError } from '@/shared/index.js';

const router = express.Router();

router.get('/think-translate/config', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const accountId = typeof req.query.account_id === 'string' ? req.query.account_id : undefined;
    const lite = req.query.lite === '1' || req.query.lite === 'true';
    res.setHeader('Cache-Control', 'no-store, no-transform');
    res.json(await thinkTranslateService.getConfig(accountId, { lite }));
  } catch (error) {
    next(error);
  }
});

router.post('/think-translate/config', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {};
    res.setHeader('Cache-Control', 'no-store, no-transform');
    res.json(await thinkTranslateService.saveConfig({
      ...(body.account_id !== undefined ? { account_id: String(body.account_id ?? '') } : {}),
      ...(body.model !== undefined ? { model: String(body.model ?? '') } : {}),
      ...(body.target_lang !== undefined ? { target_lang: String(body.target_lang ?? '') } : {}),
    }));
  } catch (error) {
    next(error);
  }
});

router.post('/think-translate/translate', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {};
    res.setHeader('Cache-Control', 'no-store, no-transform');
    res.json(await thinkTranslateService.translate({
      text: typeof body.text === 'string' ? body.text : '',
      ...(body.target_lang !== undefined ? { target_lang: String(body.target_lang ?? '') } : {}),
      ...(body.account_id !== undefined ? { account_id: String(body.account_id ?? '') } : {}),
      ...(body.model !== undefined ? { model: String(body.model ?? '') } : {}),
    }));
  } catch (error) {
    next(error);
  }
});

async function forward(req: Request, res: Response, next: NextFunction) {
  const controller = new AbortController();
  res.once('close', () => controller.abort());
  try {
    // API credentials are resolved only by the runtime, never forwarded from public bridge requests.
    if (req.body && typeof req.body === 'object' && 'api_connection' in req.body) throw new AppError('请在账号管理中配置第三方 API', { code: 'INVALID_AGY_API_CONFIG', statusCode: 400 });
    const target = '/api' + req.url;
    const response = req.path === '/accounts/switch'
      ? await antigravityBridge.switchAccount(req.body, controller.signal)
      : await antigravityBridge.request(req.method, target,
        ['GET', 'HEAD'].includes(req.method) ? undefined : req.body,
        controller.signal, req.get('content-type'));
    res.status(response.status);
    res.setHeader('Cache-Control', 'no-store, no-transform');
    for (const name of ['content-type', 'content-disposition']) {
      const value = response.headers.get(name);
      if (value) res.setHeader(name, value);
    }
    // Cookies remain server-side. The browser uses the existing CloudCLI login only.
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    if (response.body) {
      for await (const chunk of response.body) {
        if (!res.write(chunk)) await once(res, 'drain', { signal: controller.signal });
      }
    }
    res.end();
  } catch (error) {
    if (controller.signal.aborted) return;
    if (res.headersSent) res.destroy(); else next(error);
  }
}

for (const route of ['/accounts', '/acp-info', '/inspect-route', '/models', '/quota',
  '/agy-fast/status',
  '/conversations', '/conversations/search', '/conversations/:id/messages',
  '/turns/:id', '/turns/:id/events', '/download', '/fs']) {
  router.get(route, forward);
}
for (const route of ['/accounts/add', '/accounts/switch', '/inspect-route', '/chat',
  '/agy-fast/check-update', '/agy-fast/update', '/agy-fast/config',
  '/turns/:id/stop', '/turns/:id/messages',
  '/conversations/:id/activate', '/conversations/:id/messages', '/conversations/:id/recall']) {
  router.post(route, forward);
}
router.post('/upload', express.raw({ type: 'multipart/form-data', limit: '50mb' }), forward);
router.patch('/conversations/:id', forward);
router.patch('/conversations/:id/pin', forward);
for (const route of ['/accounts/:id', '/conversations', '/conversations/:id']) {
  router.delete(route, forward);
}

/** Mounted by server/index.ts behind the existing authenticated CloudCLI API. */
export const antigravityRoutes = router;
