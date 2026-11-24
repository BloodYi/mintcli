import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeAccounts, formatClaudeSubscriptionTier } from '../accounts.service.js';

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

test('Claude accounts extract official subscription tiers including Max 5x/20x and Team Standard/Premium', () => {
  assert.equal(formatClaudeSubscriptionTier('max', 'default_claude_max_5x'), 'Max 5x');
  assert.equal(formatClaudeSubscriptionTier('max', 'default_claude_max_20x'), 'Max 20x');
  assert.equal(formatClaudeSubscriptionTier('max'), 'Max');
  assert.equal(formatClaudeSubscriptionTier('pro', 'default_claude_ai'), 'Pro');
  assert.equal(formatClaudeSubscriptionTier('team', 'default_claude_max_5x'), 'Team Premium');
  assert.equal(formatClaudeSubscriptionTier('team', undefined, 'team_tier_1'), 'Team Premium');
  assert.equal(formatClaudeSubscriptionTier('team', undefined, 'team_standard'), 'Team Standard');
  assert.equal(formatClaudeSubscriptionTier('team', 'default_claude_max_20x'), 'Team 20x');
  assert.equal(formatClaudeSubscriptionTier('team'), 'Team');
  assert.equal(formatClaudeSubscriptionTier('enterprise', undefined, 'enterprise_tier_1'), 'Enterprise Premium');
  assert.equal(formatClaudeSubscriptionTier('enterprise', undefined, 'enterprise_standard'), 'Enterprise Standard');
  assert.equal(formatClaudeSubscriptionTier('enterprise'), 'Enterprise');
  assert.equal(formatClaudeSubscriptionTier('free'), 'Free');

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-tiers-'));
  const original = { HOME: process.env.HOME, CLAUDE_ACCOUNTS_ROOT: process.env.CLAUDE_ACCOUNTS_ROOT, CLAUDE_DISABLE_PROFILE_FETCH: process.env.CLAUDE_DISABLE_PROFILE_FETCH };
  process.env.HOME = temp; process.env.CLAUDE_ACCOUNTS_ROOT = path.join(temp, 'store'); process.env.CLAUDE_DISABLE_PROFILE_FETCH = '1';
  try {
    const max5 = claudeAccounts.save({ name: 'M5', credentials: JSON.stringify({ claudeAiOauth: { accessToken: 'tok-5', subscriptionType: 'max', rateLimitTier: 'default_claude_max_5x' } }) });
    const max20 = claudeAccounts.save({ name: 'M20', credentials: JSON.stringify({ claudeAiOauth: { accessToken: 'tok-20', subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x' } }) });
    const teamStd = claudeAccounts.save({ name: 'TS', credentials: JSON.stringify({ claudeAiOauth: { accessToken: 'tok-ts', subscriptionType: 'team' } }) });
    fs.writeFileSync(path.join(claudeAccounts.env(teamStd.id).CLAUDE_CONFIG_DIR, '.claude.json'), JSON.stringify({ oauthAccount: { seatTier: 'team_standard' } }));
    const teamPrem = claudeAccounts.save({ name: 'TP', credentials: JSON.stringify({ claudeAiOauth: { accessToken: 'tok-tp', subscriptionType: 'team' } }) });
    fs.writeFileSync(path.join(claudeAccounts.env(teamPrem.id).CLAUDE_CONFIG_DIR, '.claude.json'), JSON.stringify({ oauthAccount: { seatTier: 'team_tier_1' } }));
    const listed = claudeAccounts.list().accounts;
    assert.equal(listed.find(item => item.id === max5.id)?.subscriptionTier, 'Max 5x');
    assert.equal(listed.find(item => item.id === max20.id)?.subscriptionTier, 'Max 20x');
    assert.equal(listed.find(item => item.id === teamStd.id)?.subscriptionTier, 'Team Standard');
    assert.equal(listed.find(item => item.id === teamPrem.id)?.subscriptionTier, 'Team Premium');
  } finally {
    for (const [key, value] of Object.entries(original)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
