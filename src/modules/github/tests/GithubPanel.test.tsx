import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { GithubPanel } from '@/modules/github/GithubPanel';
import type { Project } from '@/shared/types';

const HEAD = 'a'.repeat(40);
const project: Project = { projectId: 'project-1', displayName: 'My project', fullPath: '/repo' };
const repository = { branch: 'feature/local', remoteBranch: 'main', head: HEAD, name: 'example/repo', url: 'https://github.com/example/repo', changedFiles: 1, ahead: 2, behind: 0, remote: 'origin' };
const connected = { connected: true, account: { login: 'example-user', name: 'Example User', url: 'https://github.com/example-user' } };
const disconnected = { connected: false, account: null };
type Handler = (url: string, options: RequestInit) => Response | Promise<Response> | undefined;
function setup(handler?: Handler, signedIn = true) {
  const calls = vi.fn(async (url: string, options: RequestInit = {}) => {
    const result = await handler?.(url, options);
    if (result) return result;
    if (url === '/api/github/status') return Response.json(signedIn ? connected : disconnected);
    if (url === '/api/github/login') return Response.json({ login: null });
    if (url.startsWith('/api/github/repository')) return Response.json({ repository });
    return Response.json({ success: true });
  });
  vi.stubGlobal('fetch', calls);
  return calls;
}
beforeEach(() => { localStorage.clear(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('previews the selected project and uploads its pinned commit and local branch', async () => {
  const calls = setup((url, options) => url === '/api/github/push' && options.method === 'POST' ? Response.json({ url: repository.url, head: HEAD }) : undefined);
  render(<GithubPanel project={project} />);
  const button = await screen.findByRole('button', { name: '上传已提交更改 · aaaaaaaa' });
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  expect(screen.getByText('feature/local → main')).toBeTruthy();
  expect(screen.getByText(/有 1 项未提交修改/)).toBeTruthy();
  fireEvent.click(button);
  expect(await screen.findByText('上传成功 · aaaaaaaa')).toBeTruthy();
  const request = calls.mock.calls.find(([url]) => url === '/api/github/push');
  expect(JSON.parse(String(request?.[1]?.body))).toEqual({ project: 'project-1', expectedHead: HEAD, expectedBranch: 'feature/local' });
});

it('does not upload while logged out and keeps an actionable login fallback', async () => {
  setup((url, options) => url === '/api/github/login' && options.method === 'POST' ? Response.json({ error: '服务器尚未安装 GitHub CLI，可使用访问令牌登录。' }, { status: 503 }) : undefined, false);
  render(<GithubPanel project={project} />);
  const push = await screen.findByRole('button', { name: '上传已提交更改 · aaaaaaaa' });
  expect((push as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: '登录 GitHub' }));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', '服务器尚未安装 GitHub CLI，可使用访问令牌登录。');
  expect(screen.getByRole('button', { name: '使用访问令牌' })).toBeTruthy();
});

it('shows a device code and automatically connects when browser authorization completes', async () => {
  let loggedIn = false;
  setup((url, options) => {
    if (url === '/api/github/login' && options.method === 'POST') return Response.json({ login: { status: 'waiting', code: 'ABCD-1234', expiresAt: Date.now() + 600000, verificationUrl: 'https://github.com/login/device' } });
    if (url === '/api/github/login' && loggedIn) return Response.json({ login: { status: 'complete', verificationUrl: 'https://github.com/login/device', expiresAt: Date.now() + 600000 } });
    if (url === '/api/github/status') return Response.json(loggedIn ? connected : disconnected);
    return undefined;
  }, false);
  render(<GithubPanel />);
  fireEvent.click(await screen.findByRole('button', { name: '登录 GitHub' }));
  expect(await screen.findByText('ABCD-1234')).toBeTruthy();
  expect(screen.getByRole('link', { name: '打开 GitHub 授权页' }).getAttribute('href')).toBe('https://github.com/login/device');
  loggedIn = true;
  expect(await screen.findByText('@example-user', {}, { timeout: 4000 })).toBeTruthy();
  expect(screen.queryByTestId('github-device-code')).toBeNull();
});

it('clears the masked token after login without saving it in browser storage', async () => {
  const calls = setup((url, options) => url === '/api/github/token' && options.method === 'POST' ? Response.json(connected) : undefined, false);
  render(<GithubPanel compact />);
  fireEvent.click(await screen.findByRole('button', { name: '使用访问令牌' }));
  const input = screen.getByLabelText('GitHub 访问令牌') as HTMLInputElement;
  expect(input.type).toBe('password');
  fireEvent.change(input, { target: { value: 'private-token-value' } });
  fireEvent.click(screen.getByRole('button', { name: '验证并登录' }));
  expect(await screen.findByText('@example-user')).toBeTruthy();
  expect(screen.queryByLabelText('GitHub 访问令牌')).toBeNull();
  expect(JSON.stringify(localStorage)).not.toContain('private-token-value');
  expect(calls.mock.calls.find(([url]) => url === '/api/github/token')?.[1]?.body).toBe(JSON.stringify({ token: 'private-token-value' }));
});

it('project switching drops a slow old preview and cannot push the previous project', async () => {
  let resolveOld!: (response: Response) => void;
  const old = new Promise<Response>(resolve => { resolveOld = resolve; });
  const calls = setup(url => {
    if (url.endsWith('project=project-1')) return old;
    if (url.endsWith('project=project-2')) return Response.json({ repository: { ...repository, head: 'b'.repeat(40), name: 'example/second', url: 'https://github.com/example/second' } });
    return undefined;
  });
  const view = render(<GithubPanel project={project} />);
  await screen.findByText('@example-user');
  view.rerender(<GithubPanel project={{ ...project, projectId: 'project-2', displayName: 'Second project' }} />);
  await screen.findByRole('button', { name: '上传已提交更改 · bbbbbbbb' });
  await act(async () => { resolveOld(Response.json({ repository })); await old; });
  expect(screen.queryByText('example/repo')).toBeNull();
  expect(screen.queryByRole('button', { name: '上传已提交更改 · aaaaaaaa' })).toBeNull();
  expect(calls.mock.calls.some(([url]) => url === '/api/github/push')).toBe(false);
});

it('shows rejected pushes without claiming success', async () => {
  setup(url => url === '/api/github/push' ? Response.json({ error: '远程仓库已有更新，请先拉取。' }, { status: 409 }) : undefined);
  render(<GithubPanel project={project} />);
  const button = await screen.findByRole('button', { name: '上传已提交更改 · aaaaaaaa' });
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(button);
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', '远程仓库已有更新，请先拉取。');
  expect(screen.queryByText(/上传成功/)).toBeNull();
});

it('logout clears the account and disables uploading', async () => {
  setup();
  render(<GithubPanel project={project} />);
  fireEvent.click(await screen.findByRole('button', { name: '退出登录' }));
  await screen.findByRole('button', { name: '登录 GitHub' });
  expect((screen.getByRole('button', { name: '上传已提交更改 · aaaaaaaa' }) as HTMLButtonElement).disabled).toBe(true);
});
