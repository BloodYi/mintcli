import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ReplyModelDetails, ReplyModelProvider } from '@/modules/token-monitor/ReplyModels';
import { api } from '@/shared/api';
vi.mock('@/shared/api', () => ({ api: { tokenMonitor: { replyModels: vi.fn() } }, readApiJson: async (r: Response) => r.json() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.useRealTimers(); });
const row = (id: string, reported: string | null, timestamp = '2026-01-01T00:00:00Z') => ({ messageIds: [id], timestamp, requestedModel: 'requested-' + id, reportedModel: reported });
const details = (id: string, sessionId = 'session') => <ReplyModelDetails sessionId={sessionId} messageId={id} timestamp="2026-01-01T00:00:00Z" provider="codex" />;
it('shows both names for each reply with one poll and supports collapse/expand', async () => {
  vi.mocked(api.tokenMonitor.replyModels).mockResolvedValue(Response.json({ sessionId: 'session', status: 'ok', models: [row('one', 'real-one'), row('two', null)] }));
  const { container } = render(<ReplyModelProvider sessionId="session">{details('one')}{details('two')}</ReplyModelProvider>);
  await screen.findByText('real-one');
  expect(screen.getByText('requested-one')).toBeTruthy();
  expect(screen.getByText('requested-two')).toBeTruthy();
  expect(screen.getByText('未报告')).toBeTruthy();
  expect(api.tokenMonitor.replyModels).toHaveBeenCalledTimes(1);
  const disclosure = container.querySelector('details')!;
  expect(disclosure.open).toBe(true);
  disclosure.open = false; fireEvent(disclosure, new Event('toggle'));
  expect(disclosure.open).toBe(false);
  disclosure.open = true; fireEvent(disclosure, new Event('toggle'));
  expect(disclosure.open).toBe(true);
});
it('does not guess across colliding timestamps or use another session index', async () => {
  vi.mocked(api.tokenMonitor.replyModels).mockResolvedValue(Response.json({ sessionId: 'session', status: 'ok', models: [row('one', 'real-one'), row('two', 'real-two')] }));
  const view = render(<ReplyModelProvider sessionId="session">{details('unknown')}</ReplyModelProvider>);
  await screen.findByText('未报告');
  expect(screen.queryByText('real-one')).toBeNull(); expect(screen.queryByText('real-two')).toBeNull();
  let finish!: (value: Response) => void;
  vi.mocked(api.tokenMonitor.replyModels).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  view.rerender(<ReplyModelProvider sessionId="other">{details('one', 'other')}</ReplyModelProvider>);
  await screen.findByText('读取中…');
  await act(async () => { finish(Response.json({ sessionId: 'session', status: 'ok', models: [row('one', 'wrong-session')] })); });
  expect(screen.queryByText('wrong-session')).toBeNull();
});
it('refreshes captured names and aborts polling on unmount', async () => {
  vi.useFakeTimers();
  vi.mocked(api.tokenMonitor.replyModels).mockImplementation(async () => Response.json({ sessionId: 'session', status: 'ok', models: [row('one', null)] }));
  const view = render(<ReplyModelProvider sessionId="session">{details('one')}</ReplyModelProvider>);
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  const disclosure = view.container.querySelector('details')!; disclosure.open = false;
  vi.mocked(api.tokenMonitor.replyModels).mockImplementation(async () => Response.json({ sessionId: 'session', status: 'ok', models: [row('one', 'new-captured-model')] }));
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
  expect(screen.getByText('new-captured-model')).toBeTruthy();
  expect(disclosure.open).toBe(false);
  view.unmount(); await act(async () => { await vi.advanceTimersByTimeAsync(9000); });
  expect(api.tokenMonitor.replyModels).toHaveBeenCalledTimes(2);
});
it('uses Claude row response fields when available without copying a chosen model into the real label', () => {
  render(<ReplyModelDetails sessionId={null} timestamp="" model="claude-reported" provider="claude" />);
  expect(screen.getAllByText('claude-reported')).toHaveLength(2);
});

it('uses an exact unique timestamp to distinguish reused native ids across turns', async () => {
  vi.mocked(api.tokenMonitor.replyModels).mockResolvedValue(Response.json({sessionId:'session',status:'ok',models:[row('same','old-real'),row('same','new-real','2026-01-01T00:01:00Z')]}));
  render(<ReplyModelProvider sessionId="session"><ReplyModelDetails sessionId="session" messageId="same" timestamp="2026-01-01T00:01:00Z" provider="codex" /></ReplyModelProvider>);
  await screen.findByText('new-real');
  expect(screen.queryByText('old-real')).toBeNull();
});
