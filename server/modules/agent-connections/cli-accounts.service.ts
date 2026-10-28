import { providerAuthService } from '@/modules/providers/index.js';
import type { ProviderAuthStatus } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

type CliProvider = 'cursor' | 'opencode';
const labels: Record<CliProvider, string> = { cursor: 'Cursor', opencode: 'OpenCode' };
const dashboards: Record<CliProvider, string> = { cursor: 'https://cursor.com/dashboard?tab=usage', opencode: 'https://opencode.ai/console' };

/** Used by Connections and focused tests to inspect CLI-owned accounts without copying credentials. */
export function createCliAccountService(readStatus: (provider: CliProvider) => Promise<ProviderAuthStatus> = providerAuthService.getProviderAuthStatus) {
  const cache = new Map<CliProvider, { checkedAt: number; status: ProviderAuthStatus }>();
  const pending = new Map<CliProvider, Promise<ProviderAuthStatus>>();
  const status = async (provider: CliProvider, force = false): Promise<ProviderAuthStatus> => {
    const previous = cache.get(provider);
    if (!force && previous && Date.now() - previous.checkedAt < 30_000) return previous.status;
    const current = pending.get(provider);
    if (current) return current;
    const job = readStatus(provider).then(value => { cache.set(provider, { checkedAt: Date.now(), status: value }); return value; }).finally(() => pending.delete(provider));
    pending.set(provider, job);
    return job;
  };
  return {
    async list(force = false) {
      return Promise.all((['cursor', 'opencode'] as const).map(async provider => {
        const auth = await status(provider, force).catch(() => ({ installed: false, authenticated: false, email: null }));
        return { id: `${provider}:default`, accountId: 'default', provider, kind: provider, name: labels[provider], authorized: auth.authenticated, installed: auth.installed, email: auth.email || undefined, current: true };
      }));
    },
    async quota(provider: CliProvider, force: boolean) {
      const auth = await status(provider, force);
      return {
        connectionId: `${provider}:default`, status: 'unavailable', windows: [], checkedAt: Date.now(), source: 'native-cli',
        reason: !auth.installed ? `${labels[provider]} CLI 尚未安装` : !auth.authenticated ? '请先在账号管理中完成官方登录' : '当前登录未提供可读取的剩余额度，请在官方控制台查看。',
        dashboardUrl: dashboards[provider],
      };
    },
    validate(provider: string, account: string): void {
      if (!['cursor', 'opencode'].includes(provider) || account !== 'default') throw new AppError('账号选择无效', { code: 'INVALID_ACCOUNT', statusCode: 400 });
    },
  };
}

/** Used by Connections to reuse native CLI status checks across catalog and quota requests. */
export const cliAccounts = createCliAccountService();
