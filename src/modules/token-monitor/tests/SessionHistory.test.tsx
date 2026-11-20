import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
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
  fireEvent.click(screen.getByText('全部历史会话（0，含归档）'));
  fireEvent.change(screen.getByRole('textbox', { name: '搜索历史会话' }), { target: { value: 'ACTUAL-NEW' } });
  expect(screen.getByText('没有匹配的会话。')).toBeTruthy();
  await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
  expect(screen.getByText('全部历史会话（1，含归档）')).toBeTruthy();
  expect(screen.getByText('返回模型：actual-new')).toBeTruthy();
  view.unmount();
  await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
  expect(api.tokenMonitor.sessions).toHaveBeenCalledTimes(2);
});
it('combines tool and model search across archived history without changing the selected chat', async () => {
  const onSelect = vi.fn();
  vi.mocked(api.tokenMonitor.sessions).mockResolvedValue(Response.json({ sessions: [
    { sessionId: 'codex', title: 'Codex 会话', provider: 'codex', recordedModels: [], reportedModels: ['same-model'], totals: null },
    { sessionId: 'agy', title: '归档 AGY', provider: 'antigravity', archived: true, recordedModels: [], reportedModels: ['same-model'], totals: { total: 12 } },
    { sessionId: 'claude', title: 'Claude 会话', provider: 'claude', recordedModels: [], reportedModels: ['other-model'], totals: null },
  ] }));
  render(<SessionHistory selectedId="codex" onSelect={onSelect} revision={0} />);
  await screen.findByText('全部历史会话（3，含归档）');
  fireEvent.click(screen.getByText('全部历史会话（3，含归档）'));
  fireEvent.change(screen.getByRole('combobox', { name: '按工具筛选历史会话' }), { target: { value: 'antigravity' } });
  fireEvent.change(screen.getByRole('textbox', { name: '搜索历史会话' }), { target: { value: 'same-model' } });
  expect(screen.queryByRole('button', { name: /Codex 会话/ })).toBeNull();
  expect(screen.queryByRole('button', { name: /Claude 会话/ })).toBeNull();
  expect(onSelect).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: /归档 AGY.*已归档/ }));
  expect(onSelect).toHaveBeenCalledWith('agy');
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'claude' } });
  expect(screen.getByText('没有匹配的会话。')).toBeTruthy();
  fireEvent.change(screen.getByRole('combobox'), { target: { value: '' } });
  expect(screen.getByRole('button', { name: /Codex 会话/ }).getAttribute('aria-pressed')).toBe('true');
  expect(screen.getByRole('button', { name: /归档 AGY/ })).toBeTruthy();
});

it('matches case-insensitive terms across archived titles, tool labels, models and IDs', async () => {
  const onSelect = vi.fn();
  vi.mocked(api.tokenMonitor.sessions).mockResolvedValue(Response.json({ sessions: [
    { sessionId: 'Unique-Archive-42', title: '历史记录', provider: 'antigravity', archived: true, recordedModels: [], reportedModels: ['gemini-reported'], totals: null },
    { sessionId: 'other', title: '其他记录', provider: 'codex', recordedModels: [], reportedModels: [], totals: null },
  ] }));
  render(<SessionHistory onSelect={onSelect} revision={0} />);
  fireEvent.click(await screen.findByText('全部历史会话（2，含归档）'));
  const search = screen.getByRole('textbox', { name: '搜索历史会话' });
  fireEvent.change(search, { target: { value: '  ARCHIVE-42   AGY gemini  ' } });
  expect(screen.getByRole('button', { name: /历史记录.*已归档/ })).toBeTruthy();
  expect(screen.queryByRole('button', { name: /其他记录/ })).toBeNull();
  expect(onSelect).not.toHaveBeenCalled();
  fireEvent.change(search, { target: { value: 'archive-42 codex' } });
  expect(screen.getByText('没有匹配的会话。')).toBeTruthy();
  fireEvent.change(search, { target: { value: '   ' } });
  expect(screen.getAllByRole('button')).toHaveLength(2);
});
