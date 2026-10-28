import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

type Window = { bucket: string; minutes: number | null; usedPercent: number | null; remainingPercent: number | null; resetsAt: number | null };
type Snapshot = { status: string; planType?: string; windows: Window[]; checkedAt: number; reason?: string };
const pending = new Map<string, { expires: number; value: Promise<Snapshot> }>();
const unavailable = (): Snapshot => ({ status: 'unavailable', windows: [], checkedAt: Date.now(), reason: '暂时无法读取官方额度，请稍后刷新或重新授权账号。' });
const number = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;

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
  return { status: windows.length ? 'available' : 'unavailable', planType, windows, checkedAt: Date.now(),
    ...(windows.length ? {} : { reason: '官方本次没有返回额度窗口。' }) };
}

function requestQuota(env: Record<string, string>, refreshToken = false): Promise<Snapshot> {
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
        send(2, 'account/rateLimits/read');
      } else if (reply.id === 2) finish(snapshot(reply.result || {}, planType));
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
