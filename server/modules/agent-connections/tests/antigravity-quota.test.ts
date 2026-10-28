import assert from 'node:assert/strict';
import test from 'node:test';
import { antigravityQuotaSnapshot } from '../antigravity-quota.service.js';

test('keeps model identity and only includes Argon when the account returns it', () => {
  const standard = ['Gemini Models', 'Claude and GPT models'].flatMap(model =>
    ['weekly', 'five_hour'].map(type => ({ model, type, percentage: 100 })));
  const free = antigravityQuotaSnapshot({ timestamp: 1, quotas: standard });
  assert.equal(free.windows.length, 4);
  assert.equal(new Set(free.windows.map(item => item.model)).size, 2);
  assert.ok(!free.windows.some(item => /Argon/.test(item.model)));
  const paid = antigravityQuotaSnapshot({ timestamp: 1, quotas: [...standard, {
    model: 'Gemini 4 Argon', type: 'weekly', type_name: 'Gemini 4 Argon Weekly Limit', percentage: 0,
  }] });
  assert.equal(paid.windows.length, 5);
  assert.equal(paid.windows[4].bucket, 'Gemini 4 Argon Weekly Limit');
  assert.equal(paid.windows[4].remainingPercent, 0);
});
