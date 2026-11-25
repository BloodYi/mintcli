import assert from 'node:assert/strict';
import test from 'node:test';

import express from 'express';

import { AppError } from '@/shared/utils.js';

import { createAuthRateLimiter, createAuthRouter } from '../auth.routes.js';
import { createAuthService } from '../auth.service.js';

type AuthDependencies = Parameters<typeof createAuthService>[0];

function createDependencies(overrides: Partial<AuthDependencies> = {}): AuthDependencies {
  return {
    users: {
      hasUsers: () => false,
      createUser: (username, passwordHash) => ({ id: 1, username, password_hash: passwordHash }),
      getUserByUsername: () => undefined,
      updateLastLogin: () => undefined,
    },
    transaction: {
      begin: () => undefined,
      commit: () => undefined,
      rollback: () => undefined,
    },
    hashPassword: async () => 'hashed-password',
    comparePassword: async () => false,
    generateToken: () => 'signed-token',
    ...overrides,
  };
}

test('register hashes credentials and commits through injected dependencies', async () => {
  const operations: string[] = [];
  const service = createAuthService(createDependencies({
    transaction: {
      begin: () => operations.push('begin'),
      commit: () => operations.push('commit'),
      rollback: () => operations.push('rollback'),
    },
    hashPassword: async (password) => {
      operations.push(`hash:${password}`);
      return 'hash';
    },
    users: {
      hasUsers: () => false,
      createUser: (username, passwordHash) => {
        operations.push(`create:${username}:${passwordHash}`);
        return { id: 1, username, password_hash: passwordHash };
      },
      getUserByUsername: () => undefined,
      updateLastLogin: (userId) => operations.push(`login:${userId}`),
    },
  }));

  const result = await service.register('alice', 'secret12');

  assert.equal(result.token, 'signed-token');
  assert.deepEqual(operations, ['hash:secret12', 'begin', 'create:alice:hash', 'commit', 'login:1']);
});

test('concurrent register calls never overlap BEGIN/COMMIT across async password hashing', async () => {
  let inTransaction = false;
  let userCount = 0;
  const service = createAuthService(createDependencies({
    transaction: {
      begin: () => {
        assert.equal(inTransaction, false, 'nested BEGIN on shared SQLite connection');
        inTransaction = true;
      },
      commit: () => {
        assert.equal(inTransaction, true);
        inTransaction = false;
      },
      rollback: () => {
        inTransaction = false;
      },
    },
    hashPassword: async (password) => {
      await new Promise((resolve) => setTimeout(resolve, 15));
      return `hashed:${password}`;
    },
    users: {
      hasUsers: () => userCount > 0,
      createUser: (username, passwordHash) => {
        userCount += 1;
        return { id: userCount, username, password_hash: passwordHash };
      },
      getUserByUsername: () => undefined,
      updateLastLogin: () => undefined,
    },
  }));

  const [first, second] = await Promise.allSettled([
    service.register('alice', 'secret12'),
    service.register('bob', 'secret34'),
  ]);

  assert.equal(first.status, 'fulfilled');
  assert.equal(second.status, 'rejected');
  assert.equal(userCount, 1);
  assert.equal(inTransaction, false);
});

test('auth router rate limits repeated failed login attempts per IP', async () => {
  let currentTime = 1_000;
  const rateLimiter = createAuthRateLimiter({
    windowMs: 60_000,
    maxFailures: 3,
    now: () => currentTime,
  });
  const service = createAuthService(createDependencies({
    users: {
      hasUsers: () => true,
      createUser: () => { throw new Error('unused'); },
      getUserByUsername: () => ({ id: 1, username: 'alice', password_hash: 'hash' }),
      updateLastLogin: () => undefined,
    },
    comparePassword: async () => false,
  }));

  const app = express();
  app.use(express.json());
  app.use('/api/auth', createAuthRouter(service, (_req, _res, next) => next(), rateLimiter));
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err instanceof AppError) {
      res.status(err.statusCode).json({ code: err.code, error: err.message });
      return;
    }
    res.status(500).json({ error: 'unexpected' });
  });

  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  try {
    const port = (server.address() as { port: number }).port;
    for (let i = 0; i < 3; i += 1) {
      const res = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'alice', password: 'bad' }),
      });
      assert.equal(res.status, 401);
    }
    const blocked = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'bad' }),
    });
    assert.equal(blocked.status, 429);
    assert.ok(blocked.headers.get('retry-after'));

    currentTime += 61_000;
    const afterWindow = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'bad' }),
    });
    assert.equal(afterWindow.status, 401);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('login rejects an invalid password without issuing a token', async () => {
  let tokenIssued = false;
  const service = createAuthService(createDependencies({
    users: {
      hasUsers: () => true,
      createUser: () => { throw new Error('unused'); },
      getUserByUsername: () => ({ id: 1, username: 'alice', password_hash: 'hash' }),
      updateLastLogin: () => undefined,
    },
    comparePassword: async () => false,
    generateToken: () => {
      tokenIssued = true;
      return 'token';
    },
  }));

  await assert.rejects(
    service.login('alice', 'wrong-password'),
    (error: unknown) => error instanceof AppError && error.code === 'AUTH_INVALID_CREDENTIALS',
  );
  assert.equal(tokenIssued, false);
});

test('refreshSession issues a replacement token for the authenticated user', () => {
  let tokenUser: { id: number | bigint; username: string } | undefined;
  const service = createAuthService(createDependencies({
    generateToken: (user) => {
      tokenUser = user;
      return 'replacement-token';
    },
  }));

  const result = service.refreshSession({ id: 7, username: 'alice' });

  assert.deepEqual(result, { token: 'replacement-token' });
  assert.deepEqual(tokenUser, { id: 7, username: 'alice' });
});
