import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readOfficialCatalog } from '../catalog.service.js';

test('live catalogs isolate credentials, hide retired models, keep future names and actual efforts, and invalidate after authorization changes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-catalog-'));
  const original = globalThis.fetch; const calls: string[] = [];
  globalThis.fetch = (async (_url, init) => {
    const token = (init?.headers as Record<string, string>).Authorization; calls.push(token);
    return new Response(JSON.stringify({ models: [
      { slug: token.endsWith('A') ? 'future-a' : 'future-b', display_name: 'Live', visibility: 'list', supported_reasoning_levels: [{ effort: 'future-depth' }], default_reasoning_level: 'future-depth' },
      { slug: 'old-hidden', visibility: 'hide' }, { slug: 'old-shutdown', visibility: 'list', shutdown_date: '2000-01-01' },
    ] }), { status: 200 });
  }) as typeof fetch;
  try {
    const a = path.join(root, 'a'), b = path.join(root, 'b');
    for (const [home, token] of [[a, 'A'], [b, 'B']]) { await mkdir(home); await writeFile(path.join(home, 'auth.json'), JSON.stringify({ tokens: { access_token: token } })); }
    const [one, same, other] = await Promise.all([readOfficialCatalog(a, { CODEX_HOME: a }), readOfficialCatalog(a, { CODEX_HOME: a }), readOfficialCatalog(b, { CODEX_HOME: b })]);
    assert.equal(calls.length, 2); assert.deepEqual(one, same); assert.deepEqual(one.OPTIONS.map(x => x.value), ['future-a']);
    assert.deepEqual(one.OPTIONS[0].effort?.values, [{ value: 'future-depth' }]); assert.equal(other.DEFAULT, 'future-b');
    await writeFile(path.join(a, 'auth.json'), JSON.stringify({ tokens: { access_token: 'C' } }));
    assert.equal((await readOfficialCatalog(a, { CODEX_HOME: a })).DEFAULT, 'future-b'); assert.equal(calls.length, 3);
  } finally { globalThis.fetch = original; }
});

test('an unavailable official catalog reports failure without cached or bundled fallback or secret details', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-unavailable-'));
  await writeFile(path.join(root, 'auth.json'), JSON.stringify({ tokens: { access_token: 'FAKE-PRIVATE' } }));
  const original = globalThis.fetch; globalThis.fetch = (async () => new Response('FAKE-PRIVATE', { status: 503 })) as typeof fetch;
  try { await assert.rejects(readOfficialCatalog(root, { CODEX_HOME: root }), error => error instanceof Error && /503/.test(error.message) && !error.message.includes('FAKE-PRIVATE')); }
  finally { globalThis.fetch = original; }
});
