import { execFile, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { githubTokensDb, projectsDb } from '@/modules/database/index.js';
import { AppError } from '@/shared/index.js';

const exec = promisify(execFile);
type Login = { status: 'starting' | 'waiting' | 'complete' | 'failed'; code?: string; verificationUrl: string; expiresAt: number; error?: string };
type Dependencies = {
  token(userId: number): string | null;
  saveToken(userId: number, login: string, token: string): void;
  clearToken(userId: number): void;
  projectPath(projectId: string): string | null;
  request: typeof fetch;
  run(command: string, args: string[], cwd?: string, env?: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string }>;
  spawnLogin: typeof spawn;
};

function failure(message: string, code: string, statusCode = 400): never {
  throw new AppError(message, { code, statusCode });
}

function githubRemote(raw: string): string | null {
  const ssh = /^git@github\.com:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(raw);
  if (ssh) {
    if (ssh[1].split('/').some(part => part === '.' || part === '..')) return failure('GitHub 仓库地址无效。', 'GITHUB_REMOTE_INVALID');
    return ssh[1];
  }
  try {
    const url = new URL(raw);
    if (url.hostname !== 'github.com') return null;
    if (!['https:', 'ssh:'].includes(url.protocol) || url.password || url.port || url.search || url.hash
      || (url.protocol === 'https:' && url.username) || (url.protocol === 'ssh:' && url.username !== 'git')) {
      return failure('请使用不含凭据的 GitHub HTTPS 或 SSH 仓库地址。', 'GITHUB_REMOTE_INVALID');
    }
    const match = /^\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url.pathname);
    if (!match || match[1].split('/').some(part => part === '.' || part === '..')) return failure('GitHub 仓库地址无效。', 'GITHUB_REMOTE_INVALID');
    return match[1];
  } catch (error) {
    if (error instanceof AppError) throw error;
    return null;
  }
}

function gitEnvironment(token: string): NodeJS.ProcessEnv {
  // Credentials only answer HTTPS challenges from github.com; Git cannot persist them.
  return { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never',
    MINTCLI_GITHUB_TOKEN: token, GIT_CONFIG_COUNT: '4',
    GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_KEY_1: 'credential.https://github.com.helper',
    GIT_CONFIG_VALUE_1: '!f() { if [ "$1" = get ]; then printf "username=x-access-token\\npassword=%s\\n" "$MINTCLI_GITHUB_TOKEN"; fi; }; f',
    GIT_CONFIG_KEY_2: 'http.followRedirects', GIT_CONFIG_VALUE_2: 'false',
    GIT_CONFIG_KEY_3: 'credential.useHttpPath', GIT_CONFIG_VALUE_3: 'true' };
}

/** Used by GitHub routes and focused tests; keeps tokens and device sessions scoped to the authenticated mintcli user. */
export function createGithubService(overrides: Partial<Dependencies> = {}) {
  const dependencies: Dependencies = {
    token: userId => githubTokensDb.getActiveGithubToken(userId),
    saveToken: (userId, login, token) => {
      const previous = githubTokensDb.getGithubTokens(userId);
      githubTokensDb.createGithubToken(userId, `mintcli GitHub · ${login}`, token, 'GitHub 登录');
      for (const row of previous) if (row.is_active) githubTokensDb.updateGithubToken(userId, Number(row.id), false);
    },
    clearToken: userId => { for (const row of githubTokensDb.getGithubTokens(userId)) if (row.is_active) githubTokensDb.updateGithubToken(userId, Number(row.id), false); },
    projectPath: projectId => projectsDb.getProjectPathById(projectId),
    request: fetch,
    run: async (command, args, cwd, env) => exec(command, args, { cwd, env: env ?? { ...process.env, GIT_TERMINAL_PROMPT: '0' }, timeout: 120000, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8' }),
    spawnLogin: spawn,
    ...overrides,
  };
  const logins = new Map<number, { view: Login; cancel: () => Promise<void> }>();
  const uploading = new Set<string>();
  const accounts = new Map<number, { token: string; expires: number; account: { login: string; name: string; url: string } }>();

  async function accountFor(token: string) {
    let response: Response;
    try {
      response = await dependencies.request('https://api.github.com/user', { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'mintcli-github' }, redirect: 'error', signal: AbortSignal.timeout(15000) });
    } catch { return failure('无法连接 GitHub，请检查网络后重试。', 'GITHUB_NETWORK_ERROR', 502); }
    if (response.status === 401) return failure('GitHub 登录已失效，请重新登录。', 'GITHUB_AUTH_REQUIRED', 401);
    if (!response.ok) return failure('GitHub 暂时无法验证账号，请稍后重试。', 'GITHUB_ACCOUNT_UNAVAILABLE', 502);
    const data = await response.json() as { login?: string; name?: string; html_url?: string };
    if (!data.login || !/^[a-zA-Z0-9-]+$/.test(data.login)) return failure('GitHub 返回的账号信息无效。', 'GITHUB_ACCOUNT_INVALID', 502);
    return { login: data.login, name: data.name || data.login, url: `https://github.com/${data.login}` };
  }

  function authenticatedToken(userId: number) {
    const token = dependencies.token(userId);
    if (!token) return failure('请先在 GitHub 插件中登录，再上传代码。', 'GITHUB_AUTH_REQUIRED', 401);
    return token;
  }

  function ghEnvironment(directory: string): NodeJS.ProcessEnv {
    const env = { ...process.env, GH_CONFIG_DIR: directory, GH_PROMPT_DISABLED: '1', GH_BROWSER: process.platform === 'win32' ? 'cmd /c exit 0' : 'true', NO_COLOR: '1' };
    for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'GH_HOST']) delete (env as NodeJS.ProcessEnv)[key];
    return env;
  }

  async function repository(projectId: string) {
    const cwd = dependencies.projectPath(projectId);
    if (!cwd) return failure('找不到所选项目。', 'PROJECT_NOT_FOUND', 404);
    const git = async (args: string[]) => (await dependencies.run('git', args, cwd)).stdout.trim();
    let branch: string, head: string;
    try { branch = await git(['symbolic-ref', '--quiet', '--short', 'HEAD']); head = await git(['rev-parse', '--verify', 'HEAD']); }
    catch { return failure('请先在 Git 面板初始化仓库并创建提交，然后上传。', 'GITHUB_COMMIT_REQUIRED'); }
    let remote = 'origin', remoteBranch = branch;
    try {
      const trackingRemote = await git(['config', '--get', `branch.${branch}.remote`]);
      const merge = await git(['config', '--get', `branch.${branch}.merge`]);
      if (trackingRemote !== '.' && merge.startsWith('refs/heads/')) { remote = trackingRemote; remoteBranch = merge.slice(11); }
    } catch { /* A new branch uses origin and its own name. */ }
    if (!/^[A-Za-z0-9._-]+$/.test(remote) || remote.startsWith('-')) return failure('远程仓库名称无效。', 'GITHUB_REMOTE_INVALID');
    try { await git(['check-ref-format', `refs/heads/${remoteBranch}`]); }
    catch { return failure('远程分支名称无效，请检查跟踪分支配置。', 'GITHUB_REMOTE_INVALID'); }
    let urls: string[];
    try { urls = (await git(['remote', 'get-url', '--push', '--all', remote])).split('\n').filter(Boolean); }
    catch { return failure('尚未配置远程仓库，请先添加 GitHub 仓库地址。', 'GITHUB_REMOTE_REQUIRED'); }
    if (urls.length !== 1) return failure('此远程配置了多个上传地址，请保留一个 GitHub 上传地址。', 'GITHUB_REMOTE_INVALID');
    const name = githubRemote(urls[0]);
    const changes = await git(['status', '--porcelain']);
    let ahead: number | null = null, behind: number | null = null;
    try {
      const counts = (await git(['rev-list', '--left-right', '--count', `refs/remotes/${remote}/${remoteBranch}...HEAD`])).split(/\s+/).map(Number);
      if (counts.length === 2 && counts.every(Number.isFinite)) [behind, ahead] = counts;
    } catch { /* No fetched remote reference yet. */ }
    return { cwd, branch, head, remote, remoteBranch, name, url: name ? `https://github.com/${name}` : null, changedFiles: changes ? changes.split('\n').length : 0, ahead, behind };
  }

  const service = {
    async status(userId: number) {
      const token = dependencies.token(userId);
      if (!token) return { connected: false, account: null };
      const cached = accounts.get(userId);
      const account = cached?.token === token && cached.expires > Date.now() ? cached.account : await accountFor(token);
      accounts.set(userId, { token, expires: Date.now() + 60000, account });
      return { connected: true, account };
    },
    async tokenLogin(userId: number, input: unknown) {
      if (typeof input !== 'string' || !input.trim() || input.length > 1024 || /\s/.test(input.trim())) return failure('请输入有效的 GitHub 访问令牌。', 'GITHUB_TOKEN_INVALID');
      const token = input.trim();
      const account = await accountFor(token);
      await logins.get(userId)?.cancel();
      logins.delete(userId);
      dependencies.saveToken(userId, account.login, token);
      accounts.delete(userId);
      return { connected: true, account };
    },
    async startLogin(userId: number) {
      const current = logins.get(userId);
      if (current && current.view.expiresAt > Date.now() && ['starting', 'waiting'].includes(current.view.status)) return { login: current.view };
      const executable = process.env.MINTCLI_GH_PATH || 'gh';
      try { await dependencies.run(executable, ['--version']); }
      catch { return failure('服务器尚未安装 GitHub CLI，可先使用下方的访问令牌登录。', 'GITHUB_CLI_UNAVAILABLE', 503); }
      await current?.cancel();
      const directory = await mkdtemp(path.join(os.tmpdir(), 'mintcli-github-'));
      const env = ghEnvironment(directory);
      const view: Login = { status: 'starting', verificationUrl: 'https://github.com/login/device', expiresAt: Date.now() + 15 * 60000 };
      const child = dependencies.spawnLogin(executable, ['auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--web', '--scopes', 'repo,workflow', '--insecure-storage'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
      let cancelled = false, output = '';
      const cleanup = () => rm(directory, { recursive: true, force: true });
      const timer = setTimeout(() => { view.status = 'failed'; view.error = '登录已过期，请重新获取授权码。'; void entry.cancel(); }, 15 * 60000);
      timer.unref();
      const entry = { view, cancel: async () => { cancelled = true; child.kill(); clearTimeout(timer); await cleanup(); } };
      logins.set(userId, entry);
      const read = (data: Buffer) => {
        output = (output + data.toString()).slice(-8000);
        const match = /\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/.exec(output);
        if (match) { view.code = match[0]; view.status = 'waiting'; }
      };
      child.stdout?.on('data', read); child.stderr?.on('data', read);
      child.stdin?.on('error', () => {}); child.stdin?.end('\n');
      child.on('error', () => { clearTimeout(timer); view.status = 'failed'; view.error = '无法启动 GitHub 登录，请使用访问令牌或稍后重试。'; void cleanup(); });
      child.on('close', code => { void (async () => {
        clearTimeout(timer);
        try {
          if (cancelled) return;
          if (code !== 0) return void (view.status = 'failed', view.error = 'GitHub 登录未完成，请重新授权。');
          const result = await dependencies.run(executable, ['auth', 'token', '--hostname', 'github.com'], undefined, env);
          const token = result.stdout.trim();
          const account = await accountFor(token);
          if (cancelled || logins.get(userId) !== entry) return;
          dependencies.saveToken(userId, account.login, token); accounts.delete(userId); view.status = 'complete';
        } catch { view.status = 'failed'; view.error = 'GitHub 授权未保存，请重新登录。'; }
        finally { await cleanup(); }
      })(); });
      return { login: view };
    },
    loginStatus(userId: number) { return { login: logins.get(userId)?.view ?? null }; },
    async cancelLogin(userId: number) { await logins.get(userId)?.cancel(); logins.delete(userId); return { success: true }; },
    async logout(userId: number) { await service.cancelLogin(userId); dependencies.clearToken(userId); accounts.delete(userId); return { success: true }; },
    async repository(projectId: string) { const { cwd: _cwd, ...result } = await repository(projectId); return { repository: result }; },
    async push(userId: number, projectId: string, expectedHead?: string, expectedBranch?: string, allowOtherHost = false) {
      const snapshot = await repository(projectId);
      if (!snapshot.name) {
        if (allowOtherHost) return null;
        return failure('所选项目的远程仓库不是 GitHub。', 'GITHUB_REMOTE_REQUIRED');
      }
      const token = authenticatedToken(userId);
      if ((expectedHead && expectedHead !== snapshot.head) || (expectedBranch && expectedBranch !== snapshot.branch)) return failure('项目提交或分支已变化，请刷新后再上传。', 'GITHUB_PROJECT_CHANGED', 409);
      if (uploading.has(snapshot.cwd)) return failure('此项目正在上传，请稍后查看结果。', 'GITHUB_PUSH_BUSY', 409);
      uploading.add(snapshot.cwd);
      try {
        // Pin the reviewed commit and target branch. Never force-push or include uncommitted files.
        const result = await dependencies.run('git', ['push', '--porcelain', '--', `${snapshot.url}.git`, `${snapshot.head}:refs/heads/${snapshot.remoteBranch}`], snapshot.cwd, gitEnvironment(token));
        // Match Git's normal remote-tracking update, only when fetch and push name the same repository.
        try {
          const fetchUrl = (await dependencies.run('git', ['remote', 'get-url', snapshot.remote], snapshot.cwd)).stdout.trim();
          if (githubRemote(fetchUrl) === snapshot.name) await dependencies.run('git', ['update-ref', `refs/remotes/${snapshot.remote}/${snapshot.remoteBranch}`, snapshot.head], snapshot.cwd);
        } catch { /* The remote push already succeeded; local tracking failures must not report a failed upload. */ }
        return { success: true, head: snapshot.head, branch: snapshot.remoteBranch, url: snapshot.url, output: (result.stdout + result.stderr).split(token).join('[redacted]').slice(-8000) };
      } catch (error) {
        const details = error as { stderr?: string; stdout?: string };
        const message = `${details.stderr || ''} ${details.stdout || ''}`;
        if (/rejected|non-fast-forward|fetch first/i.test(message)) return failure('远程仓库已有更新，请先在 Git 面板拉取并处理差异，再上传。', 'GITHUB_PUSH_REJECTED', 409);
        if (/authentication|could not read|permission|403|not found|401/i.test(message)) return failure('GitHub 拒绝上传，请检查账号和仓库写入权限；组织仓库可能需要 SSO 授权。', 'GITHUB_PUSH_FORBIDDEN', 403);
        return failure('上传失败，请检查网络、仓库权限和分支保护规则后重试。', 'GITHUB_PUSH_FAILED', 502);
      } finally { uploading.delete(snapshot.cwd); }
    },
  };
  return service;
}

/** Used by authenticated GitHub routes and the Git module's existing push action. */
export const githubService = createGithubService();
