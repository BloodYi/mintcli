import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPDATER_SCRIPT = path.join(__dirname, 'update-provider-cli.mjs');
const DEFAULT_PROVIDERS = ['claude', 'codex', 'cursor', 'opencode', 'antigravity'];
const KEEP_RELEASES = 2;
const MIN_PRUNE_AGE_MS = 24 * 60 * 60 * 1000;
const PROVIDER_TIMEOUT_MS = 10 * 60 * 1000;

function buildDirectEnv() {
  const env = { ...process.env, NO_COLOR: '1' };
  for (const key of [
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY',
    'http_proxy', 'https_proxy', 'all_proxy',
    'WS_PROXY', 'WSS_PROXY', 'NODE_USE_ENV_PROXY',
  ]) {
    delete env[key];
  }
  return env;
}

function runProviderUpdate(provider, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [UPDATER_SCRIPT, provider], {
      stdio: 'inherit',
      shell: false,
      env,
    });
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 10_000).unref();
      reject(new Error(`${provider} update timed out after ${PROVIDER_TIMEOUT_MS / 1000}s`));
    }, PROVIDER_TIMEOUT_MS);

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`${provider} update exited with ${code !== null ? `code ${code}` : `signal ${signal}`}`));
    });
  });
}

async function isPathInUse(targetDir) {
  let procEntries;
  try {
    procEntries = await fs.readdir('/proc');
  } catch {
    return true;
  }
  const needle = targetDir.endsWith(path.sep) ? targetDir : `${targetDir}${path.sep}`;
  for (const entry of procEntries) {
    if (!/^\d+$/.test(entry)) continue;
    const base = `/proc/${entry}`;
    try {
      const exe = await fs.readlink(`${base}/exe`).catch(() => '');
      if (exe.startsWith(needle)) return true;
      const cmdline = await fs.readFile(`${base}/cmdline`, 'utf8').catch(() => '');
      if (cmdline.includes(needle)) return true;
      const maps = await fs.readFile(`${base}/maps`, 'utf8').catch(() => '');
      if (maps.includes(needle)) return true;
    } catch {
      // Process may have exited mid-scan.
    }
  }
  return false;
}

async function pruneOldReleases(root, provider) {
  const providerDir = path.join(root, provider);
  const releasesDir = path.join(providerDir, 'releases');
  const currentLink = path.join(providerDir, 'current');
  const currentTarget = await fs.realpath(currentLink).catch(() => null);
  const entries = await fs.readdir(releasesDir, { withFileTypes: true }).catch(() => []);
  const candidates = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const fullPath = path.join(releasesDir, entry.name);
    const stat = await fs.stat(fullPath).catch(() => null);
    if (!stat) continue;
    candidates.push({ fullPath, mtimeMs: stat.mtimeMs });
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const now = Date.now();
  const kept = new Set();
  if (currentTarget) kept.add(currentTarget);
  for (const item of candidates) {
    if (kept.size >= KEEP_RELEASES) break;
    kept.add(item.fullPath);
  }

  for (const item of candidates) {
    if (kept.has(item.fullPath)) continue;
    if (now - item.mtimeMs < MIN_PRUNE_AGE_MS) continue;
    if (await isPathInUse(item.fullPath)) {
      console.log(`[auto-update] Skipping in-use release: ${item.fullPath}`);
      continue;
    }
    await fs.rm(item.fullPath, { recursive: true, force: true });
    console.log(`[auto-update] Pruned old release: ${item.fullPath}`);
  }
}

const AGY_FAST_ENGINE = path.resolve(__dirname, '../native/antigravity-bridge/agy_fast_engine.py');
const BRIDGE_PYTHON_CANDIDATES = [
  process.env.MINTCLI_BRIDGE_PYTHON || '',
  '/var/lib/mintcli-bridge-venv/bin/python',
  '/var/lib/cloudcli/antigravity-home/.venv/bin/python',
];

function resolveBridgePython() {
  for (const cand of BRIDGE_PYTHON_CANDIDATES) {
    if (!cand) continue;
    try {
      const probe = spawnSync(cand, ['-c', 'import sys'], { stdio: 'ignore', timeout: 5_000 });
      if (probe.status === 0) return cand;
    } catch {
      // Try next candidate
    }
  }
  return 'python3';
}

function runAgyFastAutoUpdate(env) {
  const py = resolveBridgePython();
  return new Promise((resolve, reject) => {
    const child = spawn(py, [AGY_FAST_ENGINE, 'update', '--if-auto'], {
      stdio: 'inherit',
      shell: false,
      env,
    });
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
      reject(new Error('agy-fast update timed out'));
    }, 120_000);
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`agy-fast update exited with ${code !== null ? `code ${code}` : `signal ${signal}`}`));
    });
  });
}

async function main() {
  const root = path.resolve(process.env.MINTCLI_CLI_ROOT || '/var/lib/cloudcli/cli');
  const requested = process.argv.slice(2);
  const onlyAgyFast = requested.length === 1 && requested[0] === 'agy-fast';
  const providers = onlyAgyFast ? [] : (requested.length > 0 ? requested.filter((p) => p !== 'agy-fast') : DEFAULT_PROVIDERS);
  const shouldUpdateAgyFast = requested.length === 0 || requested.includes('agy-fast');
  const env = buildDirectEnv();
  const failures = [];

  for (const provider of providers) {
    console.log(`[auto-update] Checking ${provider}...`);
    try {
      await runProviderUpdate(provider, env);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[auto-update] Failed ${provider}: ${message}`);
      failures.push({ provider, message });
    }
    try {
      await pruneOldReleases(root, provider);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[auto-update] Prune error for ${provider}: ${message}`);
    }
  }

  if (shouldUpdateAgyFast) {
    console.log('[auto-update] Checking agy-fast GitHub plugin...');
    try {
      await runAgyFastAutoUpdate(env);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[auto-update] Failed agy-fast: ${message}`);
      failures.push({ provider: 'agy-fast', message });
    }
  }

  if (failures.length > 0) {
    console.error(`[auto-update] Completed with ${failures.length} failure(s): ${failures.map((f) => f.provider).join(', ')}`);
    process.exitCode = 1;
  } else {
    console.log('[auto-update] All managed CLIs checked successfully.');
  }
}

main();
