import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { handleChatConnection } from '@/modules/websocket/services/chat-websocket.service.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';
import type { AnyRecord, ProviderRuntimeWriter } from '@/shared/types.js';

async function withGateway(check: (context: {
  send: (type: string, content: string) => Promise<void>;
  calls: string[];
  frames: AnyRecord[];
  finishes: Array<() => void>;
}) => Promise<void>) {
  const oldPath = process.env.DATABASE_PATH;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'send-now-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(directory, 'auth.db');
  await initializeDatabase();
  const socket = new EventEmitter();
  const frames: AnyRecord[] = [];
  Object.assign(socket, { readyState: 1, send: (value: string) => frames.push(JSON.parse(value)) });
  const calls: string[] = [];
  const finishes: Array<() => void> = [];
  let stop: (() => void) | undefined;
  try {
    sessionsDb.createAppSession('s1', 'claude', directory);
    handleChatConnection(socket as never, { user: { id: 1 } } as never, { runtime: {
      hasRuntime: () => true,
      run: async (_provider: string, content: string, _options: AnyRecord, writer: ProviderRuntimeWriter) => {
        calls.push(content);
        const index = calls.length;
        await new Promise<void>((resolve) => {
          stop = () => {
            // Cleanup is deliberately delayed beyond the abort acknowledgement.
            setTimeout(() => { calls.push(`closed-${index}`); resolve(); }, 20);
          };
          finishes.push(() => {
            writer.send({ kind: 'complete', provider: 'claude', sessionId: 's1', exitCode: 0 });
            resolve();
          });
        });
      },
      abort: async () => { stop?.(); return true; },
      hasBackgroundWork: () => false,
    } as never });
    const send = async (type: string, content: string) => {
      const listener = socket.listeners('message')[0] as (raw: string) => Promise<void>;
      await listener(JSON.stringify({ type, sessionId: 's1', content }));
    };
    await check({ send, calls, frames, finishes });
  } finally {
    finishes.forEach((finish) => finish());
    await delay(30);
    connectedClients.clear();
    chatRunRegistry.clearAll();
    closeConnection();
    if (oldPath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = oldPath;
    await rm(directory, { recursive: true, force: true });
  }
}

async function until(predicate: () => boolean) {
  for (let count = 0; count < 100 && !predicate(); count++) await delay(10);
  assert.ok(predicate());
}

test('immediate follow-up stops the old turn, waits for cleanup, and preserves a first request without history', async () => {
  await withGateway(async ({ send, calls, frames }) => {
    void send('chat.send', 'original task');
    await until(() => calls.length === 1);
    await send('chat.send-now', 'new constraint');
    await until(() => calls.length === 3);
    assert.deepEqual(calls, ['original task', 'closed-1', 'original task\n\nnew constraint']);
    assert.equal(frames.filter((frame) => frame.kind === 'complete' && frame.aborted).length, 1);
    assert.equal(chatRunRegistry.isProcessing('s1'), true);
  });
});

test('consecutive immediate follow-ups are admitted in order without overlapping runtimes', async () => {
  await withGateway(async ({ send, calls }) => {
    void send('chat.send', 'A');
    await until(() => calls.length === 1);
    await Promise.all([send('chat.send-now', 'B'), send('chat.send-now', 'C')]);
    await until(() => calls.length === 5);
    assert.deepEqual(calls, ['A', 'closed-1', 'A\n\nB', 'closed-3', 'A\n\nB\n\nC']);
    assert.equal(chatRunRegistry.isProcessing('s1'), true);
  });
});

test('empty immediate follow-up leaves the current run untouched', async () => {
  await withGateway(async ({ send, calls, frames }) => {
    void send('chat.send', 'A');
    await until(() => calls.length === 1);
    await send('chat.send-now', '   ');
    assert.deepEqual(calls, ['A']);
    assert.equal(frames.at(-1)?.code, 'CONTENT_REQUIRED');
    assert.equal(chatRunRegistry.isProcessing('s1'), true);
  });
});

test('send now also works when the previous run has already ended', async () => {
  await withGateway(async ({ send, calls }) => {
    await send('chat.send-now', 'hello');
    await until(() => calls.length === 1);
    assert.deepEqual(calls, ['hello']);
  });
});


test('an established session resumes its native history with only the new follow-up', async () => {
  await withGateway(async ({ send, calls }) => {
    void send('chat.send', 'original task');
    await until(() => calls.length === 1);
    chatRunRegistry.getRun('s1')!.writer.setSessionId('native-history');
    await send('chat.send-now', 'new constraint');
    await until(() => calls.length === 3);
    assert.deepEqual(calls, ['original task', 'closed-1', 'new constraint']);
    assert.equal(sessionsDb.getSessionById('s1')?.provider_session_id, 'native-history');
  });
});
