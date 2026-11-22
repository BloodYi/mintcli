import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';
import { sessionsService } from '@/modules/providers/services/sessions.service.js';
import type { NormalizedMessage } from '@/shared/types.js';

const makeMsg = (
  sessionId: string,
  id: string,
  role: 'user' | 'assistant',
  content: string,
  provider: 'antigravity' | 'cursor',
): NormalizedMessage => ({
  id,
  role,
  content,
  provider,
  sessionId,
  kind: 'text',
  timestamp: '2026-11-21T18:00:00Z',
  ...(role === 'user' ? { transcriptAnchorId: id } : {}),
});

async function isolated(run: () => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'session-recall-'));
  const previous = process.env.DATABASE_PATH;
  closeConnection();
  process.env.DATABASE_PATH = path.join(directory, 'auth.db');
  await writeFile(process.env.DATABASE_PATH, '');
  await initializeDatabase();
  try {
    await run();
  } finally {
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous;
    await rm(directory, { recursive: true, force: true });
  }
}

test('recallSessionMessage delegates to antigravity native recall for latest and earlier turns', async () => {
  await isolated(async () => {
    const agy = providerRegistry.resolveProvider('antigravity').sessions;
    const originalFetchHistory = agy.fetchHistory;
    const originalRecallMessage = agy.recallMessage;

    let store: NormalizedMessage[] = [
      makeMsg('agy-1', 'u1', 'user', 'first prompt', 'antigravity'),
      makeMsg('agy-1', 'a1', 'assistant', 'first reply', 'antigravity'),
      makeMsg('agy-1', 'u2', 'user', 'second prompt', 'antigravity'),
      makeMsg('agy-1', 'a2', 'assistant', 'second reply', 'antigravity'),
      makeMsg('agy-1', 'u3', 'user', 'third prompt', 'antigravity'),
      makeMsg('agy-1', 'a3', 'assistant', 'third reply', 'antigravity'),
    ];

    const calls: Array<{ sessionId: string; messageId?: string; userTurnFromEnd?: number }> = [];
    agy.fetchHistory = async () => ({
      messages: store,
      total: store.length,
      hasMore: false,
      offset: 0,
      limit: null,
    });
    agy.recallMessage = async (sessionId, input) => {
      calls.push({ sessionId, ...input });
      const idx = store.findIndex((msg) => msg.id === input.messageId);
      if (idx < 0) return false;
      store = store.slice(0, idx);
      return true;
    };

    try {
      sessionsDb.createSession('agy-1', 'antigravity', '/tmp/project', 'Test');

      // Recall latest user message
      const latest = await sessionsService.recallSessionMessage('agy-1', { userTurnFromEnd: 0 });
      assert.equal(latest.recalledContent, 'third prompt');
      assert.equal(latest.isLatestUserMessage, true);
      assert.equal(latest.removedCount, 2);
      assert.equal(latest.remainingCount, 4);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].messageId, 'u3');

      // Recall first user message -> removes everything
      const earlier = await sessionsService.recallSessionMessage('agy-1', { anchorId: 'u1' });
      assert.equal(earlier.recalledContent, 'first prompt');
      assert.equal(earlier.isLatestUserMessage, false);
      assert.equal(earlier.removedCount, 4);
      assert.equal(earlier.remainingCount, 0);
      assert.equal(store.length, 0);
    } finally {
      agy.fetchHistory = originalFetchHistory;
      agy.recallMessage = originalRecallMessage;
    }
  });
});

test('recallSessionMessage rewinds via handoff fallback when provider has no native recall', async () => {
  await isolated(async () => {
    const cursor = providerRegistry.resolveProvider('cursor').sessions;
    const originalFetchHistory = cursor.fetchHistory;
    const history: NormalizedMessage[] = [
      makeMsg('cur-1', 'u1', 'user', 'initial question', 'cursor'),
      makeMsg('cur-1', 'a1', 'assistant', 'initial answer', 'cursor'),
      makeMsg('cur-1', 'u2', 'user', 'follow-up question', 'cursor'),
      makeMsg('cur-1', 'a2', 'assistant', 'follow-up answer', 'cursor'),
    ];
    cursor.fetchHistory = async () => ({
      messages: history,
      total: history.length,
      hasMore: false,
      offset: 0,
      limit: null,
    });

    try {
      sessionsDb.createSession('cur-1', 'cursor', '/tmp/project', 'Cursor Test');

      const result = await sessionsService.recallSessionMessage('cur-1', { userTurnFromEnd: 0 });
      assert.equal(result.recalledContent, 'follow-up question');
      assert.equal(result.isLatestUserMessage, true);
      assert.equal(result.removedCount, 2);
      assert.equal(result.remainingCount, 2);

      const session = sessionsDb.getSessionById('cur-1');
      assert.equal(session?.provider_session_id, null);

      const handoff = sessionsDb.getSessionHandoff('cur-1');
      assert.ok(handoff);
      assert.deepEqual(
        handoff.messages.map((msg) => msg.content),
        ['initial question', 'initial answer'],
      );
      assert.match(handoff.promptPrefix, /initial question/);

      // Recalling the very first message clears the handoff completely
      const fullReset = await sessionsService.recallSessionMessage('cur-1', { userTurnFromEnd: 0 });
      assert.equal(fullReset.recalledContent, 'initial question');
      assert.equal(fullReset.remainingCount, 0);
      assert.equal(sessionsDb.getSessionHandoff('cur-1'), null);
    } finally {
      cursor.fetchHistory = originalFetchHistory;
    }
  });
});
