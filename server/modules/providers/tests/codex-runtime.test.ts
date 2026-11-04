import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { Codex } from '@openai/codex-sdk';
import type { Thread, ThreadOptions } from '@openai/codex-sdk';

import { codexRuntime } from '@/modules/providers/list/codex/codex-runtime.provider.js';
import type { ProviderRuntimeContext } from '@/shared/index.js';

for (const accepted of [false, true]) {
  test(`Codex ${accepted ? 'persists an accepted' : 'does not persist a rejected'} first-turn thread id`, async (t) => {
    const messages: any[] = [];
    const ids: string[] = [];
    const thread = { id: 'allocated-id', async runStreamed() {
      return { events: (async function* () {
        yield { type: 'thread.started', thread_id: 'allocated-id' };
        if (!accepted) throw new Error('Input exceeds the maximum length of 1048576 characters');
        yield { type: 'item.completed', item: { id: 'reply', type: 'agent_message', text: 'ok' } };
        yield { type: 'turn.completed', usage: {} };
      })() };
    } } as unknown as Thread;
    t.mock.method(Codex.prototype, 'startThread', () => thread);
    const context: ProviderRuntimeContext = {
      resolveProviderSessionId: () => null, resolveResumeModel: async () => 'test-model',
      getProviderModels: async () => ({ OPTIONS: [], DEFAULT: 'test-model' }),
      normalizeMessage: () => [], isProviderInstalled: async () => true,
    };
    await codexRuntime.run('hello', { cwd: process.cwd() }, {
      isWebSocketWriter: true, send: value => messages.push(value), setSessionId: id => ids.push(id),
    }, context);
    assert.deepEqual(ids, accepted ? ['allocated-id'] : []);
    assert.equal(messages.filter(value => value.kind === 'session_created').length, accepted ? 1 : 0);
    assert.ok(messages.some(value => value.kind === 'complete' && value.exitCode === (accepted ? 0 : 1)));
  });
}

for (const resumed of [false, true]) {
  for (const permissionMode of [undefined, 'default', 'unknown', 'acceptEdits', 'bypassPermissions']) {
    test(`Codex ${resumed ? 'resumes' : 'starts'} with supported permissions (${permissionMode ?? 'omitted'})`, async (t) => {
      let capturedOptions: ThreadOptions | undefined;
      let capturedPrompt: unknown;
      const messages: unknown[] = [];
      const thread = {
        id: 'native-thread',
        async runStreamed(prompt: unknown) {
          capturedPrompt = prompt;
          return { events: (async function* () {
            yield { type: 'thread.started', thread_id: 'native-thread' };
          })() };
        },
      } as unknown as Thread;

      const start = t.mock.method(Codex.prototype, 'startThread', (options?: ThreadOptions) => {
        capturedOptions = options;
        return thread;
      });
      const resume = t.mock.method(Codex.prototype, 'resumeThread', (id: string, options?: ThreadOptions) => {
        assert.equal(id, 'native-thread');
        capturedOptions = options;
        return thread;
      });
      const context: ProviderRuntimeContext = {
        resolveProviderSessionId: () => resumed ? 'native-thread' : null,
        resolveResumeModel: async () => 'test-model',
        getProviderModels: async () => ({ OPTIONS: [], DEFAULT: 'test-model' }),
        normalizeMessage: () => [],
        isProviderInstalled: async () => true,
      };

      await codexRuntime.run('hey there', {
        sessionId: resumed ? 'app-session' : undefined,
        permissionMode,
        cwd: process.cwd(),
      }, { isWebSocketWriter: true, send: (message) => messages.push(message) }, context);

      assert.equal(start.mock.callCount(), resumed ? 0 : 1);
      assert.equal(resume.mock.callCount(), resumed ? 1 : 0);
      assert.equal(capturedPrompt, 'hey there');
      assert.equal(capturedOptions?.sandboxMode, 'danger-full-access');
      assert.equal(capturedOptions?.approvalPolicy, 'never');
      assert.ok(messages.some((message: any) => message.kind === 'complete' && message.exitCode === 0));
      assert.ok(!messages.some((message: any) => message.kind === 'error'));
    });
  }
}

for (const command of ['', '  \n\t']) {
  test(`Codex supplies a prompt for an image-only turn (${JSON.stringify(command)})`, async (t) => {
    let capturedPrompt: unknown;
    const imagePath = path.join(process.cwd(), 'public', 'favicon.png');
    const thread = {
      id: 'native-thread',
      async runStreamed(prompt: unknown) {
        capturedPrompt = prompt;
        return { events: (async function* () {
          yield { type: 'thread.started', thread_id: 'native-thread' };
        })() };
      },
    } as unknown as Thread;

    t.mock.method(Codex.prototype, 'startThread', () => thread);
    const context: ProviderRuntimeContext = {
      resolveProviderSessionId: () => null,
      resolveResumeModel: async () => 'test-model',
      getProviderModels: async () => ({ OPTIONS: [], DEFAULT: 'test-model' }),
      normalizeMessage: () => [],
      isProviderInstalled: async () => true,
    };

    await codexRuntime.run(command, {
      cwd: process.cwd(),
      images: [{ path: imagePath, mimeType: 'image/png' }],
    }, { isWebSocketWriter: true, send: () => {} }, context);

    assert.deepEqual(capturedPrompt, [
      { type: 'text', text: 'Please analyze the attached image(s).' },
      { type: 'local_image', path: imagePath },
    ]);
  });
}


for (const resumed of [false, true]) {
  for (const fastMode of [true, false, undefined]) {
    test(`Codex ${resumed ? 'resume' : 'start'} passes explicit speed and independent effort (${fastMode})`, async (t) => {
      let capturedConfig: Record<string, unknown> | undefined;
      let capturedEffort: string | undefined;
      const thread = { id: 'native-thread', async runStreamed() {
        return { events: (async function* () { yield { type: 'thread.started', thread_id: 'native-thread' }; })() };
      } } as unknown as Thread;
      const capture = function(this: Codex, options?: ThreadOptions) {
        capturedConfig = (this as unknown as { options: { config?: Record<string, unknown> } }).options.config;
        capturedEffort = options?.modelReasoningEffort;
        return thread;
      };
      t.mock.method(Codex.prototype, 'startThread', capture);
      t.mock.method(Codex.prototype, 'resumeThread', function(this: Codex, _id: string, options?: ThreadOptions) { return capture.call(this, options); });
      const context: ProviderRuntimeContext = {
        resolveProviderSessionId: () => resumed ? 'native-thread' : null,
        resolveResumeModel: async () => 'test-model',
        getProviderModels: async () => ({ OPTIONS: [{ value: 'test-model', label: 'Test', effort: { values: [{ value: 'xhigh' }] } }], DEFAULT: 'test-model' }),
        normalizeMessage: () => [], isProviderInstalled: async () => true,
      };
      await codexRuntime.run('hello', { cwd: process.cwd(), fastMode, effort: 'xhigh' }, { isWebSocketWriter: true, send: () => {} }, context);
      assert.equal(capturedConfig?.service_tier, fastMode === true ? 'fast' : 'default');
      assert.deepEqual(capturedConfig?.features, { fast_mode: fastMode === true });
      assert.equal(capturedEffort, 'xhigh');
    });
  }
}
