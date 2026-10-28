import { AbstractProvider } from '@/modules/providers/shared/base/abstract.provider.js';
import { ClaudeProviderModels } from '@/modules/providers/list/claude/claude-models.provider.js';
import { claudeAccountRuntime } from '@/modules/providers/list/claude/claude-account-runtime.provider.js';
import { claudeAccounts } from '@/modules/claude-accounts/index.js';
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
  readonly runtime: IProviderRuntime = claudeAccountRuntime;
  readonly models: IProviderModels = new ClaudeProviderModels();
  readonly mcp = new ClaudeMcpProvider();
  readonly auth: IProviderAuth = { async getStatus() { const catalog = claudeAccounts.list(); const account = catalog.accounts.find(item => item.id === catalog.activeId); return { provider: 'claude', installed: true, authenticated: Boolean(account?.authorized), email: account?.email || null, method: 'claude.ai' }; } };
  readonly skills: IProviderSkills = new ClaudeSkillsProvider();
  readonly sessions: IProviderSessions = new ClaudeSessionsProvider();
  readonly sessionSynchronizer: IProviderSessionSynchronizer = new ClaudeSessionSynchronizer();
  readonly fork: IProviderFork = new ClaudeForkProvider();

  constructor() {
    super('claude');
  }
}
