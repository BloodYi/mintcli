import express from 'express';
import type { Request, RequestHandler, Response } from 'express';

import { AppError } from '@/shared/utils.js';

import type { createAuthService } from './auth.service.js';

type AuthenticatedRequest = express.Request & { user?: unknown };

type AuthAttemptWindow = {
  failures: number[];
};

const AUTH_RATE_LIMIT_WINDOW_MS = 60_000;
const AUTH_MAX_FAILED_ATTEMPTS = 10;
const AUTH_MAX_TRACKED_KEYS = 2_048;

function resolveClientRateKey(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  const firstForwarded = typeof forwarded === 'string'
    ? forwarded.split(',')[0]?.trim()
    : Array.isArray(forwarded)
      ? forwarded[0]?.trim()
      : '';
  return firstForwarded || req.ip || req.socket?.remoteAddress || 'unknown';
}

export function createAuthRateLimiter(options: {
  windowMs?: number;
  maxFailures?: number;
  now?: () => number;
} = {}) {
  const windowMs = options.windowMs ?? AUTH_RATE_LIMIT_WINDOW_MS;
  const maxFailures = options.maxFailures ?? AUTH_MAX_FAILED_ATTEMPTS;
  const getNow = options.now ?? Date.now;
  const buckets = new Map<string, AuthAttemptWindow>();

  function prune(key: string, currentTime: number): AuthAttemptWindow {
    const existing = buckets.get(key);
    if (!existing) {
      if (buckets.size >= AUTH_MAX_TRACKED_KEYS) {
        const oldestKey = buckets.keys().next().value;
        if (oldestKey !== undefined) buckets.delete(oldestKey);
      }
      const created: AuthAttemptWindow = { failures: [] };
      buckets.set(key, created);
      return created;
    }
    const cutoff = currentTime - windowMs;
    existing.failures = existing.failures.filter((timestamp) => timestamp > cutoff);
    if (existing.failures.length === 0) {
      buckets.delete(key);
      const fresh: AuthAttemptWindow = { failures: [] };
      buckets.set(key, fresh);
      return fresh;
    }
    return existing;
  }

  return {
    assertAllowed(req: Request, res: Response): string {
      const key = resolveClientRateKey(req);
      const currentTime = getNow();
      const bucket = prune(key, currentTime);
      if (bucket.failures.length >= maxFailures) {
        const oldestFailure = bucket.failures[0] ?? currentTime;
        const retryAfterSeconds = Math.max(1, Math.ceil((oldestFailure + windowMs - currentTime) / 1000));
        res.setHeader('Retry-After', String(retryAfterSeconds));
        throw new AppError('Too many authentication attempts. Please try again later.', {
          code: 'AUTH_RATE_LIMITED',
          statusCode: 429,
        });
      }
      return key;
    },
    recordFailure(key: string): void {
      const currentTime = getNow();
      const bucket = prune(key, currentTime);
      bucket.failures.push(currentTime);
    },
    clear(key: string): void {
      buckets.delete(key);
    },
  };
}

/**
 * Creates the Auth transport adapter. Handlers only parse request data and
 * delegate authentication behavior to the injected application service.
 */
export function createAuthRouter(
  service: ReturnType<typeof createAuthService>,
  authenticateToken: RequestHandler,
  rateLimiter = createAuthRateLimiter(),
): express.Router {
  const router = express.Router();

  router.get('/status', (_req, res, next) => {
    try {
      res.json(service.getStatus());
    } catch (error) {
      next(error);
    }
  });

  router.post('/register', async (req, res, next) => {
    let clientKey: string | null = null;
    try {
      clientKey = rateLimiter.assertAllowed(req, res);
      const body = req.body as { username?: unknown; password?: unknown };
      const result = await service.register(body.username, body.password);
      rateLimiter.clear(clientKey);
      res.json(result);
    } catch (error) {
      if (clientKey && !(error instanceof AppError && error.statusCode === 429)) {
        rateLimiter.recordFailure(clientKey);
      }
      next(error);
    }
  });

  router.post('/login', async (req, res, next) => {
    let clientKey: string | null = null;
    try {
      clientKey = rateLimiter.assertAllowed(req, res);
      const body = req.body as { username?: unknown; password?: unknown };
      const result = await service.login(body.username, body.password);
      rateLimiter.clear(clientKey);
      res.json(result);
    } catch (error) {
      if (clientKey && !(error instanceof AppError && error.statusCode === 429)) {
        rateLimiter.recordFailure(clientKey);
      }
      next(error);
    }
  });

  router.get('/user', authenticateToken, (req, res) => {
    res.json(service.getCurrentUser((req as AuthenticatedRequest).user));
  });

  router.post('/refresh', authenticateToken, (req, res) => {
    res.json(service.refreshSession((req as AuthenticatedRequest).user));
  });

  router.post('/logout', authenticateToken, (_req, res) => {
    res.json(service.logout());
  });

  return router;
}
