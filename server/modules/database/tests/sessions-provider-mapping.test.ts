import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { sessionsDb } from '@/modules/database/repositories/sessions.db.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'sessions-mapping-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('disk-discovered sessions are keyed by the provider id for both columns', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createSession('provider-abc', 'claude', '/workspace/demo', 'From Disk');

    const row = sessionsDb.getSessionById('provider-abc');
    assert.equal(row?.session_id, 'provider-abc');
    assert.equal(row?.provider_session_id, 'provider-abc');

    const byProviderId = sessionsDb.getSessionByProviderSessionId('provider-abc');
    assert.equal(byProviderId?.session_id, 'provider-abc');
  });
});

test('app sessions get the provider id assigned without creating a duplicate row', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-id-1', 'claude', '/workspace/demo', 'Initial CloudCLI message');
    sessionsDb.assignProviderSessionId('app-id-1', 'provider-xyz');

    // A later synchronizer pass that discovers the transcript on disk must
    // update the app row in place instead of inserting a provider-keyed row.
    const returnedId = sessionsDb.createSession(
      'provider-xyz',
      'claude',
      '/workspace/demo',
      'Synced Name',
      undefined,
      undefined,
      '/fake/path/provider-xyz.jsonl',
    );

    assert.equal(returnedId, 'app-id-1');
    assert.equal(sessionsDb.getAllSessions().length, 1);

    const row = sessionsDb.getSessionById('app-id-1');
    assert.equal(row?.provider_session_id, 'provider-xyz');
    assert.equal(row?.jsonl_path, '/fake/path/provider-xyz.jsonl');
    assert.equal(row?.custom_name, 'Initial CloudCLI message');
  });
});

test('assignProviderSessionId merges a watcher-created duplicate into the app row', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-id-2', 'codex', '/workspace/demo');

    // Simulate the race: the filesystem watcher indexed the provider
    // transcript before the runtime announced its session id to the gateway.
    sessionsDb.createSession(
      'provider-race',
      'codex',
      '/workspace/demo',
      'Watcher Name',
      undefined,
      undefined,
      '/fake/provider-race.jsonl',
    );
    assert.equal(sessionsDb.getAllSessions().length, 2);

    sessionsDb.assignProviderSessionId('app-id-2', 'provider-race');

    const rows = sessionsDb.getAllSessions();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.session_id, 'app-id-2');
    assert.equal(rows[0]?.provider_session_id, 'provider-race');
    // Transcript path and name from the duplicate are adopted.
    assert.equal(rows[0]?.jsonl_path, '/fake/provider-race.jsonl');
    assert.equal(rows[0]?.custom_name, 'Watcher Name');
  });
});

test('legacy provider-keyed rows stay resolvable through both lookups', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createSession('legacy-1', 'opencode', '/workspace/demo');

    assert.equal(sessionsDb.getSessionById('legacy-1')?.provider, 'opencode');
    assert.equal(sessionsDb.getSessionByProviderSessionId('legacy-1')?.session_id, 'legacy-1');
  });
});

test('full startup preserves pending, detached and handoff mappings across repeated restarts', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('pending-app', 'codex', '/workspace/demo');
    sessionsDb.createAppSession('detached-app', 'codex', '/workspace/demo');
    sessionsDb.assignProviderSessionId('detached-app', 'old-native');
    sessionsDb.detachProviderSession('detached-app');
    sessionsDb.createSession('original-agy', 'antigravity', '/workspace/demo', 'Keep title');
    sessionsDb.switchSessionProvider('original-agy', 'codex', [], 'Keep handoff prefix');
    sessionsDb.createSession('real-native', 'codex', '/workspace/demo');

    for (let restart = 0; restart < 2; restart++) {
      closeConnection();
      await initializeDatabase();
      for (const id of ['pending-app', 'detached-app', 'original-agy']) {
        assert.equal(sessionsDb.getSessionById(id)?.provider_session_id, null, id + ' must start a new native thread');
      }
      assert.equal(sessionsDb.getSessionById('real-native')?.provider_session_id, 'real-native');
      assert.equal(sessionsDb.getSessionById('original-agy')?.custom_name, 'Keep title');
      assert.equal(sessionsDb.getSessionHandoff('original-agy')?.promptPrefix, 'Keep handoff prefix');
    }
  });
});

test('legacy tables get native ids once without backfilling later app-created rows', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createSession('legacy-native', 'codex', '/workspace/demo');
    // Reproduce a database from before provider-native mapping was added.
    getConnection().exec('DROP INDEX idx_sessions_provider_session_id; ALTER TABLE sessions DROP COLUMN provider_session_id');
    closeConnection();
    await initializeDatabase();
    assert.equal(sessionsDb.getSessionById('legacy-native')?.provider_session_id, 'legacy-native');
    sessionsDb.createAppSession('created-after-upgrade', 'codex', '/workspace/demo');
    closeConnection();
    await initializeDatabase();
    assert.equal(sessionsDb.getSessionById('created-after-upgrade')?.provider_session_id, null);
    assert.equal(sessionsDb.getSessionById('legacy-native')?.provider_session_id, 'legacy-native');
  });
});
