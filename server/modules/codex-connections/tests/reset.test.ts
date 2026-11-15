import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { consumeAccountReset, readAccountQuota } from '../quota.service.js';

const fake = `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
 const req=JSON.parse(line);if(req.id===undefined)return;
 fs.appendFileSync(path.join(process.env.CODEX_HOME,'requests'),JSON.stringify(req)+'\\n');
 const result=req.method==='initialize'?{}:req.method==='account/read'?{account:{type:'chatgpt'}}:
 req.method==='account/rateLimitResetCredit/consume'?{outcome:process.env.FAKE_OUTCOME||'reset'}:
 {rateLimits:{primary:{usedPercent:90}},rateLimitResetCredits:{availableCount:2,credits:[
 {id:'fixture-credit',title:'Full reset',description:'fixture',expiresAt:1900000000,status:'available',resetType:'codexRateLimits'},
 {id:'used',status:'redeemed',resetType:'codexRateLimits'},{id:'future',status:'available',resetType:'unknown'}]}};
 setTimeout(()=>console.log(JSON.stringify({id:req.id,result})),10);
});`;

test('quota reads never consume credits; confirmed reset uses native idempotency and invalidates the cached quota', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mintcli-reset-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'codex'); fs.writeFileSync(bin, fake, { mode: 0o700 });
  const env = { PATH: process.env.PATH!, CODEX_HOME: dir, CODEX_QUOTA_BIN: bin };
  const requests = () => fs.readFileSync(path.join(dir, 'requests'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const quota = await readAccountQuota(env);
  assert.equal(quota.resetCredits?.availableCount, 2);
  assert.deepEqual(quota.resetCredits?.credits?.map(credit => credit.id), ['fixture-credit']);
  assert.equal(requests().some(req => req.method.includes('/consume')), false);
  assert.throws(() => consumeAccountReset(env, 'bad-key'), /重置请求格式/);
  const key = '50b918df-cc2c-489b-bd6a-24b16873774c';
  const first = consumeAccountReset(env, key, 'fixture-credit');
  assert.equal(consumeAccountReset(env, key, 'fixture-credit'), first);
  assert.throws(() => consumeAccountReset(env, '20b918df-cc2c-489b-bd6a-24b16873774c'), /正在处理重置/);
  assert.equal((await first).resetOutcome, 'reset');
  assert.equal(consumeAccountReset(env, key, 'fixture-credit'), first);
  const mutations = requests().filter(req => req.method.includes('/consume'));
  assert.equal(mutations.length, 1);
  assert.deepEqual(mutations[0].params, { idempotencyKey: key, creditId: 'fixture-credit' });
  await readAccountQuota(env);
  assert.equal(requests().filter(req => req.method === 'account/rateLimits/read').length, 2);
});

test('native refusal and unknown results are preserved, never reported as a successful reset', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mintcli-reset-outcomes-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'codex'); fs.writeFileSync(bin, fake, { mode: 0o700 });
  for (const outcome of ['noCredit', 'nothingToReset', 'alreadyRedeemed', 'futureOutcome']) {
    const home = path.join(dir, outcome); fs.mkdirSync(home);
    const result = await consumeAccountReset({ PATH: process.env.PATH!, CODEX_HOME: home, CODEX_QUOTA_BIN: bin, FAKE_OUTCOME: outcome }, '50b918df-cc2c-489b-bd6a-24b16873774c');
    assert.equal(result.resetOutcome, outcome === 'futureOutcome' ? undefined : outcome);
    assert.equal(result.status, outcome === 'futureOutcome' ? 'unavailable' : 'completed');
  }
});
