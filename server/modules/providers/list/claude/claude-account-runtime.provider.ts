import { query } from '@anthropic-ai/claude-agent-sdk';
import { claudeAccounts } from '@/modules/claude-accounts/index.js';
import { connectionService, validateConnectionEndpoint, startApiRelay } from '@/modules/codex-connections/index.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeRuntime } from '@/modules/providers/list/claude/claude-runtime.provider.js';
import type { IProviderRuntime } from '@/shared/interfaces.js';
import type { AnyRecord } from '@/shared/types.js';

/** Used by the Claude provider to bind either one native identity or one API credential for the entire run. */
export const claudeAccountRuntime: IProviderRuntime = {
  ...claudeRuntime,
  async run(command, options, writer, context) {
    const api = connectionService.apiForAgent('claude', options.connectionId);
    if (api) {
      await validateConnectionEndpoint(api.baseUrl!);
      const profile = path.join(api.home, 'claude');
      const projects = path.join(os.homedir(), '.claude', 'projects');
      fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
      fs.mkdirSync(projects, { recursive: true, mode: 0o700 });
      if (!fs.existsSync(path.join(profile, 'projects'))) fs.symlinkSync(projects, path.join(profile, 'projects'), 'dir');
      const factory = context.createQuery || query;
      const model = options.model || api.model;
      const relay = api.protocol === 'chat_completions' ? await startApiRelay('claude', { ...api, model }) : null;
      try { return await claudeRuntime.run(command, { ...options, model }, writer, {
        ...context,
        // Pin this turn's catalog/default even if another device switches accounts mid-run.
        resolveResumeModel: async (_session, requested) => requested || model,
        getProviderModels: () => connectionService.apiModelCatalog(api.id),
        createQuery: ((input: AnyRecord) => factory({ ...input, options: { ...input.options,
          model: input.options.model || model, settingSources: [],
          env: { ...api.env, CLAUDE_CODE_ARTIFACT: '1', CLAUDE_CONFIG_DIR: profile,
            ANTHROPIC_BASE_URL: relay?.baseUrl || api.baseUrl!.replace(/\/v1$/, ''), ANTHROPIC_API_KEY: relay?.apiKey || api.apiKey!,
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1' },
        } } as never)) as NonNullable<typeof context.createQuery>,
      }); } finally { await relay?.close(); }
    }
    const selected = claudeAccounts.begin(options.connectionId);
    try {
      const factory = context.createQuery || query;
      return await claudeRuntime.run(command, options, writer, {
        ...context,
        createQuery: ((input: AnyRecord) => {
          const native = factory({ ...input, options: { ...input.options, env: selected.env,
            // Authorization-bearing user/project settings cannot override the chosen subscription.
            settingSources: [],
          } } as never);
          return new Proxy(native, { get(target, key) {
            if (key === Symbol.asyncIterator) return async function* () {
              for await (const event of target) { claudeAccounts.recordQuota(selected.account.id, event as AnyRecord); yield event; }
            };
            const value = Reflect.get(target, key);
            return typeof value === 'function' ? value.bind(target) : value;
          } });
        }) as NonNullable<typeof context.createQuery>,
      });
    } finally { selected.end(); }
  },
};
