import { useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AgentConnections } from '@/modules/agent-connections/AgentConnections';
import { api } from '@/shared/api';
import type { AgentConnectionChoice, LLMProvider } from '@/shared/types';
const fixtures = [
  { id: 'codex:c', accountId: 'c', provider: 'codex', kind: 'chatgpt', name: 'Codex A', current: true, authorized: true },
  { id: 'antigravity:a', accountId: 'a', provider: 'antigravity', kind: 'antigravity', name: 'agy A', current: true, authorized: true },
  { id: 'claude:h', accountId: 'h', provider: 'claude', kind: 'claude', name: 'Claude A', current: true, authorized: false },
  { id: 'cursor:default', accountId: 'default', provider: 'cursor', kind: 'cursor', name: 'Cursor', current: true, authorized: false },
  { id: 'opencode:default', accountId: 'default', provider: 'opencode', kind: 'opencode', name: 'OpenCode', current: true, authorized: false },
  { id: 'codex:api', accountId: 'api', provider: 'codex', kind: 'api', name: 'API A', authorized: true },
];
vi.mock('@/shared/api', () => ({ api: { providers: { authStatus: vi.fn(async () => Response.json({ data: { installed: true, authenticated: false, email: null } })) }, agentConnections: { list: vi.fn(), select: vi.fn(), quota: vi.fn(), saveClaude: vi.fn(), claudeLogin: vi.fn(), claudeLoginStatus: vi.fn(), claudeLoginCode: vi.fn(), cancelClaudeLogin: vi.fn(), startOfficialLogin: vi.fn(), officialLoginStatus: vi.fn(), submitOfficialLogin: vi.fn(), cancelOfficialLogin: vi.fn() }, codexConnections: { save: vi.fn(), login: vi.fn(), loginStatus: vi.fn(), loginCode: vi.fn(), cancelLogin: vi.fn() } }, readApiJson: async (response: Response) => response.json() }));
vi.mock('@/modules/standalone-shell', () => ({ StandaloneShell: () => <div>Official login terminal</div> }));
beforeEach(() => { vi.clearAllMocks(); vi.spyOn(window, 'open').mockReturnValue(null); });
afterEach(cleanup);
it('all native providers share the account manager and selection carries the raw account identity', async () => {
  let activeId = 'codex:c';
  vi.mocked(api.agentConnections.list).mockImplementation(async () => Response.json({ activeId, connections: fixtures }));
  vi.mocked(api.agentConnections.select).mockImplementation(async id => { activeId = id; return Response.json({ activeId, connections: fixtures }); });
  vi.mocked(api.agentConnections.quota).mockImplementation(async id => Response.json({ connectionId: id, windows: [], reason: '尚未读取' }));
  const onChoice = vi.fn();
  function Workbench() {
    const [provider, setProvider] = useState<LLMProvider>('codex');
    return <AgentConnections provider={provider} sessionId="old-session" disabled={false} onChoice={onChoice} onProviderChange={setProvider} />;
  }
  render(<Workbench />);
  await screen.findByRole('option', { name: 'agy · agy A' });
  fireEvent.change(screen.getByLabelText('切换账号'), { target: { value: 'antigravity:a' } });
  await waitFor(() => expect(onChoice).toHaveBeenLastCalledWith(expect.objectContaining({ provider: 'antigravity', accountId: 'a' })));
  expect(api.agentConnections.select).toHaveBeenCalledWith('antigravity:a', 'old-session');
  expect((screen.getByLabelText('切换账号') as HTMLSelectElement).value).toBe('antigravity:a');
  fireEvent.click(screen.getByRole('button', { name: '管理账号' }));
  const dialog = await screen.findByRole('dialog', { name: '账号管理' });
  expect(dialog.querySelectorAll('[aria-label="所有账号"] button')).toHaveLength(6);
  fireEvent.click(screen.getByRole('button', { name: '＋ 添加账号 / API' }));
  const types = screen.getByLabelText('账号类型') as HTMLSelectElement;
  expect(Array.from(types.options).map(item => item.value)).toEqual(['chatgpt', 'claude', 'cursor', 'opencode', 'antigravity', 'api']);
  expect(screen.queryByRole('tab', { name: /Antigravity/ })).toBeNull();
});


it.each(['cursor', 'opencode'] as const)('%s uses the same account manager without a Codex credential form', async provider => {
  vi.mocked(api.agentConnections.list).mockImplementation(async () => Response.json({ activeId: 'codex:c', connections: fixtures }));
  vi.mocked(api.agentConnections.quota).mockImplementation(async id => Response.json({ connectionId: id, windows: [], reason: '请在官方控制台查看额度' }));
  render(<AgentConnections provider={provider} sessionId="existing" disabled={false} onChoice={vi.fn()} onProviderChange={vi.fn()} />);
  await screen.findByRole('option', { name: new RegExp(provider === 'cursor' ? 'Cursor · Cursor' : 'OpenCode · OpenCode') });
  fireEvent.click(screen.getByRole('button', { name: '管理账号' }));
  await screen.findByText('未登录');
  expect(screen.queryByLabelText('账号类型')).toBeNull();
  expect(screen.getByRole('button', { name: '检查登录状态' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '使用原生登录终端（其他方式）' }));
  expect(screen.getByText('Official login terminal')).toBeTruthy();
  expect(api.agentConnections.quota).toHaveBeenCalledWith(`${provider}:default`, false);
});


const renderNewAccount = async () => {
  vi.mocked(api.agentConnections.list).mockResolvedValue(Response.json({ activeId: 'codex:c', connections: fixtures }));
  vi.mocked(api.agentConnections.list).mockImplementation(async () => Response.json({ activeId: 'codex:c', connections: fixtures }));
  vi.mocked(api.agentConnections.quota).mockImplementation(async id => Response.json({ connectionId: id, windows: [] }));
  render(<AgentConnections provider="codex" sessionId="existing" disabled={false} onChoice={vi.fn()} onProviderChange={vi.fn()} />);
  await screen.findByRole('option', { name: /Codex A/ });
  fireEvent.click(screen.getByRole('button', { name: '管理账号' }));
  fireEvent.click(screen.getByRole('button', { name: '＋ 添加账号 / API' }));
};

it('creates a Codex profile from one authorization click, accepts a callback and keeps the current account selected', async () => {
  vi.mocked(api.codexConnections.save).mockImplementation(async()=>Response.json({id:'new-codex'}));
  vi.mocked(api.codexConnections.login).mockImplementation(async()=>Response.json({status:'pending',method:'browser',url:'https://auth.openai.com/oauth/authorize?state=fixture',acceptsCode:true}));
  vi.mocked(api.codexConnections.loginCode).mockImplementation(async()=>Response.json({status:'authorized',authorized:true}));
  await renderNewAccount();
  fireEvent.change(screen.getByLabelText('名称'),{target:{value:'New Codex'}});
  fireEvent.click(screen.getByRole('button',{name:'打开官方授权 / 添加账号'}));
  await screen.findByLabelText('授权返回码 / 回调地址');
  expect(api.codexConnections.save).toHaveBeenCalledWith({name:'New Codex',kind:'chatgpt'});
  expect(api.codexConnections.login).toHaveBeenCalledWith('new-codex','browser');
  fireEvent.change(screen.getByLabelText('授权返回码 / 回调地址'),{target:{value:'http://localhost:1455/auth/callback?code=fixture&state=fixture'}});
  fireEvent.click(screen.getByRole('button',{name:'提交授权并完成登录'}));
  await screen.findByText('登录成功，账号已添加');
  expect(api.codexConnections.loginCode).toHaveBeenCalledWith('new-codex','http://localhost:1455/auth/callback?code=fixture&state=fixture');
  expect(api.agentConnections.select).not.toHaveBeenCalled();
});

it('starts Claude authorization before a manual save and sends the returned code to that new profile', async () => {
  vi.mocked(api.agentConnections.saveClaude).mockImplementation(async()=>Response.json({id:'new-claude'}));
  vi.mocked(api.agentConnections.claudeLogin).mockImplementation(async()=>Response.json({status:'pending',url:'https://claude.ai/oauth/authorize?state=fixture'}));
  vi.mocked(api.agentConnections.claudeLoginCode).mockImplementation(async()=>Response.json({status:'authorized',authorized:true}));
  await renderNewAccount();
  fireEvent.change(screen.getByLabelText('账号类型'),{target:{value:'claude'}});
  fireEvent.change(screen.getByLabelText('名称'),{target:{value:'New Claude'}});
  fireEvent.click(screen.getByRole('button',{name:'打开官方授权 / 添加账号'}));
  await screen.findByLabelText('授权返回码 / 回调地址');
  fireEvent.change(screen.getByLabelText('授权返回码 / 回调地址'),{target:{value:'fixture-code'}});
  fireEvent.click(screen.getByRole('button',{name:'提交授权并完成登录'}));
  await screen.findByText('登录成功，账号已添加');
  expect(api.agentConnections.claudeLoginCode).toHaveBeenCalledWith('new-claude','fixture-code');
  expect(api.codexConnections.loginCode).not.toHaveBeenCalled();
});

it('agy offers Google authorization and paste-back directly in the new-account form', async () => {
  vi.mocked(api.agentConnections.startOfficialLogin).mockImplementation(async()=>Response.json({id:'google-flow',status:'pending',url:'https://accounts.google.com/o/oauth2/auth?state=fixture',acceptsCode:true}));
  vi.mocked(api.agentConnections.submitOfficialLogin).mockImplementation(async()=>Response.json({id:'google-flow',status:'authorized',authorized:true}));
  await renderNewAccount();
  expect(api.agentConnections.startOfficialLogin).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('账号类型'),{target:{value:'antigravity'}});
  fireEvent.click(screen.getByRole('button',{name:'打开官方授权 / 添加账号'}));
  await screen.findByLabelText('授权返回码 / 回调地址');
  fireEvent.change(screen.getByLabelText('授权返回码 / 回调地址'),{target:{value:'google-return-code'}});
  fireEvent.click(screen.getByRole('button',{name:'提交授权并完成登录'}));
  await screen.findByText('登录成功，账号已添加');
  expect(api.agentConnections.submitOfficialLogin).toHaveBeenCalledWith('google-flow','google-return-code');
});
