import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeAccounts } from '../accounts.service.js';

test('Claude profiles isolate authorization, share native history and bind identity for an entire turn', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-accounts-'));
  const original = { HOME: process.env.HOME, CLAUDE_ACCOUNTS_ROOT: process.env.CLAUDE_ACCOUNTS_ROOT, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY };
  process.env.HOME = temp; process.env.CLAUDE_ACCOUNTS_ROOT = path.join(temp, 'store'); process.env.ANTHROPIC_API_KEY = 'must-not-override-native-account';
  try {
    const a = claudeAccounts.save({ name: 'A', credentials: JSON.stringify({ claudeAiOauth: { accessToken: 'fixture-private-a' } }) });
    const b = claudeAccounts.save({ name: 'B', credentials: JSON.stringify({ claudeAiOauth: { accessToken: 'fixture-private-b' } }) });
    claudeAccounts.select(a.id); const turn = claudeAccounts.begin();
    claudeAccounts.select(b.id);
    assert.equal(turn.account.id, a.id);
    assert.notEqual(turn.env.CLAUDE_CONFIG_DIR, claudeAccounts.env(b.id).CLAUDE_CONFIG_DIR);
    assert.equal(turn.env.ANTHROPIC_API_KEY, undefined);
    assert.equal(fs.realpathSync(path.join(turn.env.CLAUDE_CONFIG_DIR, 'projects')), path.join(temp, '.claude', 'projects'));
    assert.throws(() => claudeAccounts.save({ id: a.id, name: 'A', credentials: '{"claudeAiOauth":{"accessToken":"replacement"}}' }));
    assert.throws(() => claudeAccounts.remove(a.id));
    turn.end();
    claudeAccounts.recordQuota(a.id, { type: 'rate_limit_event', rate_limit_info: { utilization: 0.25, rateLimitType: 'five_hour', resetsAt: 1800000000 } });
    assert.equal((await claudeAccounts.quota(a.id)).windows[0].remainingPercent, 75);
    assert.deepEqual((await claudeAccounts.quota(b.id)).windows, []);
    assert.ok(!JSON.stringify(claudeAccounts.list()).includes('fixture-private'));
    assert.equal(fs.statSync(path.join(turn.env.CLAUDE_CONFIG_DIR, '.credentials.json')).mode & 0o777, 0o600);
    assert.throws(() => claudeAccounts.resolve('../escape'));
    assert.throws(() => claudeAccounts.save({ name: 'bad', credentials: '{}' }));
  } finally {
    for (const [key, value] of Object.entries(original)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
