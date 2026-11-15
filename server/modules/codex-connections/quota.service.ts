import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

import { AppError } from '@/shared/index.js';

type Window = { bucket: string; minutes: number | null; usedPercent: number | null; remainingPercent: number | null; resetsAt: number | null };
type ResetCredit = { id: string; title: string | null; description: string | null; expiresAt: number | null };
type Snapshot = { status: string; planType?: string; windows: Window[]; checkedAt: number; reason?: string;
  resetCredits?: { availableCount: number; credits: ResetCredit[] | null } | null; resetOutcome?: string };
type ResetAttempt = { idempotencyKey: string; creditId?: string };
const resets = new Map<string, { key: string; expires: number; value: Promise<Snapshot>; active: boolean }>();
const pending = new Map<string, { expires: number; value: Promise<Snapshot> }>();
const unavailable = (): Snapshot => ({ status: 'unavailable', windows: [], checkedAt: Date.now(), resetCredits: null, reason: '暂时无法读取官方额度，请稍后刷新或重新授权账号。' });
const number = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;

function resetCredits(value: unknown): Snapshot['resetCredits'] {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const count = number(raw.availableCount);
  if (count === null || !Number.isSafeInteger(count) || count < 0) return null;
  const credits = Array.isArray(raw.credits) ? raw.credits.flatMap(item => {
    if (!item || typeof item !== 'object' || item.status !== 'available' || item.resetType !== 'codexRateLimits'
      || typeof item.id !== 'string' || !item.id || item.id.length > 512) return [];
    return [{ id: item.id, title: typeof item.title === 'string' ? item.title.slice(0, 200) : null,
      description: typeof item.description === 'string' ? item.description.slice(0, 2000) : null, expiresAt: number(item.expiresAt) }];
  }) : null;
  return { availableCount: count, credits };
}

function snapshot(value: Record<string, unknown>, planType: string): Snapshot {
  const byId = value.rateLimitsByLimitId as Record<string, Record<string, unknown>> | undefined;
  const legacy = value.rateLimits as Record<string, unknown> | undefined;
  const buckets = byId && Object.keys(byId).length ? Object.entries(byId) : legacy ? [[String(legacy.limitId || 'codex'), legacy] as const] : [];
  const windows: Window[] = [];
  for (const [id, bucket] of buckets) {
    if (!bucket || typeof bucket !== 'object') continue;
    for (const slot of ['primary', 'secondary']) {
      const window = bucket[slot] as Record<string, unknown> | null;
      if (!window || typeof window !== 'object') continue;
      const raw = number(window.usedPercent), used = raw === null ? null : Math.max(0, Math.min(100, raw));
      windows.push({ bucket: String(bucket.limitName || id).slice(0, 80), minutes: number(window.windowDurationMins),
        usedPercent: used, remainingPercent: used === null ? null : Math.round((100 - used) * 10) / 10, resetsAt: number(window.resetsAt) });
    }
  }
  return { status: windows.length ? 'available' : 'unavailable', planType, windows, checkedAt: Date.now(), resetCredits: resetCredits(value.rateLimitResetCredits),
    ...(windows.length ? {} : { reason: '官方本次没有返回额度窗口。' }) };
}

function requestQuota(env: Record<string, string>, refreshToken = false, reset?: ResetAttempt): Promise<Snapshot> {
  return new Promise(resolve => {
    const child = spawn(env.CODEX_QUOTA_BIN || 'codex', ['app-server'], { env, stdio: ['pipe', 'pipe', 'ignore'] });
    const reader = createInterface({ input: child.stdout });
    let done = false, planType = '', bytes = 0;
    const finish = (value: Snapshot) => {
      if (done) return;
      done = true; clearTimeout(timer); reader.close(); child.stdin.end(); child.kill();
      const force = setTimeout(() => child.kill('SIGKILL'), 1000); force.unref();
      child.once('close', () => clearTimeout(force)); resolve(value);
    };
    const timer = setTimeout(() => finish(unavailable()), 25000); timer.unref();
    const send = (id: number, method: string, params?: unknown) => {
      child.stdin.write(JSON.stringify({ id, method, ...(params === undefined ? {} : { params }) }) + '\n');
    };
    child.stdin.on('error', () => finish(unavailable()));
    child.once('error', () => finish(unavailable()));
    child.once('close', () => finish(unavailable()));
    reader.on('line', line => {
      if (done) return;
      bytes += Buffer.byteLength(line);
      if (bytes > 4 * 1024 * 1024) { finish(unavailable()); return; }
      let reply: { id?: number; error?: unknown; result?: Record<string, unknown> };
      try { reply = JSON.parse(line); } catch { return; }
      if (reply.error) { finish(unavailable()); return; }
      if (reply.id === 0) {
        child.stdin.write('{"method":"initialized"}\n'); send(1, 'account/read', { refreshToken });
      } else if (reply.id === 1) {
        const account = reply.result?.account as { type?: string; planType?: string } | undefined;
        if (account?.type !== 'chatgpt') { finish(unavailable()); return; }
        planType = typeof account.planType === 'string' ? account.planType : '';
        if (refreshToken) { finish({ status: 'refreshed', planType, windows: [], checkedAt: Date.now() }); return; }
        if (reset) send(2, 'account/rateLimitResetCredit/consume', reset);
        else send(2, 'account/rateLimits/read');
      } else if (reply.id === 2) {
        if (!reset) { finish(snapshot(reply.result || {}, planType)); return; }
        const outcome = reply.result?.outcome;
        finish(typeof outcome === 'string' && ['reset', 'nothingToReset', 'noCredit', 'alreadyRedeemed'].includes(outcome)
          ? { status: 'completed', resetOutcome: outcome, windows: [], checkedAt: Date.now() } : unavailable());
      }
    });
    send(0, 'initialize', { clientInfo: { name: 'cloudcli_usage_reader', title: 'CloudCLI usage', version: '1.0.0' } });
  });
}

/** Used by connectionService for isolated, deduplicated official quota reads without model calls. */
export function readAccountQuota(env: Record<string, string>): Promise<Snapshot> {
  const key = env.CODEX_HOME;
  const existing = pending.get(key);
  if (existing && existing.expires > Date.now()) return existing.value;
  const value = requestQuota(env).catch(unavailable);
  pending.set(key, { expires: Date.now() + 30000, value });
  return value;
}

/** Used by the live model catalog only after an upstream401 to retry normal managed authorization refresh. */
export async function refreshOfficialAccount(env: Record<string, string>): Promise<boolean> {
  return (await requestQuota(env, true)).status === 'refreshed';
}

/** Used by connectionService only after explicit UI confirmation; native idempotency prevents double redemption on retries. */
export function consumeAccountReset(env: Record<string, string>, idempotencyKey: string, creditId?: string): Promise<Snapshot> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idempotencyKey)
    || (creditId !== undefined && (!creditId || creditId.length > 512 || /[\x00-\x1f]/.test(creditId)))) {
    throw new AppError('重置请求格式不正确', { code: 'INVALID_RESET_REQUEST', statusCode: 400 });
  }
  const home = env.CODEX_HOME;
  const key = idempotencyKey + ':' + (creditId || '');
  for (const [id, attempt] of resets) if (!attempt.active && attempt.expires < Date.now()) resets.delete(id);
  const existing = resets.get(home);
  if (existing?.key === key) return existing.value;
  if (existing?.active) throw new AppError('这个账号正在处理重置，请稍后刷新额度', { code: 'RESET_IN_PROGRESS', statusCode: 409 });
  const attempt = { key, expires: Date.now() + 300000, active: true, value: Promise.resolve(unavailable()) };
  attempt.value = requestQuota(env, false, { idempotencyKey, ...(creditId ? { creditId } : {}) })
    .finally(() => { attempt.active = false; pending.delete(home); });
  resets.set(home, attempt);
  return attempt.value;
}
