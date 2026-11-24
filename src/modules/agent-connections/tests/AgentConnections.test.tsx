import { useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
vi.mock('@/shared/api', () => ({ api: { providers: { authStatus: vi.fn(async () => Response.json({ data: { installed: true, authenticated: false, email: null } })) }, agentConnections: { list: vi.fn(), select: vi.fn(), quota: vi.fn(), saveClaude: vi.fn(), claudeLogin: vi.fn(), claudeLoginStatus: vi.fn(), claudeLoginCode: vi.fn(), cancelClaudeLogin: vi.fn(), startOfficialLogin: vi.fn(), officialLoginStatus: vi.fn(), submitOfficialLogin: vi.fn(), cancelOfficialLogin: vi.fn() }, codexConnections: { save: vi.fn(), discoverModels: vi.fn(), login: vi.fn(), loginStatus: vi.fn(), loginCode: vi.fn(), cancelLogin: vi.fn() } }, readApiJson: async (response: Response) => response.json() }));
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

it('discovers models from the API form without saving, then saves the chosen default', async () => {
  vi.mocked(api.codexConnections.discoverModels).mockResolvedValue(Response.json({ models: ['discovered-model'] }));
  vi.mocked(api.codexConnections.save).mockResolvedValue(Response.json({ id: 'new-api' }));
  await renderNewAccount();
  fireEvent.change(screen.getByLabelText('账号类型'), { target: { value: 'api' } });
  fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'My API' } });
  fireEvent.change(screen.getByLabelText('API 地址'), { target: { value: 'https://example.com/v1' } });
  fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'private-key' } });
  fireEvent.click(screen.getByRole('button', { name: '拉取模型' }));
  await screen.findByRole('option', { name: 'discovered-model' });
  expect(api.codexConnections.save).not.toHaveBeenCalled();
  expect(api.agentConnections.select).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('选择已拉取模型'), { target: { value: 'discovered-model' } });
  fireEvent.click(screen.getByRole('button', { name: '保存账号' }));
  await waitFor(() => expect(api.codexConnections.save).toHaveBeenCalledWith(expect.objectContaining({ model: 'discovered-model', baseUrl: 'https://example.com/v1', apiKey: 'private-key' })));
  await screen.findByText('已保存；可在上方切换到这个账号');
  expect((screen.getByLabelText('API Key') as HTMLInputElement).value).toBe('');
});

it.each(['codex', 'claude', 'antigravity'] as const)('saves %s as a real agent over the same Chat Completions API', async agent => {
  vi.mocked(api.codexConnections.save).mockImplementation(async () => Response.json({ id: 'new-api' }));
  await renderNewAccount();
  fireEvent.change(screen.getByLabelText('账号类型'), { target: { value: 'api' } });
  fireEvent.change(screen.getByLabelText('执行 Agent'), { target: { value: agent } });
  expect((screen.getByLabelText('协议') as HTMLSelectElement).value).toBe('chat_completions');
  expect(screen.getByText(/自动转换为 Chat Completions/)).toBeTruthy();
  fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'API ' + agent } });
  fireEvent.change(screen.getByLabelText('API 地址'), { target: { value: 'https://example.com/v1' } });
  fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'private-api-key' } });
  fireEvent.change(screen.getByLabelText('默认模型'), { target: { value: 'custom-model' } });
  fireEvent.click(screen.getByRole('button', { name: '保存账号' }));
  await waitFor(() => expect(api.codexConnections.save).toHaveBeenCalledWith(expect.objectContaining({ agent, protocol: 'chat_completions', model: 'custom-model' })));
});

it('restricts native protocols to the chosen agent while preserving legacy text-only accounts', async () => {
  await renderNewAccount();
  fireEvent.change(screen.getByLabelText('账号类型'), { target: { value: 'api' } });
  fireEvent.change(screen.getByLabelText('执行 Agent'), { target: { value: 'claude' } });
  expect(Array.from((screen.getByLabelText('协议') as HTMLSelectElement).options).map(item => item.value)).toEqual(['chat_completions', 'anthropic']);
  fireEvent.change(screen.getByLabelText('协议'), { target: { value: 'anthropic' } });
  fireEvent.change(screen.getByLabelText('执行 Agent'), { target: { value: 'antigravity' } });
  expect((screen.getByLabelText('协议') as HTMLSelectElement).value).toBe('gemini');
  fireEvent.change(screen.getByLabelText('执行 Agent'), { target: { value: 'chat' } });
  expect((screen.getByLabelText('协议') as HTMLSelectElement).options.length).toBe(1);
  expect((screen.getByLabelText('协议') as HTMLSelectElement).value).toBe('chat_completions');
});


it('official reset controls are present inside the unified account manager without switching accounts',async()=>{
  vi.mocked(api.agentConnections.list).mockResolvedValue(Response.json({activeId:'codex:c',connections:fixtures}));
  vi.mocked(api.agentConnections.quota).mockImplementation(async id=>Response.json({connectionId:id,windows:[],resetCredits:{availableCount:2,credits:null}}));
  render(<AgentConnections provider="codex" sessionId="existing" disabled={false} onChoice={vi.fn()} onProviderChange={vi.fn()}/>);
  await screen.findByRole('option',{name:/Codex A/});
  fireEvent.click(screen.getByRole('button',{name:'管理账号'}));
  const manager=await screen.findByRole('dialog',{name:'账号管理'});
  expect(await within(manager).findByRole('button',{name:'使用重置卡（2）'})).toBeTruthy();
  expect(api.agentConnections.select).not.toHaveBeenCalled();
});

it('displays official subscription tiers after account labels across Codex, Claude and Antigravity', async () => {
  const tieredFixtures = [
    { id: 'codex:c', accountId: 'c', provider: 'codex', kind: 'chatgpt', name: 'Business', email: 'biz@example.com', subscriptionTier: 'Team', current: true, authorized: true },
    { id: 'claude:h', accountId: 'h', provider: 'claude', kind: 'claude', name: 'Claude Max', email: 'max@example.com', subscriptionTier: 'Max 20x', current: true, authorized: true },
    { id: 'antigravity:u', accountId: 'u', provider: 'antigravity', kind: 'antigravity', name: 'UltraAcc', email: 'u@example.com', subscriptionTier: 'Ultra', current: true, authorized: true },
    { id: 'antigravity:fp', accountId: 'fp', provider: 'antigravity', kind: 'antigravity', name: 'FreeProAcc', email: 'fp@example.com', subscriptionTier: 'FreePro', current: false, authorized: true },
    { id: 'antigravity:pp', accountId: 'pp', provider: 'antigravity', kind: 'antigravity', name: 'PaidProAcc', email: 'pp@example.com', subscriptionTier: 'PaidPro', current: false, authorized: true },
  ];
  vi.mocked(api.agentConnections.list).mockResolvedValue(Response.json({ activeId: 'codex:c', connections: tieredFixtures }));
  vi.mocked(api.agentConnections.quota).mockImplementation(async id => Response.json({ connectionId: id, windows: [] }));
  render(<AgentConnections provider="codex" sessionId="existing" disabled={false} onChoice={vi.fn()} onProviderChange={vi.fn()} />);
  expect(await screen.findByRole('option', { name: 'Codex · Business · biz@example.com · Team' })).toBeTruthy();
  expect(screen.getByRole('option', { name: 'Claude · Claude Max · max@example.com · Max 20x' })).toBeTruthy();
  expect(screen.getByRole('option', { name: 'agy · UltraAcc · u@example.com · Ultra' })).toBeTruthy();
  expect(screen.getByRole('option', { name: 'agy · FreeProAcc · fp@example.com · FreePro' })).toBeTruthy();
  expect(screen.getByRole('option', { name: 'agy · PaidProAcc · pp@example.com · PaidPro' })).toBeTruthy();
});
