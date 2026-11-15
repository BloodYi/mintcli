import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { access } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import test from 'node:test';
import { createGithubService } from '../github.service.js';

const HEAD = 'a'.repeat(40);
const TOKEN = 'test-private-token';
type Dependencies = Parameters<typeof createGithubService>[0];
function fixture(overrides: Dependencies = {}) {
  const tokens = new Map<number, string>([[1, TOKEN]]);
  const pushes: { args: string[]; env?: NodeJS.ProcessEnv }[] = [];
  const service = createGithubService({
    token: id => tokens.get(id) ?? null,
    saveToken: (id, _login, token) => { tokens.set(id, token); },
    clearToken: id => { tokens.delete(id); },
    projectPath: id => id === 'project-1' ? '/workspace/repo' : null,
    request: async (_url, options) => {
      const authorization = (options?.headers as Record<string, string>).Authorization;
      return Response.json({ login: authorization.includes('second') ? 'second-user' : 'first-user', name: 'Test User' });
    },
    run: async (_command, args, _cwd, env) => {
      if (args[0] === '--version') return { stdout: 'gh version', stderr: '' };
      if (args[0] === 'symbolic-ref') return { stdout: 'feature/local\n', stderr: '' };
      if (args[0] === 'rev-parse') return { stdout: HEAD + '\n', stderr: '' };
      if (args[0] === 'config') return { stdout: args.at(-1)?.endsWith('.remote') ? 'origin\n' : 'refs/heads/review/target\n', stderr: '' };
      if (args[0] === 'check-ref-format' || args[0] === 'update-ref') return { stdout: '', stderr: '' };
      if (args[0] === 'remote') return { stdout: 'git@github.com:example/private-repo.git\n', stderr: '' };
      if (args[0] === 'status') return { stdout: ' M pending.ts\n', stderr: '' };
      if (args[0] === 'rev-list') return { stdout: '0\t2\n', stderr: '' };
      if (args[0] === 'push') { pushes.push({ args, env }); return { stdout: 'ok ' + TOKEN, stderr: '' }; }
      throw new Error('Unexpected command: ' + args.join(' '));
    },
    ...overrides,
  });
  return { service, pushes, tokens };
}

test('connection status is isolated by authenticated user and refreshes when the token changes', async () => {
  const { service, tokens } = fixture();
  assert.equal((await service.status(1)).account?.login, 'first-user');
  assert.deepEqual(await service.status(2), { connected: false, account: null });
  tokens.set(1, 'second-token');
  assert.equal((await service.status(1)).account?.login, 'second-user');
  assert.ok(!JSON.stringify(await service.status(1)).includes('second-token'));
});

test('token login verifies before saving and logout only deactivates that user', async () => {
  const { service, tokens } = fixture();
  await service.tokenLogin(2, 'second-token');
  assert.equal(tokens.get(2), 'second-token');
  await service.logout(2);
  assert.equal(tokens.has(2), false);
  assert.equal(tokens.get(1), TOKEN);
  await assert.rejects(service.tokenLogin(2, 'bad token'), /有效/);
});

test('an invalid GitHub token never replaces an existing login', async () => {
  const { service, tokens } = fixture({ request: async () => Response.json({}, { status: 401 }) });
  await assert.rejects(service.tokenLogin(1, 'expired-token'), /失效/);
  assert.equal(tokens.get(1), TOKEN);
});

test('upload pins the reviewed commit and tracked destination without placing the token in arguments', async () => {
  const { service, pushes } = fixture();
  const result = await service.push(1, 'project-1', HEAD, 'feature/local');
  assert.deepEqual(pushes[0].args, ['push', '--porcelain', '--', 'https://github.com/example/private-repo.git', `${HEAD}:refs/heads/review/target`]);
  assert.equal(pushes[0].env?.MINTCLI_GITHUB_TOKEN, TOKEN);
  assert.equal(pushes[0].env?.GIT_CONFIG_VALUE_2, 'false');
  assert.ok(!pushes[0].args.join(' ').includes(TOKEN));
  assert.ok(!JSON.stringify(result).includes(TOKEN));
  assert.ok(!pushes[0].args.some(arg => arg.includes('force')));
});

test('the credential helper serves HTTPS GitHub only, never another host or plain HTTP', async () => {
  const { service, pushes } = fixture();
  await service.push(1, 'project-1', HEAD, 'feature/local');
  const env = { ...pushes[0].env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const fill = (input: string) => new Promise<string>((resolve, reject) => {
    const child = execFile('git', ['credential', 'fill'], { env }, (error, stdout) => error ? reject(error) : resolve(stdout));
    child.stdin!.end(input + '\n\n');
  });
  assert.match(await fill('protocol=https\nhost=github.com\npath=example/repo'), /password=test-private-token/);
  await assert.rejects(fill('protocol=https\nhost=attacker.example'));
  await assert.rejects(fill('protocol=http\nhost=github.com'));
});

test('changed previews, missing logins and unknown projects do not push', async () => {
  const { service, pushes } = fixture();
  await assert.rejects(service.push(1, 'project-1', 'b'.repeat(40), 'feature/local'), /变化/);
  await assert.rejects(service.push(1, 'project-1', HEAD, 'other-branch'), /变化/);
  await assert.rejects(service.push(2, 'project-1', HEAD, 'feature/local'), /先.*登录/);
  await assert.rejects(service.push(1, 'not-registered', HEAD, 'feature/local'), /找不到/);
  assert.equal(pushes.length, 0);
});

test('a concurrent upload is rejected until the first upload completes', async () => {
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const service = createGithubService({
    token: () => TOKEN, projectPath: () => '/workspace/repo',
    run: async (_command, args) => {
      if (args[0] === 'symbolic-ref') return { stdout: 'main', stderr: '' };
      if (args[0] === 'rev-parse') return { stdout: HEAD, stderr: '' };
      if (args[0] === 'remote') return { stdout: 'https://github.com/example/repo.git', stderr: '' };
      if (args[0] === 'config') throw new Error('no tracking');
      if (args[0] === 'push') { entered(); await blocked; }
      return { stdout: '', stderr: '' };
    },
  });
  const first = service.push(1, 'project-1', HEAD, 'main');
  await started;
  await assert.rejects(service.push(1, 'project-1', HEAD, 'main'), /正在上传/);
  release(); await first;
});

for (const [text, expected] of [['rejected (fetch first)', '已有更新'], ['remote: Permission denied (403)', '拒绝上传'], ['network unavailable', '上传失败']]) {
  test(`push failure remains actionable: ${text}`, async () => {
    const service = createGithubService({ token: () => TOKEN, projectPath: () => '/repo', run: async (_command, args) => {
      if (args[0] === 'symbolic-ref') return { stdout: 'main', stderr: '' };
      if (args[0] === 'rev-parse') return { stdout: HEAD, stderr: '' };
      if (args[0] === 'remote') return { stdout: 'https://github.com/example/repo', stderr: '' };
      if (args[0] === 'config') throw new Error('no tracking');
      if (args[0] === 'push') throw Object.assign(new Error('failed ' + TOKEN), { stderr: text + TOKEN });
      return { stdout: '', stderr: '' };
    } });
    await assert.rejects(service.push(1, 'project-1'), error => { assert.match((error as Error).message, new RegExp(expected)); assert.ok(!(error as Error).message.includes(TOKEN)); return true; });
  });
}

test('browser authorization parses split code output, saves for its owner, and removes temporary CLI files', async () => {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill: () => true });
  let directory = '';
  const { service, tokens } = fixture({
    spawnLogin: ((_command: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => { directory = options.env.GH_CONFIG_DIR!; assert.equal(options.env.GH_TOKEN, undefined); return child; }) as unknown as NonNullable<Dependencies>['spawnLogin'],
    run: async () => ({ stdout: 'second-token', stderr: '' }),
  });
  await service.startLogin(2);
  assert.equal(service.loginStatus(1).login, null);
  child.stderr.write('First copy your one-time code: ABCD-'); child.stderr.write('1234\n');
  assert.equal(service.loginStatus(2).login?.code, 'ABCD-1234');
  child.emit('close', 0);
  for (let n = 0; n < 50 && service.loginStatus(2).login?.status !== 'complete'; n++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(service.loginStatus(2).login?.status, 'complete');
  assert.equal(tokens.get(2), 'second-token');
  await service.cancelLogin(2);
  await assert.rejects(access(directory));
});

test('cancelling device authorization prevents late process completion from signing in', async () => {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill: () => true });
  const { service, tokens } = fixture({ spawnLogin: (() => child) as unknown as NonNullable<Dependencies>['spawnLogin'] });
  await service.startLogin(2); await service.cancelLogin(2); child.emit('close', 0);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(tokens.has(2), false);
  assert.equal(service.loginStatus(2).login, null);
});
