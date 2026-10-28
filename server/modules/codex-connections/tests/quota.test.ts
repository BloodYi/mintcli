import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readAccountQuota } from '../quota.service.js';

const fake = `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
fs.appendFileSync(path.join(process.env.CODEX_HOME, 'spawns'), '1');
const fixture = JSON.parse(process.env.FAKE_QUOTA);
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
  const request = JSON.parse(line); if (request.id === undefined) return;
  const result = request.id === 0 ? {} : request.id === 1 ? { account: { type: 'chatgpt', planType: 'business' } } : fixture;
  console.log(JSON.stringify(fixture.failure ? {id:request.id,error:{message:'secret-should-not-leak'}} : {id:request.id,result}));
});
`;

test('real RPC transport isolates accounts, deduplicates probes, and preserves unknown/new limit fields', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudcli-quota-'));
  const executable = path.join(directory, 'fake-codex'); fs.writeFileSync(executable, fake, {mode:0o700});
  try {
    const make = (name: string, fixture: unknown) => {
      const home = path.join(directory, name); fs.mkdirSync(home);
      return { PATH: process.env.PATH!, CODEX_HOME: home, CODEX_QUOTA_BIN: executable, FAKE_QUOTA: JSON.stringify(fixture) };
    };
    const first = make('a', {rateLimits:{primary:{usedPercent:99}},rateLimitsByLimitId:{codex:{primary:{usedPercent:25,windowDurationMins:300,resetsAt:1800000000}},future_lane:{primary:{usedPercent:null,windowDurationMins:75,resetsAt:null},secondary:{usedPercent:80,windowDurationMins:10080,resetsAt:1800000001}}}});
    const pending = readAccountQuota(first); assert.equal(readAccountQuota(first), pending);
    const a = await pending;
    assert.equal(a.status, 'available'); assert.equal(a.planType, 'business');
    assert.deepEqual(a.windows.map(window => window.remainingPercent), [75,null,20]);
    assert.equal(a.windows[2].minutes, 10080); assert.equal(a.windows[0].resetsAt, 1800000000);
    assert.equal(fs.readFileSync(path.join(first.CODEX_HOME,'spawns'),'utf8'),'1');
    const b = await readAccountQuota(make('b',{rateLimits:{primary:{usedPercent:60,windowDurationMins:300}}}));
    assert.equal(b.windows[0].remainingPercent,40); assert.equal(a.windows[0].remainingPercent,75);
    const failed = await readAccountQuota(make('c',{failure:true}));
    assert.equal(failed.status,'unavailable'); assert.deepEqual(failed.windows,[]);
    assert.ok(!JSON.stringify(failed).includes('secret-should-not-leak'));
  } finally { fs.rmSync(directory,{recursive:true,force:true}); }
});
