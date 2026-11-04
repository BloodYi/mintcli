import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CodexProviderAuth } from '@/modules/providers/list/codex/codex-auth.provider.js';
import { resolveManagedCli, resolveCodexLauncher, readCodexVersion } from '@/shared/index.js';

test('Codex version probes and catalog follow the selected private release after a switch', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mintcli-managed-'));
  const previous = { MINTCLI_MANAGED_CLIS: process.env.MINTCLI_MANAGED_CLIS, MINTCLI_CLI_ROOT: process.env.MINTCLI_CLI_ROOT };
  try {
    process.env.MINTCLI_MANAGED_CLIS = '1';
    process.env.MINTCLI_CLI_ROOT = root;
    await mkdir(path.join(root, 'bin'));
    await mkdir(path.join(root, 'codex/current/node_modules/@openai/codex'), { recursive: true });
    const launcher = path.join(root, 'bin/codex');
    const manifest = path.join(root, 'codex/current/node_modules/@openai/codex/package.json');
    await writeFile(launcher, 'console.log("codex-cli 0.166.0")');
    await writeFile(manifest, '{"version":"0.166.0"}');
    assert.equal(resolveManagedCli('codex'), launcher);
    assert.equal(resolveCodexLauncher(), launcher);
    assert.equal(new CodexProviderAuth().checkInstalled().version, '0.166.0');
    assert.equal(readCodexVersion(), '0.166.0');
    await writeFile(manifest, '{"version":"0.167.0"}');
    assert.equal(readCodexVersion(), '0.167.0', 'catalog version must not stay cached after an update');
    process.env.MINTCLI_MANAGED_CLIS = '0';
    assert.equal(resolveManagedCli('codex'), undefined);
    assert.notEqual(resolveCodexLauncher(), launcher);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});
