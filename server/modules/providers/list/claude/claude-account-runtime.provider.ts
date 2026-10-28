import { query } from '@anthropic-ai/claude-agent-sdk';
import { claudeAccounts } from '@/modules/claude-accounts/index.js';
import { claudeRuntime } from '@/modules/providers/list/claude/claude-runtime.provider.js';
import type { IProviderRuntime } from '@/shared/interfaces.js';
import type { AnyRecord } from '@/shared/types.js';

/** Keeps the existing native SDK runtime, binding one isolated identity for the entire run. */
export const claudeAccountRuntime: IProviderRuntime = {
  ...claudeRuntime,
  async run(command, options, writer, context) {
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
