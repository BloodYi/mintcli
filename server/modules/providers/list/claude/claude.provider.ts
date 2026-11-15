import { ClaudeProviderAuth } from '@/modules/providers/list/claude/claude-auth.provider.js';
import { AbstractProvider } from '@/modules/providers/shared/base/abstract.provider.js';
import { ClaudeProviderModels } from '@/modules/providers/list/claude/claude-models.provider.js';
import { claudeAccountRuntime } from '@/modules/providers/list/claude/claude-account-runtime.provider.js';
import { claudeAccounts } from '@/modules/claude-accounts/index.js';
import { connectionService } from '@/modules/codex-connections/index.js';
import { ClaudeForkProvider } from '@/modules/providers/list/claude/claude-fork.provider.js';
import { ClaudeMcpProvider } from '@/modules/providers/list/claude/claude-mcp.provider.js';
import { ClaudeSessionSynchronizer } from '@/modules/providers/list/claude/claude-session-synchronizer.provider.js';
import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import { ClaudeSkillsProvider } from '@/modules/providers/list/claude/claude-skills.provider.js';
import type {
  IProviderAuth,
  IProviderFork,
  IProviderModels,
  IProviderRuntime,
  IProviderSessionSynchronizer,
  IProviderSkills,
  IProviderSessions,
} from '@/shared/interfaces.js';

export class ClaudeProvider extends AbstractProvider {
  declare readonly runtime: IProviderRuntime;
  readonly models: IProviderModels = new ClaudeProviderModels();
  readonly mcp = new ClaudeMcpProvider();
  readonly auth: IProviderAuth = { checkInstalled: () => new ClaudeProviderAuth().checkInstalled(), async getStatus() { const api = connectionService.apiForAgent('claude'); const catalog = claudeAccounts.list(); const account = catalog.accounts.find(item => item.id === catalog.activeId); return { provider: 'claude', installed: true, installedVersion: this.checkInstalled().version, authenticated: api ? Boolean(api.apiKey) : Boolean(account?.authorized), email: api ? null : account?.email || null, method: api ? 'api-key' : 'claude.ai' }; } };
  readonly skills: IProviderSkills = new ClaudeSkillsProvider();
  readonly sessions: IProviderSessions = new ClaudeSessionsProvider();
  readonly sessionSynchronizer: IProviderSessionSynchronizer = new ClaudeSessionSynchronizer();
  readonly fork: IProviderFork = new ClaudeForkProvider();

  constructor() {
    super('claude');
    Object.defineProperty(this, 'runtime', { enumerable: true, get: () => claudeAccountRuntime });
  }
}
