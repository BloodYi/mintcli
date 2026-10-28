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
  { id: 'codex:api', accountId: 'api', provider: 'codex', kind: 'api', name: 'API A', authorized: true },
];
vi.mock('@/shared/api', () => ({ api: { agentConnections: { list: vi.fn(), select: vi.fn(), quota: vi.fn() } }, readApiJson: async (response: Response) => response.json() }));
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
  expect((screen.getByLabelText('切换账号') as HTMLSelectElement).value).toBe('antigravity:a');
  fireEvent.click(screen.getByRole('button', { name: '管理账号' }));
  const dialog = await screen.findByRole('dialog', { name: '账号管理' });
  expect(dialog.querySelectorAll('[aria-label="所有账号"] button')).toHaveLength(4);
  fireEvent.click(screen.getByRole('button', { name: '＋ 添加账号 / API' }));
  const types = screen.getByLabelText('账号类型') as HTMLSelectElement;
  expect(Array.from(types.options).map(item => item.value)).toEqual(['chatgpt', 'claude', 'antigravity', 'api']);
  expect(screen.queryByRole('tab', { name: /Antigravity/ })).toBeNull();
});
