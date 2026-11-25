import { timingSafeEqual } from 'node:crypto';
import { createRequire } from 'node:module';

import type { NextFunction, Request, RequestHandler, Response } from 'express';

import type { AuthenticatedWebSocketUser } from '@/shared/types.js';
import { IS_PLATFORM } from '@/shared/utils.js';

import { appConfigDb, userDb } from '../database/index.js';

type DecodedAuthToken = {
  userId?: number;
  username?: string;
  iat?: number;
  exp?: number;
  [key: string]: unknown;
};

type JwtAdapter = {
  sign(payload: Record<string, unknown>, secret: string, options: { expiresIn: string }): string;
  verify(token: string, secret: string): string | DecodedAuthToken;
  TokenExpiredError: new (...args: any[]) => Error;
};

const require = createRequire(import.meta.url);
const jwt = require('jsonwebtoken') as JwtAdapter;

type TokenUserInput = {
  id: number | bigint;
  username: string;
};

type AuthenticatedHttpRequest = Request & {
  user?: {
    id: number;
    username: string;
    [key: string]: unknown;
  };
};

// Use env var if set, otherwise auto-generate a unique secret per installation
const JWT_SECRET: string = process.env.JWT_SECRET || appConfigDb.getOrCreateJwtSecret();

// Optional API key middleware
const validateApiKey: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
  const configuredKey = process.env.API_KEY;
  if (!configuredKey) {
    next();
    return;
  }

  const rawHeader = req.headers['x-api-key'];
  const apiKey = typeof rawHeader === 'string' ? rawHeader : '';
  const candidateBuf = Buffer.from(apiKey, 'utf8');
  const expectedBuf = Buffer.from(configuredKey, 'utf8');
  if (
    candidateBuf.byteLength !== expectedBuf.byteLength
    || !timingSafeEqual(candidateBuf, expectedBuf)
  ) {
    res.status(401).json({ error: 'Invalid API key' });
    return;
  }
  next();
};

// JWT authentication middleware
const authenticateToken: RequestHandler = async (
  req: AuthenticatedHttpRequest,
  res: Response,
  next: NextFunction,
) => {
  // Platform mode: use single database user
  if (IS_PLATFORM) {
    try {
      const user = userDb.getFirstUser();
      if (!user) {
        res.status(500).json({ error: 'Platform mode: No user found in database' });
        return;
      }
      req.user = user;
      next();
      return;
    } catch (error) {
      console.error('Platform mode error:', error);
      res.status(500).json({ error: 'Platform mode: Failed to fetch user' });
      return;
    }
  }

  // Normal OSS JWT validation
  const authHeader = req.headers['authorization'];
  let token: string | undefined = authHeader ? authHeader.split(' ')[1] : undefined; // Bearer TOKEN

  // Also check query param for SSE endpoints (EventSource can't set headers)
  if (!token && typeof req.query.token === 'string') {
    token = req.query.token;
  }

  if (!token) {
    res.setHeader('X-Auth-Error', 'invalid-token');
    res.status(401).json({
      error: 'Access denied. No token provided.',
      code: 'AUTH_TOKEN_INVALID',
    });
    return;
  }

  try {
    const verified = jwt.verify(token, JWT_SECRET);
    if (!verified || typeof verified === 'string') {
      res.setHeader('X-Auth-Error', 'invalid-token');
      res.status(401).json({
        error: 'Invalid token',
        code: 'AUTH_TOKEN_INVALID',
      });
      return;
    }
    const decoded = verified as DecodedAuthToken;
    const userId = typeof decoded.userId === 'number' ? decoded.userId : Number(decoded.userId);
    if (!Number.isFinite(userId)) {
      res.setHeader('X-Auth-Error', 'invalid-token');
      res.status(401).json({
        error: 'Invalid token',
        code: 'AUTH_TOKEN_INVALID',
      });
      return;
    }

    // Verify user still exists and is active
    const user = userDb.getUserById(userId);
    if (!user) {
      res.setHeader('X-Auth-Error', 'invalid-token');
      res.status(401).json({
        error: 'Invalid token. User not found.',
        code: 'AUTH_TOKEN_INVALID',
      });
      return;
    }

    // Auto-refresh: if token is past halfway through its lifetime, issue a new one
    if (decoded.exp && decoded.iat) {
      const now = Math.floor(Date.now() / 1000);
      const halfLife = (decoded.exp - decoded.iat) / 2;
      if (now > decoded.iat + halfLife) {
        const newToken = generateToken(user);
        res.setHeader('X-Refreshed-Token', newToken);
      }
    }

    req.user = user;
    next();
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      res.setHeader('X-Auth-Error', 'session-expired');
      res.status(401).json({
        error: 'Session expired. Please log in again.',
        code: 'AUTH_TOKEN_EXPIRED',
      });
      return;
    }

    console.warn(
      'Token verification failed:',
      error instanceof Error ? error.message : String(error),
    );
    res.setHeader('X-Auth-Error', 'invalid-token');
    res.status(401).json({
      error: 'Invalid token',
      code: 'AUTH_TOKEN_INVALID',
    });
  }
};

// Generate JWT token
const generateToken = (user: TokenUserInput): string => {
  return jwt.sign(
    {
      userId: Number(user.id),
      username: user.username,
    },
    JWT_SECRET,
    { expiresIn: '7d' },
  );
};

// WebSocket authentication function
const authenticateWebSocket = (token: string | null | undefined): AuthenticatedWebSocketUser | null => {
  // Platform mode: bypass token validation, return first user
  if (IS_PLATFORM) {
    try {
      const user = userDb.getFirstUser();
      if (user) {
        return { id: user.id, userId: user.id, username: user.username };
      }
      return null;
    } catch (error) {
      console.error('Platform mode WebSocket error:', error);
      return null;
    }
  }

  // Normal OSS JWT validation
  if (!token) {
    return null;
  }

  try {
    const verified = jwt.verify(token, JWT_SECRET);
    if (!verified || typeof verified === 'string') {
      return null;
    }
    const decoded = verified as DecodedAuthToken;
    const userId = typeof decoded.userId === 'number' ? decoded.userId : Number(decoded.userId);
    if (!Number.isFinite(userId)) {
      return null;
    }
    // Verify user actually exists in database (matches REST authenticateToken behavior)
    const user = userDb.getUserById(userId);
    if (!user) {
      return null;
    }
    return { id: user.id, userId: user.id, username: user.username };
  } catch (error) {
    if (!(error instanceof jwt.TokenExpiredError)) {
      console.warn(
        'WebSocket token verification failed:',
        error instanceof Error ? error.message : String(error),
      );
    }
    return null;
  }
};

export {
  validateApiKey,
  authenticateToken,
  generateToken,
  authenticateWebSocket,
  JWT_SECRET,
};
