import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import { Agent, fetch as undiciFetch } from 'undici';

const PACKAGES = { codex: '@openai/codex', claude: '@anthropic-ai/claude-code', opencode: 'opencode-ai' };
const BINARIES = { codex: 'codex', claude: 'claude', opencode: 'opencode', cursor: 'cursor-agent', antigravity: 'agy' };
const AGY_RELEASE = 'https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/';
const directAgent = new Agent();

async function fetchWithDirectFallback(url, init) {
  try {
    const response = await fetch(url, init);
    if (response.ok) return response;
    throw new Error(`HTTP ${response.status}`);
  } catch (error) {
    const hasProxy = Boolean(process.env.HTTPS_PROXY || process.env.https_proxy || process.env.ALL_PROXY || process.env.all_proxy);
    if (!hasProxy) throw error;
    return undiciFetch(url, { ...init, dispatcher: directAgent });
  }
}

async function download(url, file, expectedHash) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || !['downloads.cursor.com', 'storage.googleapis.com'].includes(parsed.hostname)) throw new Error('Unexpected CLI download origin');
  const response = await fetchWithDirectFallback(url, { signal: AbortSignal.timeout(300_000), redirect: 'error' });
  if (!response.ok || !response.body) throw new Error(`Download returned HTTP ${response.status}`);
  const hash = createHash('sha512');
  const stream = Readable.fromWeb(response.body);
  stream.on('data', chunk => hash.update(chunk));
  await pipeline(stream, createWriteStream(file, { mode: 0o600 }));
  if (expectedHash && hash.digest('hex') !== expectedHash) throw new Error('CLI download checksum mismatch');
}

async function run(command, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', shell: false, env: { ...process.env, NO_COLOR: '1' } });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`${command} exited with code ${code}`)));
  });
}

/** Used by the installer and its regression tests: switch a validated release without touching the previous release. */
export async function activateRelease(root, provider, stage, command) {
  const folder = path.join(root, provider);
  const current = path.join(folder, 'current');
  const previous = await fs.readlink(current).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
  // Validate before making a release visible to any new chat.
  const stagedVersion = execFileSync(path.join(stage, command), ['--version'], { encoding: 'utf8', timeout: 20_000 }).trim();
  if (!stagedVersion) throw new Error('The staged CLI returned no version');
  const next = current + '-' + randomUUID();
  await fs.symlink(stage, next, 'dir');
  await fs.rename(next, current);
  try {
    const version = execFileSync(path.join(current, command), ['--version'], { encoding: 'utf8', timeout: 20_000 }).trim();
    if (!version) throw new Error('The new CLI returned no version');
    const bin = path.join(root, 'bin');
    await fs.mkdir(bin, { recursive: true });
    const link = path.join(bin, BINARIES[provider]);
    const temp = link + '-' + randomUUID();
    await fs.symlink(path.join(current, command), temp);
    await fs.rename(temp, link);
    console.log(`Installed ${provider}: ${version}`);
    return version;
  } catch (error) {
    if (previous) {
      const rollback = current + '-rollback-' + randomUUID();
      await fs.symlink(previous, rollback, 'dir');
      await fs.rename(rollback, current);
    } else await fs.unlink(current);
    throw error;
  }
}

async function latestRelease(provider) {
  let source;
  if (PACKAGES[provider]) source = `https://registry.npmjs.org/${PACKAGES[provider].replace('/', '%2F')}/latest`;
  else if (provider === 'cursor') source = 'https://cursor.com/install';
  else {
    const musl = process.platform === 'linux' && !process.report.getReport().header.glibcVersionRuntime;
    source = AGY_RELEASE + `${process.platform}_${process.arch === 'x64' ? 'amd64' : process.arch}${musl ? '_musl' : ''}.json`;
  }
  const response = await fetchWithDirectFallback(source, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`Release check returned HTTP ${response.status}`);
  if (provider === 'cursor') {
    const version = (await response.text()).match(/downloads\.cursor\.com\/lab\/([\w.-]+)\//)?.[1];
    if (!version) throw new Error('Cursor installer did not identify its release');
    return { version, url: `https://downloads.cursor.com/lab/${version}/${process.platform}/${process.arch}/agent-cli-package.tar.gz` };
  }
  const release = await response.json();
  if (typeof release.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(release.version)) throw new Error('Invalid CLI release version');
  if (provider === 'antigravity' && (typeof release.sha512 !== 'string' || !/^[a-f0-9]{128}$/.test(release.sha512))) throw new Error('Invalid Antigravity checksum');
  return release;
}

async function install(provider) {
  if (!Object.hasOwn(BINARIES, provider)) throw new Error('Unknown CLI provider');
  if (!['linux', 'darwin'].includes(process.platform)) throw new Error('Managed CLI installation currently requires Linux or macOS');
  const root = path.resolve(process.env.MINTCLI_CLI_ROOT || path.join(os.homedir(), '.mintcli', 'cli'));
  const folder = path.join(root, provider);
  await fs.mkdir(folder, { recursive: true, mode: 0o700 });
  const lock = path.join(folder, '.update-lock');
  try { await fs.mkdir(lock); } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const owner = Number(await fs.readFile(path.join(lock, 'pid'), 'utf8').catch(() => '0'));
    if (!Number.isSafeInteger(owner) || owner <= 0) throw new Error('An incomplete installer lock needs administrator recovery');
    let alive = true;
    try { process.kill(owner, 0); } catch (probe) { if (probe.code === 'ESRCH') alive = false; }
    if (alive) throw new Error('A CLI installer is already running; wait for it to finish');
    await fs.rm(lock, { recursive: true });
    await fs.mkdir(lock);
  }
  await fs.writeFile(path.join(lock, 'pid'), String(process.pid));
  const stage = path.join(folder, 'releases', randomUUID());
  await fs.mkdir(stage, { recursive: true, mode: 0o700 });
  let activated = false;
  try {
    const release = await latestRelease(provider);
    let installed = null;
    try { installed = execFileSync(path.join(root, 'bin', BINARIES[provider]), ['--version'], { encoding: 'utf8', timeout: 20_000 }).match(/\d{4}\.\d{2}\.\d{2}-[\w]+|\d+\.\d+\.\d+/)?.[0]; } catch { /* The first installation has no executable yet. */ }
    if (installed === release.version) { console.log(`${provider} is already up to date: ${installed}`); return; }
    let command;
    if (PACKAGES[provider]) {
      await fs.writeFile(path.join(stage, 'package.json'), JSON.stringify({ private: true }));
      await run('npm', ['install', '--prefix', stage, '--save-exact', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', `${PACKAGES[provider]}@${release.version}`]);
      if (provider === 'claude') {
        // Run only Claude's own installer in the staged prefix; other lifecycle scripts stay disabled.
        await run(process.execPath, [path.join(stage, 'node_modules/@anthropic-ai/claude-code/install.cjs')]);
      }
      if (provider === 'opencode') await run(process.execPath, [path.join(stage, 'node_modules/opencode-ai/postinstall.mjs')]);
      command = `node_modules/.bin/${BINARIES[provider]}`;
    } else {
      const archive = path.join(stage, 'release.tar.gz');
      await download(release.url, archive, release.sha512);
      const entries = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).split('\n');
      if (entries.some(entry => entry.startsWith('/') || entry.split('/').includes('..'))) throw new Error('Invalid CLI archive path');
      await run('tar', provider === 'cursor' ? ['-xzf', archive, '--strip-components=1', '-C', stage] : ['-xzf', archive, '-C', stage, 'antigravity']);
      await fs.unlink(archive);
      command = provider === 'cursor' ? 'cursor-agent' : 'antigravity';
      await fs.chmod(path.join(stage, command), 0o755);
    }
    await activateRelease(root, provider, stage, command);
    activated = true;
  } finally {
    if (!activated) await fs.rm(stage, { recursive: true, force: true });
    await fs.rm(lock, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const requested = process.argv[2] === '--all' ? Object.keys(BINARIES) : [process.argv[2]];
  (async () => { for (const provider of requested) await install(provider); })()
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
