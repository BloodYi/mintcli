import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, projectsDb, sessionsDb } from '@/modules/database/index.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';
import { searchConversations } from '@/modules/providers/services/session-conversations-search.service.js';
import type { LLMProvider, NormalizedMessage } from '@/shared/types.js';

async function isolated(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'conversation-search-'));
  const previous = process.env.DATABASE_PATH;
  closeConnection();
  process.env.DATABASE_PATH = path.join(directory, 'auth.db');
  await writeFile(process.env.DATABASE_PATH, '');
  await initializeDatabase();
  try {
    await run(directory);
  } finally {
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous;
    await rm(directory, { recursive: true, force: true });
  }
}

function message(provider: LLMProvider, content: string, role: 'user' | 'assistant' = 'assistant'): NormalizedMessage {
  return { id: `${role}:${content}`, provider, content, role, kind: 'text', sessionId: 'native-id', timestamp: '2026-11-14T06:00:00Z' };
}

for (const provider of ['antigravity', 'cursor', 'opencode'] as const) {
  test(`${provider}: search covers old user and assistant messages without a JSONL path`, async () => {
    await isolated(async () => {
      sessionsDb.createAppSession('app-id', provider, '/tmp/search-project', 'Unrelated title');
      sessionsDb.assignProviderSessionId('app-id', 'native-id');
      const adapter = providerRegistry.resolveProvider(provider).sessions;
      const original = adapter.fetchHistory;
      adapter.fetchHistory = async (id, options) => {
        assert.equal(id, 'app-id');
        assert.equal(options?.providerSessionId, 'native-id');
        assert.equal(options?.limit, null, 'search must read beyond the latest history page');
        const messages = [message(provider, '以前聊过薄荷搜索功能', 'user'),
          message(provider, '这段回复也包含薄荷搜索功能'),
          ...Array.from({ length: 100 }, () => message(provider, 'unrelated recent message'))];
        return { messages, total: messages.length, hasMore: false, offset: 0, limit: null };
      };
      try {
        const updates: string[] = [];
        const result = await searchConversations('薄荷搜索', 50, update => {
          if (update.projectResult) updates.push(update.projectResult.sessions[0].sessionId);
        });
        assert.equal(result.titleResults.length, 0);
        assert.equal(result.totalMatches, 2);
        assert.deepEqual(updates, ['app-id']);
        const session = result.results[0].sessions[0];
        assert.equal(session.sessionId, 'app-id');
        assert.equal(session.provider, provider);
        assert.deepEqual(session.matches.map(match => match.role), ['user', 'assistant']);
        assert.equal(session.matches[0].snippet, '以前聊过薄荷搜索功能');
        const hit = session.matches[0];
        assert.equal(hit.snippet.slice(hit.highlights[0].start, hit.highlights[0].end), '薄荷搜索');
        assert.equal(hit.timestamp, '2026-11-14T06:00:00Z');
      } finally { adapter.fetchHistory = original; }
    });
  });
}

test('engine handoffs search the retained prefix before a new transcript exists', async () => {
  await isolated(async () => {
    sessionsDb.createSession('old-agy', 'antigravity', '/tmp/search-project', 'Switched conversation');
    sessionsDb.switchSessionProvider('old-agy', 'codex', [message('antigravity', '保留下来的旧对话内容')], 'private transport prefix');
    const result = await searchConversations('旧对话');
    const hit = result.results[0].sessions[0];
    assert.equal(result.totalMatches, 1);
    assert.equal(hit.sessionId, 'old-agy');
    assert.equal(hit.provider, 'codex', 'navigation must use the current engine');
    assert.equal(hit.matches[0].snippet, '保留下来的旧对话内容');
  });
});

test('handoffs search both old history and new native content while hiding transport context', async () => {
  await isolated(async directory => {
    sessionsDb.createSession('app-switch', 'antigravity', '/tmp/search-project');
    sessionsDb.switchSessionProvider('app-switch', 'codex', [message('antigravity', 'earlier needle')], 'hidden needle context\n');
    const file = path.join(directory, 'new.jsonl');
    await writeFile(file, '{}\n');
    sessionsDb.assignProviderSessionId('app-switch', 'new-native');
    sessionsDb.createSession('new-native', 'codex', '/tmp/search-project', undefined, undefined, undefined, file);
    const adapter = providerRegistry.resolveProvider('codex').sessions;
    const original = adapter.fetchHistory;
    adapter.fetchHistory = async () => {
      const messages = [message('codex', 'hidden needle context\nnew prompt', 'user'), message('codex', 'later needle')];
      return { messages, total: messages.length, hasMore: false, offset: 0, limit: null };
    };
    try {
      const result = await searchConversations('needle');
      assert.deepEqual(result.results[0].sessions[0].matches.map(hit => hit.snippet), ['earlier needle', 'later needle']);
      assert.equal((await searchConversations('hidden')).totalMatches, 0);
    } finally { adapter.fetchHistory = original; }
  });
});

test('native Claude and Codex logs still return their app-facing session IDs and highlights', async () => {
  await isolated(async directory => {
    for (const provider of ['claude', 'codex'] as const) {
      const file = path.join(directory, `${provider}.jsonl`);
      const entry = provider === 'claude'
        ? { type: 'assistant', sessionId: 'claude-native', uuid: 'row-id', message: { role: 'assistant', content: [{ type: 'text', text: '中文needle内容' }] } }
        : { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '中文needle内容' }] } };
      await writeFile(file, JSON.stringify({ ...entry, timestamp: '2026-11-14T06:00:00Z' }) + '\n');
      sessionsDb.createAppSession(`${provider}-app`, provider, '/tmp/native-search', 'Title');
      sessionsDb.assignProviderSessionId(`${provider}-app`, `${provider}-native`);
      sessionsDb.createSession(`${provider}-native`, provider, '/tmp/native-search', undefined, undefined, undefined, file);
    }
    const result = await searchConversations('needle');
    assert.equal(result.totalMatches, 2);
    assert.deepEqual(result.results[0].sessions.map(session => session.sessionId).sort(), ['claude-app', 'codex-app']);
    assert.ok(result.results[0].sessions.every(session => session.matches[0].highlights.length));
  });
});

test('archived conversations and projects remain excluded; limits and cancellation apply to adapter search', async () => {
  await isolated(async () => {
    for (const id of ['active', 'archived', 'archived-project']) {
      sessionsDb.createSession(id, 'antigravity', `/tmp/${id}`, 'needle title');
    }
    sessionsDb.updateSessionIsArchived('archived', true);
    projectsDb.updateProjectIsArchived('/tmp/archived-project', true);
    const adapter = providerRegistry.resolveProvider('antigravity').sessions;
    const original = adapter.fetchHistory;
    let reads = 0;
    adapter.fetchHistory = async id => {
      reads++;
      assert.equal(id, 'active');
      const messages = [message('antigravity', 'first needle'), message('antigravity', 'second needle')];
      return { messages, total: 2, hasMore: false, offset: 0, limit: null };
    };
    try {
      const result = await searchConversations('needle', 1);
      assert.equal(result.totalMatches, 1);
      assert.deepEqual(result.titleResults.map(session => session.sessionId), ['active']);
      assert.deepEqual(result.results.flatMap(project => project.sessions.map(session => session.sessionId)), ['active']);
      const controller = new AbortController();
      controller.abort();
      assert.equal((await searchConversations('needle', 50, null, controller.signal)).totalMatches, 0);
      assert.equal(reads, 1);
    } finally { adapter.fetchHistory = original; }
  });
});

test('one unavailable provider history does not suppress matches from another conversation', async () => {
  await isolated(async () => {
    sessionsDb.createSession('unavailable', 'antigravity', '/tmp/search-project');
    sessionsDb.createSession('available', 'antigravity', '/tmp/search-project');
    const adapter = providerRegistry.resolveProvider('antigravity').sessions;
    const original = adapter.fetchHistory;
    adapter.fetchHistory = async id => {
      if (id === 'unavailable') throw new Error('temporary bridge failure');
      return { messages: [message('antigravity', 'available needle')], total: 1, hasMore: false, offset: 0, limit: null };
    };
    try {
      const result = await searchConversations('needle');
      assert.equal(result.totalMatches, 1);
      assert.equal(result.results[0].sessions[0].sessionId, 'available');
    } finally { adapter.fetchHistory = original; }
  });
});
