import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { TokenMonitorProvider, MonitorButton } from '@/modules/token-monitor';
import { AccountQuota } from '@/modules/agent-connections/AccountQuota';
import { api } from '@/shared/api';
vi.mock('@/shared/api', () => ({ api: { tokenMonitor: { snapshot: vi.fn(), updates: vi.fn() }, agentConnections: { quota: vi.fn() } }, readApiJson: async (response: Response) => response.json() }));
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
  await screen.findByText('Codex · 剩余 58%');
  fireEvent.click(screen.getByRole('button', { name: '收起账号额度' }));
  expect(screen.queryByText('Codex · 剩余 58%')).toBeNull();
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
