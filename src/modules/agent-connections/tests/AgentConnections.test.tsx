import { useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
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
vi.mock('@/shared/api', () => ({ api: { providers: { authStatus: vi.fn(async () => Response.json({ data: { installed: true, authenticated: false, email: null } })) }, agentConnections: { list: vi.fn(), select: vi.fn(), quota: vi.fn() } }, readApiJson: async (response: Response) => response.json() }));
vi.mock('@/modules/standalone-shell', () => ({ StandaloneShell: () => <div>Official login terminal</div> }));
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
  expect(Array.from(types.options).map(item => item.value)).toEqual(['chatgpt', 'claude', 'antigravity', 'api']);
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
  fireEvent.click(screen.getByRole('button', { name: '官方登录 / 重新授权' }));
  expect(screen.getByText('Official login terminal')).toBeTruthy();
  expect(api.agentConnections.quota).toHaveBeenCalledWith(`${provider}:default`, false);
});
