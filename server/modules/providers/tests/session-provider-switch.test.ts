import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';
import { sessionsService } from '@/modules/providers/services/sessions.service.js';
import { chatRunRegistry, runDetachedChatTurn } from '@/modules/websocket/index.js';
import type { ProviderRuntimeGateway } from '@/modules/websocket/index.js';
import type { NormalizedMessage } from '@/shared/types.js';

const message = (id: string, role: 'user' | 'assistant', content: string, provider: 'codex' | 'antigravity'): NormalizedMessage => ({
  id, role, content, provider, sessionId: 'agy-original', kind: 'text', timestamp: '2026-11-03T18:00:00Z', transcriptAnchorId: id,
});

async function isolated(run: () => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'session-provider-switch-'));
  const previous = process.env.DATABASE_PATH;
  closeConnection();
  process.env.DATABASE_PATH = path.join(directory, 'auth.db');
  await writeFile(process.env.DATABASE_PATH, '');
  await initializeDatabase();
  try { await run(); } finally {
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous;
    await rm(directory, { recursive: true, force: true });
  }
}

test('agy → GPT → agy preserves one conversation, full paginated history and first-turn context', async () => {
  await isolated(async () => {
    const agy = providerRegistry.resolveProvider('antigravity').sessions;
    const codex = providerRegistry.resolveProvider('codex').sessions;
    const originalAgyHistory = agy.fetchHistory;
    const originalCodexHistory = codex.fetchHistory;
    const original = [message('a-user', 'user', '记住项目代号是薄荷', 'antigravity'), message('a-reply', 'assistant', '记住了', 'antigravity')];
    const codexMessages: NormalizedMessage[] = [];
    agy.fetchHistory = async () => ({ messages: original, total: original.length, hasMore: false, offset: 0, limit: null });
    codex.fetchHistory = async () => ({ messages: codexMessages, total: codexMessages.length, hasMore: false, offset: 0, limit: null });
    try {
      sessionsDb.createSession('agy-original', 'antigravity', '/tmp/project', '保留标题');
      sessionsDb.setSessionModel('agy-original', 'gemini-old');
      sessionsDb.setSessionEffort('agy-original', 'high');
      let selections = 0;
      await sessionsService.switchSessionProvider('agy-original', 'codex', async () => { selections++; });
      assert.equal(selections, 1);
      const switched = sessionsDb.getSessionById('agy-original');
      assert.equal(switched?.provider, 'codex');
      assert.equal(switched?.custom_name, '保留标题');
      assert.equal(switched?.provider_session_id, null);
      assert.equal(switched?.model, null);
      assert.equal(switched?.effort, null);
      assert.deepEqual((await sessionsService.fetchHistory('agy-original')).messages.map(item => item.content), original.map(item => item.content));
      assert.equal((await sessionsService.fetchHistory('agy-original')).messages[0].transcriptAnchorId, undefined);

      // A scanner rediscovers the old native conversation, including the
      // legacy case where its native id equals the app id.
      sessionsDb.createSession('agy-original', 'antigravity', '/tmp/project', '不应覆盖');
      assert.equal(sessionsDb.getSessionById('agy-original')?.provider, 'codex');
      assert.equal(sessionsDb.getAllSessions().length, 1);

      const commands: string[] = [];
      const runtime: ProviderRuntimeGateway = {
        hasRuntime: () => true, hasBackgroundWork: () => false,
        abort: async () => false, stopBackgroundTask: async () => false,
        resolveToolApproval: () => {}, getPendingApprovalsForSession: () => [],
        async run(provider, command, _options, writer) {
          assert.equal(provider, 'codex');
          commands.push(command);
          writer.setSessionId?.('gpt-native');
          const user = message('c-user-' + commands.length, 'user', command, 'codex');
          const reply = message('c-reply-' + commands.length, 'assistant', '薄荷', 'codex');
          codexMessages.push(user, reply);
          writer.send(user);
          writer.send(reply);
        },
      };
      assert.equal((await runDetachedChatTurn({ sessionId: 'agy-original', userId: null, content: '项目代号是什么？' }, { runtime })).error, null);
      assert.match(commands[0], /记住项目代号是薄荷/);
      assert.ok(commands[0].endsWith('Current user message:\n项目代号是什么？'));
      assert.equal(chatRunRegistry.getRun('agy-original')?.events.find(item => item.role === 'user')?.content, '项目代号是什么？');
      assert.equal((await runDetachedChatTurn({ sessionId: 'agy-original', userId: null, content: '再说一次' }, { runtime })).error, null);
      assert.equal(commands[1], '再说一次', 'subsequent turns resume the new native session without replaying the prefix');

      const latest = await sessionsService.fetchHistory('agy-original', { limit: 3 });
      assert.equal(latest.total, 6);
      assert.equal(latest.hasMore, true);
      assert.deepEqual(latest.messages.map(item => item.content), ['薄荷', '再说一次', '薄荷']);
      const older = await sessionsService.fetchHistory('agy-original', { limit: 3, offset: 3 });
      assert.deepEqual(older.messages.map(item => item.content), ['记住项目代号是薄荷', '记住了', '项目代号是什么？']);

      await sessionsService.switchSessionProvider('agy-original', 'antigravity', async () => { selections++; });
      assert.equal(sessionsDb.getAllSessions().length, 1);
      assert.equal((await sessionsService.fetchHistory('agy-original')).total, 6);
      const back = sessionsDb.getSessionHandoff('agy-original');
      assert.match(back?.promptPrefix ?? '', /再说一次/);
      assert.equal(back?.messages.filter(item => item.content?.includes('previous_conversation')).length, 0);
      sessionsDb.createSession('gpt-native', 'codex', '/tmp/project', '不应新增');
      assert.equal(sessionsDb.getAllSessions().length, 1);

      // The snapshot survives a real database close/reopen, as it must after a restart.
      closeConnection();
      await initializeDatabase();
      assert.equal(sessionsDb.getSessionById('agy-original')?.provider_session_id, null);
      assert.equal((await sessionsService.fetchHistory('agy-original')).total, 6);
    } finally { agy.fetchHistory = originalAgyHistory; codex.fetchHistory = originalCodexHistory; }
  });
});

test('failed history reads, failed account selection and active runs leave the original mapping intact', async () => {
  await isolated(async () => {
    const agy = providerRegistry.resolveProvider('antigravity').sessions;
    const original = agy.fetchHistory;
    sessionsDb.createSession('switch-failure', 'antigravity', '/tmp/project');
    let selections = 0;
    try {
      agy.fetchHistory = async () => { throw new Error('history unavailable'); };
      await assert.rejects(sessionsService.switchSessionProvider('switch-failure', 'codex', async () => { selections++; }), /history unavailable/);
      assert.equal(selections, 0);
      assert.equal(sessionsDb.getSessionById('switch-failure')?.provider_session_id, 'switch-failure');
      assert.equal(sessionsDb.getSessionHandoff('switch-failure'), null);
      agy.fetchHistory = async () => ({ messages: [], total: 0, hasMore: false, offset: 0, limit: null });
      await assert.rejects(sessionsService.switchSessionProvider('switch-failure', 'codex', async () => { throw new Error('login failed'); }), /login failed/);
      assert.equal(sessionsDb.getSessionById('switch-failure')?.provider, 'antigravity');
      const active = chatRunRegistry.startRun({ appSessionId: 'switch-failure', provider: 'antigravity', providerSessionId: 'switch-failure', connection: null, userId: null });
      try {
        await assert.rejects(sessionsService.switchSessionProvider('switch-failure', 'codex', async () => { selections++; }), { code: 'SESSION_BUSY' });
        assert.equal(selections, 0);
      } finally { if (active) chatRunRegistry.completeRunIfCurrent(active, { exitCode: 0 }); }
    } finally { agy.fetchHistory = original; }
  });
});

test('a handoff blocks normal and scheduled sends until the snapshot commits', async () => {
  await isolated(async () => {
    const agy = providerRegistry.resolveProvider('antigravity').sessions;
    const original = agy.fetchHistory;
    sessionsDb.createSession('switch-lock', 'antigravity', '/tmp/project');
    let unblock!: () => void;
    let entered!: () => void;
    const pending = new Promise<void>(resolve => { unblock = resolve; });
    const reading = new Promise<void>(resolve => { entered = resolve; });
    agy.fetchHistory = async () => { entered(); await pending; return { messages: [], total: 0, hasMore: false, offset: 0, limit: null }; };
    const runtime: ProviderRuntimeGateway = {
      hasRuntime: () => true, hasBackgroundWork: () => false,
      abort: async () => { throw new Error('A handoff must not be aborted as a model run'); },
      stopBackgroundTask: async () => false, resolveToolApproval: () => {}, getPendingApprovalsForSession: () => [],
      run: async () => { throw new Error('A concurrent turn must not run'); },
    };
    const switching = sessionsService.switchSessionProvider('switch-lock', 'codex', async () => {});
    try {
      await reading;
      for (const interruptActiveRun of [false, true]) {
        const result = await runDetachedChatTurn({ sessionId: 'switch-lock', userId: null, content: '定时消息', interruptActiveRun }, { runtime });
        assert.equal(result.started, false);
      }
      await assert.rejects(sessionsService.switchSessionProvider('switch-lock', 'claude', async () => {}), { code: 'SESSION_BUSY' });
      unblock();
      await switching;
      const next = chatRunRegistry.startRun({ appSessionId: 'switch-lock', provider: 'codex', providerSessionId: null, connection: null, userId: null });
      assert.ok(next, 'the handoff releases its lock after commit');
      chatRunRegistry.completeRunIfCurrent(next, { exitCode: 0 });
    } finally { unblock(); await switching; agy.fetchHistory = original; }
  });
});

test('large and legacy handoffs use bounded excerpts while retaining every original message', async () => {
  await isolated(async () => {
    const agy = providerRegistry.resolveProvider('antigravity').sessions;
    const original = agy.fetchHistory;
    const messages = [message('first', 'user', 'original project goal', 'antigravity'),
      ...Array.from({ length: 90 }, (_, index) => ({ ...message('tool-' + index, 'assistant', '', 'antigravity'),
        kind: 'tool_use' as const, toolName: 'shell', toolResult: { content: 'x'.repeat(200_000) } })),
      message('latest', 'user', 'latest user requirement', 'antigravity')];
    agy.fetchHistory = async () => ({ messages, total: messages.length, hasMore: false, offset: 0, limit: null });
    let archive: string | undefined;
    try {
      sessionsDb.createSession('large-switch', 'antigravity', '/tmp/project');
      await sessionsService.switchSessionProvider('large-switch', 'codex', async () => {});
      const handoff = sessionsDb.getSessionHandoff('large-switch')!;
      assert.ok(handoff.promptPrefix.length < 100_000);
      assert.match(handoff.promptPrefix, /original project goal/);
      assert.match(handoff.promptPrefix, /latest user requirement/);
      assert.match(handoff.promptPrefix, /History excerpt/);
      archive = JSON.parse(handoff.promptPrefix.match(/preserved at ("[^\n]+?")\./)![1]);
      const full = (await readFile(archive!, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      assert.equal(full.length, messages.length);
      assert.equal(full[1].toolResult.content.length, 200_000);
      assert.equal((await stat(archive!)).mode & 0o777, 0o600);
      assert.equal((await sessionsService.fetchHistory('large-switch')).total, messages.length);

      // Rows created by the old release must also be repaired on dispatch,
      // without resetting the selected model, title, or snapshot.
      sessionsDb.setSessionHandoffPrompt('large-switch', 'legacy'.repeat(200_000));
      sessionsDb.setSessionModel('large-switch', 'chosen-model');
      assert.equal(await sessionsService.prepareHandoffPrompt('large-switch'), handoff.promptPrefix);
      assert.equal(sessionsDb.getSessionHandoff('large-switch')!.messages.length, messages.length);
      assert.equal(sessionsDb.getSessionById('large-switch')!.model, 'chosen-model');
      assert.equal(sessionsDb.getSessionById('large-switch')!.provider_session_id, null);
    } finally {
      agy.fetchHistory = original;
      if (archive) await rm(archive, { force: true });
    }
  });
});
