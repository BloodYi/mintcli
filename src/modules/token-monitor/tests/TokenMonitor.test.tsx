import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { TokenMonitorProvider, MonitorButton } from '@/modules/token-monitor';
import { AccountQuota } from '@/modules/agent-connections/AccountQuota';
import { api } from '@/shared/api';
vi.mock('@/shared/api', () => ({ api: { tokenMonitor: { replyModels: vi.fn().mockImplementation(async id => Response.json({sessionId:id,status:'ok',models:[]})), updateTask: vi.fn().mockImplementation(async () => Response.json({ task: null })), startUpdate: vi.fn(), snapshot: vi.fn(), updates: vi.fn(), sessions: vi.fn().mockImplementation(async () => Response.json({ sessions: [] })) }, agentConnections: { quota: vi.fn() } }, readApiJson: async (response: Response) => response.json() }));
const snapshot = (sessionId: string, model: string | null) => ({ sessionId, provider: 'codex', configuredModel: 'configured', returnedModel: model, checkedAt: Date.now(), status: 'ok', limited: false, totals: null, alerts: [], replies: [], usage: [] });
afterEach(() => { cleanup(); localStorage.clear(); });
function Workbench({ id }: { id: string }) {
  return <TokenMonitorProvider sessionId={id} model="configured"><AccountQuota id="codex:a" /><MonitorButton model /></TokenMonitorProvider>;
}
it('both entry points share one window and quota collapse persists while keeping monitor accessible', async () => {
  vi.mocked(api.tokenMonitor.snapshot).mockImplementation(async id => Response.json(snapshot(id, 'returned-model')));
  vi.mocked(api.tokenMonitor.updates).mockResolvedValue(Response.json({ status: 'ok', updateAvailable: false, installedVersion: '0.81.0', latestVersion: '0.81.0', url: 'https://github.com/Javis603/token-monitor' }));
  vi.mocked(api.agentConnections.quota).mockResolvedValue(Response.json({ connectionId: 'codex:a', windows: [{ bucket: 'Codex', remainingPercent: 58 }] }));
  const view = render(<Workbench id="first" />);
  await screen.findByText('返回：returned-model');
  const quota = await screen.findByRole('region', { name: 'Codex额度' });
  expect(within(quota).getByText('58%')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '收起账号额度' }));
  expect(screen.queryByRole('region', { name: 'Codex额度' })).toBeNull();
  expect(localStorage.getItem('account-quota-collapsed')).toBe('true');
  fireEvent.click(screen.getByRole('button', { name: '开关监控窗口' }));
  await screen.findByRole('dialog');
  expect(screen.getByText('returned-model')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '关闭监控窗口' }));
  fireEvent.click(screen.getByRole('button', { name: '查看真实返回模型与 token' }));
  await screen.findByRole('dialog');
  view.unmount();
  render(<Workbench id="first" />);
  expect(screen.getByRole('button', { name: '展开账号额度' })).toBeTruthy();
});
it('switching sessions discards slow previous model metadata', async () => {
  let finish: (value: Response) => void = () => {};
  vi.mocked(api.tokenMonitor.snapshot).mockImplementation(async id => id === 'first' ? new Promise(resolve => { finish = resolve; }) : Response.json(snapshot(id, null)));
  const view = render(<Workbench id="first" />);
  view.rerender(<Workbench id="second" />);
  await waitFor(() => expect(api.tokenMonitor.snapshot).toHaveBeenCalledWith('second', expect.any(AbortSignal)));
  finish(Response.json(snapshot('first', 'stale-model')));
  await Promise.resolve();
  expect(screen.queryByText('返回：stale-model')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '查看真实返回模型与 token' }));
  await screen.findByText('未报告（不使用所选模型推断）');
});
it('history can inspect an archived conversation without changing the active chat and can return', async () => {
  vi.mocked(api.tokenMonitor.sessions).mockImplementation(async () => Response.json({ sessions: [
    { sessionId: 'archived', title: '旧 Gemini 对话', provider: 'antigravity', archived: true, recordedModels: ['gemini-requested'], reportedModels: ['gemini-returned'], totals: { total: 1234 } },
  ] }));
  vi.mocked(api.tokenMonitor.snapshot).mockImplementation(async id => Response.json(snapshot(id, id === 'archived' ? 'gemini-returned' : 'current-returned')));
  render(<Workbench id="current" />);
  await screen.findByText('返回：current-returned');
  fireEvent.click(screen.getByRole('button', { name: '开关监控窗口' }));
  await screen.findByText('全部历史会话（1，含归档）');
  fireEvent.click(screen.getByText('全部历史会话（1，含归档）'));
  expect(screen.getByText('请求模型：gemini-requested')).toBeTruthy();
  expect(screen.getByText('Token：1,234')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /旧 Gemini 对话/ }));
  await screen.findByText('gemini-returned', { selector: 'dd' });
  fireEvent.click(screen.getByRole('button', { name: '返回当前会话' }));
  await screen.findByText('current-returned', { selector: 'dd' });
});
