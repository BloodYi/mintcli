import fs from 'node:fs/promises';
import { AppError } from '@/shared/index.js';

type BridgeOptions = {
  baseUrl?: string;
  credentialsFile?: string;
  fetch?: typeof globalThis.fetch;
};

function readSetting(text: string, key: string): string {
  const line = text.split(/\r?\n/).find(value => value.trim().startsWith(key + '='));
  if (!line) return '';
  const value = line.trim().slice(key.length + 1).trim();
  if (value.startsWith('"') && value.endsWith('"')) {
    try { return JSON.parse(value) as string; } catch { return ''; }
  }
  return value.startsWith("'") && value.endsWith("'") ? value.slice(1, -1) : value.replace(/\s+#.*$/, '');
}

const unavailable = () => new AppError('Antigravity 服务暂时无法连接，请稍后重试。', {
  code: 'ANTIGRAVITY_UNAVAILABLE', statusCode: 502,
});

/** Used by the module routes and transport tests; connects only to the existing local agy web service. */
export function createAntigravityBridge(options: BridgeOptions = {}) {
  const url = new URL(options.baseUrl || process.env.ANTIGRAVITY_WEB_URL || 'http://127.0.0.1:3121');
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Antigravity bridge requires a loopback HTTP origin');
  }
  const fetcher = options.fetch || globalThis.fetch;
  let cookie = '';
  let loginPending: Promise<string> | null = null;
  let operation: Promise<unknown> = Promise.resolve();
  const serial = <T>(action: () => Promise<T>): Promise<T> => {
    const next = operation.then(action, action);
    operation = next.catch(() => {});
    return next;
  };

  const login = async () => {
    if (loginPending) return loginPending;
    loginPending = (async () => {
      let text = '';
      try {
        text = await fs.readFile(options.credentialsFile || process.env.ANTIGRAVITY_ENV_FILE
          || '/home/ubuntu/.agychat.env', 'utf8');
      } catch { /* An agy service with authentication disabled also accepts an empty login. */ }
      const response = await fetcher(new URL('/api/login', url), {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: readSetting(text, 'BASIC_AUTH_USER'),
          password: readSetting(text, 'BASIC_AUTH_PASS'),
        }),
      });
      if (!response.ok) throw unavailable();
      const value = response.headers.get('set-cookie')?.match(/(?:^|,\s*)agy_session=([^;,\s]+)/)?.[1];
      if (!value) throw unavailable();
      cookie = 'agy_session=' + value;
      return cookie;
    })();
    try { return await loginPending; } finally { loginPending = null; }
  };

  const request = async (method: string, target: string, body?: unknown, signal?: AbortSignal, contentType?: string): Promise<Response> => {
    if (!target.startsWith('/api/') || target.includes('..') || target.includes('\\')
      || !/^\/api\/(?:accounts(?:\/(?:add|switch|[^/?]+))?|acp-info|inspect-route|quota|models|chat|upload|download|fs|agy-fast\/(?:status|check-update|update|config)|think-translate\/(?:config|translate)|conversations(?:\/search|\/[^/?]+(?:\/(?:messages|activate|pin|recall))?)?|turns\/[^/?]+(?:\/(?:events|stop|messages))?)(?:\?[^#]*)?$/.test(target)) {
      throw new AppError('不支持的 Antigravity 操作。', { code: 'INVALID_ANTIGRAVITY_PATH', statusCode: 400 });
    }
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        if (!cookie) await login();
        const response = await fetcher(new URL(target, url), {
          method, redirect: 'error', signal,
          headers: { Cookie: cookie, ...(body === undefined ? {} : { 'Content-Type': contentType || 'application/json' }) },
          body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body),
        });
        if (response.status !== 401) return response;
        await response.body?.cancel();
        cookie = '';
      }
      throw unavailable();
    } catch (error) {
      if (signal?.aborted) throw error;
      throw unavailable(); // Never include upstream URLs, credentials or fetch bodies in public errors.
    }
  };

  const switchAccount = async (body: unknown, signal?: AbortSignal) => {
      const id = body && typeof body === 'object' ? (body as Record<string, unknown>).id : null;
      if (typeof id !== 'string' || !id || id.length > 256 || /[\\/\u0000-\u001f]/.test(id)) {
        throw new AppError('请选择已保存的 Antigravity 账号。', { code: 'INVALID_ANTIGRAVITY_ACCOUNT', statusCode: 400 });
      }
      const listing = await request('GET', '/api/accounts', undefined, signal);
      if (!listing.ok) throw unavailable();
      const data = await listing.json() as { accounts?: { id: string; active?: boolean }[] };
      if (!data.accounts?.some(account => account.id === id)) {
        throw new AppError('这个 Antigravity 账号不存在，请刷新账号列表。', { code: 'ANTIGRAVITY_ACCOUNT_NOT_FOUND', statusCode: 404 });
      }
      if (data.accounts.some(account => account.id === id && account.active)) return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
      return request('POST', '/api/accounts/switch', { id }, signal);
  };
  return {
    request,
    switchAccount(body: unknown, signal?: AbortSignal) { return serial(() => switchAccount(body, signal)); },
    startChatForAccount(id: unknown, payload: unknown, signal?: AbortSignal) {
      return serial(async () => {
        if (id) { const selected = await switchAccount({ id }, signal); if (!selected.ok) return selected; }
        const body = id && payload && typeof payload === 'object' ? { ...(payload as Record<string, unknown>), account_id: id } : payload;
        return request('POST', '/api/chat', body, signal);
      });
    },
    quotaForAccount(id: string, force: boolean) {
      return serial(async () => {
        const listing = await request('GET', '/api/accounts');
        const accounts = (await listing.json() as { accounts: { id: string; active: boolean }[] }).accounts;
        if (!accounts.some(item => item.id === id && item.active)) throw new AppError('请先切换到这个 agy 账号，再刷新额度。', { code: 'AGY_QUOTA_ACCOUNT_MISMATCH', statusCode: 409 });
        return request('GET', '/api/quota?force=' + force);
      });
    },
  };
}

/** Used only by the authenticated module routes to share a server-side agy website session. */
export const antigravityBridge = createAntigravityBridge();
