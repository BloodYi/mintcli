import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, chmod, readlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { activateRelease } from '../update-provider-cli.mjs';

// Fake local binaries exercise activation and rollback without contacting release servers.
test('switches only the requested provider, retains its previous release and rolls back failed validation', async () => {
  if (process.platform === 'win32') return;
  const root = await mkdtemp(path.join(os.tmpdir(), 'mintcli-install-'));
  try {
    await mkdir(path.join(root, 'codex/releases'), { recursive: true });
    const release = async (name, code) => {
      const dir = path.join(root, 'codex/releases', name);
      await mkdir(dir);
      await writeFile(path.join(dir, 'codex'), `#!/bin/sh\n${code}\n`);
      await chmod(path.join(dir, 'codex'), 0o755);
      return dir;
    };
    const first = await release('first', 'echo 0.160.1');
    const second = await release('second', 'echo 0.166.0');
    const broken = await release('broken', 'exit 1');
    await activateRelease(root, 'codex', first, 'codex');
    await mkdir(path.join(root, 'cursor'), { recursive: true });
    await writeFile(path.join(root, 'cursor/untouched'), 'original');
    await activateRelease(root, 'codex', second, 'codex');
    assert.equal(await readlink(path.join(root, 'codex/current')), second);
    await assert.rejects(activateRelease(root, 'codex', broken, 'codex'));
    assert.equal(await readlink(path.join(root, 'codex/current')), second);
    const { readFile } = await import('node:fs/promises');
    assert.equal(await readFile(path.join(root, 'cursor/untouched'), 'utf8'), 'original');
    assert.equal(await readFile(path.join(first, 'codex'), 'utf8'), '#!/bin/sh\necho 0.160.1\n');
  } finally { await rm(root, { recursive: true, force: true }); }
});
