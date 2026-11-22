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

type GatewayOptions = {
  supportLiveInject?: boolean;
  cleanupDelayMs?: number;
};

async function withGateway(
  options: GatewayOptions,
  check: (context: {
    send: (type: string, content?: string) => Promise<void>;
    calls: string[];
    injected: string[];
    aborts: number[];
    frames: AnyRecord[];
    finishes: Array<() => void>;
  }) => Promise<void>,
) {
  const oldPath = process.env.DATABASE_PATH;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'send-now-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(directory, 'auth.db');
  await initializeDatabase();
  const socket = new EventEmitter();
  const frames: AnyRecord[] = [];
  Object.assign(socket, { readyState: 1, send: (value: string) => frames.push(JSON.parse(value)) });
  const calls: string[] = [];
  const injected: string[] = [];
  const aborts: number[] = [];
  const finishes: Array<() => void> = [];
  let stop: (() => void) | undefined;
  const cleanupDelayMs = options.cleanupDelayMs ?? 20;
  try {
    sessionsDb.createAppSession('s1', 'claude', directory);
    handleChatConnection(socket as never, { user: { id: 1 } } as never, {
      runtime: {
        hasRuntime: () => true,
        run: async (_provider: string, content: string, _options: AnyRecord, writer: ProviderRuntimeWriter) => {
          calls.push(content);
          const index = calls.length;
          await new Promise<void>((resolve) => {
            stop = () => {
              setTimeout(() => {
                calls.push(`aborted-close-${index}`);
                resolve();
              }, cleanupDelayMs);
            };
            finishes.push(() => {
              writer.send({ kind: 'complete', provider: 'claude', sessionId: 's1', exitCode: 0 });
              // Cleanup can finish after `complete` has already been emitted.
              setTimeout(() => {
                calls.push(`closed-${index}`);
                resolve();
              }, cleanupDelayMs);
            });
          });
        },
        injectMessage: options.supportLiveInject
          ? async (_provider: string, _sessionId: string, content: string) => {
              injected.push(content);
              return true;
            }
          : async () => false,
        abort: async () => {
          aborts.push(Date.now());
          stop?.();
          return true;
        },
        hasBackgroundWork: () => false,
      } as never,
    });
    const send = async (type: string, content?: string) => {
      const listener = socket.listeners('message')[0] as (raw: string) => Promise<void>;
      await listener(JSON.stringify(
        content === undefined ? { type, sessionId: 's1' } : { type, sessionId: 's1', content },
      ));
    };
    await check({ send, calls, injected, aborts, frames, finishes });
  } finally {
    finishes.forEach((finish) => finish());
    await delay(50);
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

test('chat.send injects live into an active run without aborting or interrupting it', async () => {
  await withGateway({ supportLiveInject: true }, async ({ send, calls, injected, aborts, frames }) => {
    void send('chat.send', 'original task');
    await until(() => calls.length === 1);

    await send('chat.send', 'new constraint');
    await send('chat.send-now', 'second constraint');

    assert.deepEqual(calls, ['original task']);
    assert.deepEqual(injected, ['new constraint', 'second constraint']);
    assert.equal(aborts.length, 0);
    assert.equal(frames.filter((frame) => frame.kind === 'complete' && frame.aborted).length, 0);
    assert.equal(chatRunRegistry.isProcessing('s1'), true);
  });
});

test('turn-based providers queue follow-ups without aborting and run them in order after settlement', async () => {
  await withGateway({ supportLiveInject: false, cleanupDelayMs: 25 }, async ({ send, calls, aborts, frames, finishes }) => {
    void send('chat.send', 'turn A');
    await until(() => calls.length === 1);

    await Promise.all([send('chat.send', 'follow-up B'), send('chat.send', 'follow-up C')]);

    // Turn A must keep running untouched until it finishes on its own.
    assert.deepEqual(calls, ['turn A']);
    assert.equal(aborts.length, 0);
    assert.equal(frames.filter((frame) => frame.kind === 'complete' && frame.aborted).length, 0);

    // Finish turn A: follow-up B should start only after turn A's cleanup closes.
    finishes[0]();
    await until(() => calls.length === 3);
    assert.deepEqual(calls, ['turn A', 'closed-1', 'follow-up B']);
    assert.equal(chatRunRegistry.isProcessing('s1'), true);
    assert.ok(frames.some((frame) => frame.kind === 'status' && frame.sessionId === 's1'));

    // Finish follow-up B: follow-up C runs next after B closes.
    finishes[1]();
    await until(() => calls.length === 5);
    assert.deepEqual(calls, ['turn A', 'closed-1', 'follow-up B', 'closed-3', 'follow-up C']);
    assert.equal(aborts.length, 0);
  });
});

test('a follow-up arriving between complete and process cleanup waits for cleanup before starting', async () => {
  await withGateway({ supportLiveInject: false, cleanupDelayMs: 40 }, async ({ send, calls, finishes }) => {
    void send('chat.send', 'turn A');
    await until(() => calls.length === 1);
    await send('chat.send', 'follow-up B');

    // Emit `complete` for turn A, then immediately send follow-up C before A's 40ms cleanup resolves.
    finishes[0]();
    await send('chat.send', 'follow-up C');

    await until(() => calls.length === 3);
    assert.deepEqual(calls, ['turn A', 'closed-1', 'follow-up B']);

    finishes[1]();
    await until(() => calls.length === 5);
    assert.deepEqual(calls, ['turn A', 'closed-1', 'follow-up B', 'closed-3', 'follow-up C']);
  });
});

test('chat.abort cancels the active run and drops any queued follow-ups', async () => {
  await withGateway({ supportLiveInject: false }, async ({ send, calls, aborts, frames }) => {
    void send('chat.send', 'turn A');
    await until(() => calls.length === 1);
    await send('chat.send', 'follow-up B');

    await send('chat.abort');
    await delay(50);

    assert.equal(aborts.length, 1);
    assert.deepEqual(calls, ['turn A', 'aborted-close-1']);
    assert.equal(frames.filter((frame) => frame.kind === 'complete' && frame.aborted).length, 1);
    assert.equal(chatRunRegistry.isProcessing('s1'), false);
  });
});

test('empty follow-up while running leaves the current run untouched', async () => {
  await withGateway({ supportLiveInject: true }, async ({ send, calls, injected, frames }) => {
    void send('chat.send', 'A');
    await until(() => calls.length === 1);
    await send('chat.send', '   ');
    assert.deepEqual(calls, ['A']);
    assert.deepEqual(injected, []);
    assert.equal(frames.at(-1)?.code, 'CONTENT_REQUIRED');
    assert.equal(chatRunRegistry.isProcessing('s1'), true);
  });
});

test('legacy chat.send-now also starts a turn normally when idle', async () => {
  await withGateway({ supportLiveInject: true }, async ({ send, calls }) => {
    await send('chat.send-now', 'hello');
    await until(() => calls.length === 1);
    assert.deepEqual(calls, ['hello']);
  });
});
