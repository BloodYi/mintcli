import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { SessionHistory } from '@/modules/token-monitor/SessionHistory';
import { api } from '@/shared/api';
vi.mock('@/shared/api', () => ({ api: { tokenMonitor: { sessions: vi.fn() } }, readApiJson: async (response: Response) => response.json() }));
afterEach(() => { cleanup(); vi.useRealTimers(); });
it('refreshes new conversations while open and stops requests after unmount', async () => {
  vi.useFakeTimers();
  vi.mocked(api.tokenMonitor.sessions).mockResolvedValueOnce(Response.json({ sessions: [] })).mockResolvedValue(Response.json({ sessions: [
    { sessionId: 'new', title: '新会话', provider: 'codex', recordedModels: [], reportedModels: ['actual-new'], totals: { total: 12 } },
  ] }));
  const view = render(<SessionHistory onSelect={() => {}} revision={0} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(screen.getByText('全部历史会话（0，含归档）')).toBeTruthy();
  await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
  expect(screen.getByText('全部历史会话（1，含归档）')).toBeTruthy();
  expect(screen.getByText('返回模型：actual-new')).toBeTruthy();
  view.unmount();
  await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
  expect(api.tokenMonitor.sessions).toHaveBeenCalledTimes(2);
});
