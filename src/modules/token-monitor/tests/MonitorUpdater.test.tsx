import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MonitorUpdater } from '@/modules/token-monitor/MonitorUpdater';
import { api } from '@/shared/api';
vi.mock('@/shared/api', () => ({ api: { tokenMonitor: { updateTask: vi.fn(), startUpdate: vi.fn() } }, readApiJson: async (r: Response) => { const data = await r.json(); if (!r.ok) throw new Error(data.error); return data; } }));
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.useRealTimers(); });
it('starts once, shows the durable conversation link, and disables repeated update clicks', async () => {
  vi.mocked(api.tokenMonitor.updateTask).mockResolvedValue(Response.json({ task: null }));
  let finish!: (r: Response) => void;
  vi.mocked(api.tokenMonitor.startUpdate).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  render(<MonitorUpdater available />);
  fireEvent.click(screen.getByRole('button', { name: '更新' }));
  expect(screen.getByRole('button', { name: '正在启动…' }).hasAttribute('disabled')).toBe(true);
  await act(async () => { finish(Response.json({ task: { sessionId: 'job', targetVersion: '9.0.0', state: 'running' } })); });
  expect(screen.getByRole('link', { name: '查看更新任务' }).getAttribute('href')).toBe('/session/job');
  fireEvent.click(screen.getByRole('button', { name: '更新中…' }));
  expect(api.tokenMonitor.startUpdate).toHaveBeenCalledTimes(1);
});
it('restores persisted task status and only reports installation after server verification', async () => {
  vi.mocked(api.tokenMonitor.updateTask).mockResolvedValue(Response.json({ task: { sessionId: 'job', state: 'review' } }));
  render(<MonitorUpdater available />);
  await screen.findByText(/任务已结束，请查看验证与部署结果/);
  expect(screen.queryByText(/更新已生效/)).toBeNull();
  expect(screen.getByRole('button', { name: '更新' }).hasAttribute('disabled')).toBe(true);
  expect(api.tokenMonitor.startUpdate).not.toHaveBeenCalled();
});
it('displays startup errors without fabricating success', async () => {
  vi.mocked(api.tokenMonitor.updateTask).mockResolvedValue(Response.json({ task: null }));
  vi.mocked(api.tokenMonitor.startUpdate).mockResolvedValue(Response.json({ error: '没有可验证的新版本' }, { status: 409 }));
  render(<MonitorUpdater available />);
  fireEvent.click(screen.getByRole('button', { name: '更新' }));
  await screen.findByRole('alert');
  await waitFor(() => expect(screen.getByRole('button', { name: '更新' }).hasAttribute('disabled')).toBe(false));
  expect(screen.queryByRole('link')).toBeNull();
});
