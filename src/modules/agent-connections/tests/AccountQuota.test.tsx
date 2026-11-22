import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AccountQuota } from '@/modules/agent-connections/AccountQuota';
import { api } from '@/shared/api';
vi.mock('@/shared/api', () => ({ api: { agentConnections: { quota: vi.fn() }, codexConnections: { consumeReset: vi.fn() } }, readApiJson: async (response: Response) => response.json() }));
vi.mock('@/modules/egress', () => ({ EgressButton: () => null }));
vi.mock('@/modules/token-monitor', () => ({ MonitorButton: () => null }));
beforeEach(() => { vi.clearAllMocks(); localStorage.clear(); });
afterEach(cleanup);

it('shows distinct visible reset times for the five-hour and weekly windows', async () => {
  vi.mocked(api.agentConnections.quota).mockResolvedValue(Response.json({ connectionId: 'codex:a', windows: [
    { bucket: 'codex', minutes: 300, remainingPercent: 75, resetsAt: Date.parse('2030-02-01T08:30:00Z') / 1000 },
    { bucket: 'codex', minutes: 10080, remainingPercent: 20, resetsAt: Date.parse('2030-02-06T18:00:00Z') / 1000 },
  ] }));
  render(<AccountQuota id="codex:a" />);
  const fiveHour = await screen.findByRole('region', { name: 'codex · 5 小时额度' });
  const weekly = screen.getByRole('region', { name: 'codex · 7 天额度' });
  expect(within(fiveHour).getByText('75%')).toBeTruthy();
  expect(within(weekly).getByText('20%')).toBeTruthy();
  expect(fiveHour.querySelector('time')?.getAttribute('datetime')).toBe('2030-02-01T08:30:00.000Z');
  expect(weekly.querySelector('time')?.getAttribute('datetime')).toBe('2030-02-06T18:00:00.000Z');
  expect(fiveHour.textContent).toContain('重置');
  expect(weekly.textContent).toContain('重置');
});

it('a slow response from the previous provider cannot replace the new account quota', async () => {
  let finish: (value: Response) => void = () => {};
  vi.mocked(api.agentConnections.quota).mockImplementation(async id => id === 'codex:a' ? new Promise(resolve => { finish = resolve; }) : Response.json({ connectionId: id, windows: [{ bucket: 'Gemini', remainingPercent: 98, resetsAt: Date.parse('2030-02-02T09:00:00Z') / 1000 }] }));
  const view = render(<AccountQuota id="codex:a" />);
  view.rerender(<AccountQuota id="antigravity:b" />);
  await screen.findByText('98%');
  await act(async () => { finish(Response.json({ connectionId: 'codex:a', windows: [{ bucket: 'Codex', remainingPercent: 5, resetsAt: Date.parse('2030-02-01T08:30:00Z') / 1000 }] })); });
  expect(screen.queryByText('5%')).toBeNull();
  expect(screen.getByRole('region', { name: 'Gemini额度' }).querySelector('time')?.getAttribute('datetime')).toBe('2030-02-02T09:00:00.000Z');
});

it('hides the previous account reset time immediately while the new account is loading', async () => {
  let finish: (value: Response) => void = () => {};
  vi.mocked(api.agentConnections.quota).mockImplementation(async id => id === 'codex:b' ? new Promise(resolve => { finish = resolve; }) : Response.json({ connectionId: id, windows: [
    { bucket: 'codex', minutes: 300, remainingPercent: 75, resetsAt: Date.parse('2030-02-01T08:30:00Z') / 1000 },
  ] }));
  const view = render(<AccountQuota id="codex:a" />);
  await screen.findByText('75%');
  view.rerender(<AccountQuota id="codex:b" />);
  expect(view.container.querySelector('time')).toBeNull();
  expect(screen.queryByText('75%')).toBeNull();
  await act(async () => { finish(Response.json({ connectionId: 'codex:b', windows: [
    { bucket: 'codex', minutes: 300, remainingPercent: 40, resetsAt: Date.parse('2030-02-03T12:00:00Z') / 1000 },
  ] })); });
  expect(screen.getByText('40%')).toBeTruthy();
  expect(view.container.querySelector('time')?.getAttribute('datetime')).toBe('2030-02-03T12:00:00.000Z');
});

it('groups native agy allowances and removes paid Argon when switching to a free account', async () => {
  vi.mocked(api.agentConnections.quota).mockImplementation(async id => Response.json({ connectionId: id, windows: [
    { model: 'Gemini Models', type: 'five_hour', bucket: 'Five Hour Limit Remaining', remainingPercent: 57, resetsAt: Date.parse('2030-02-01T08:30:00Z') / 1000 },
    { model: 'Gemini Models', type: 'weekly', bucket: 'Weekly Limit Remaining', remainingPercent: 93, resetsAt: Date.parse('2030-02-06T18:00:00Z') / 1000 },
    { model: 'Claude and GPT models', type: 'weekly', bucket: 'Weekly Limit Remaining', remainingPercent: 100, resetsAt: Date.parse('2030-02-07T12:00:00Z') / 1000 },
    ...(id === 'antigravity:paid' ? [{ model: 'Gemini 4 Argon', type: 'weekly', bucket: 'Gemini 4 Argon Weekly Limit', remainingPercent: 0, resetsAt: Date.parse('2030-02-08T12:00:00Z') / 1000 }] : []),
  ] }));
  const view = render(<AccountQuota id="antigravity:paid" />);
  await screen.findByText('Gemini 4 Argon');
  expect(screen.getByText('Gemini 模型')).toBeTruthy();
  expect(screen.getByText('Claude 与 GPT 模型')).toBeTruthy();
  const gemini = screen.getByText('Gemini 模型').parentElement!;
  expect(gemini.textContent!.indexOf('每周配额剩余')).toBeLessThan(gemini.textContent!.indexOf('5 小时配额剩余'));
  expect(within(gemini).getByRole('region', { name: '5 小时配额剩余额度' }).querySelector('time')?.getAttribute('datetime')).toBe('2030-02-01T08:30:00.000Z');
  expect(within(gemini).getByRole('region', { name: '每周配额剩余额度' }).querySelector('time')?.getAttribute('datetime')).toBe('2030-02-06T18:00:00.000Z');
  const claude = screen.getByText('Claude 与 GPT 模型').parentElement!;
  expect(claude.querySelector('time')?.getAttribute('datetime')).toBe('2030-02-07T12:00:00.000Z');
  expect(screen.getByText('Gemini 4 Argon').parentElement?.querySelector('time')?.getAttribute('datetime')).toBe('2030-02-08T12:00:00.000Z');
  expect(screen.getByText('0%')).toBeTruthy();
  view.rerender(<AccountQuota id="antigravity:free" />);
  expect(screen.queryByText('Gemini 4 Argon')).toBeNull();
  await screen.findByText('Gemini 模型');
  expect(screen.queryByText('Gemini 4 Argon')).toBeNull();
});

it('preserves collapse preferences and restores reset times when expanded', async () => {
  vi.mocked(api.agentConnections.quota).mockResolvedValue(Response.json({ connectionId: 'codex:a', windows: [
    { bucket: 'codex', minutes: 300, remainingPercent: 75, resetsAt: Date.parse('2030-02-01T08:30:00Z') / 1000 },
  ] }));
  const view = render(<AccountQuota id="codex:a" />);
  await screen.findByText('75%');
  fireEvent.click(screen.getByRole('button', { name: '收起账号额度' }));
  expect(view.container.querySelector('time')).toBeNull();
  expect(localStorage.getItem('account-quota-collapsed')).toBe('true');
  fireEvent.click(screen.getByRole('button', { name: '展开账号额度' }));
  expect(view.container.querySelector('time')?.getAttribute('datetime')).toBe('2030-02-01T08:30:00.000Z');
  expect(localStorage.getItem('account-quota-collapsed')).toBe('false');
});


it('opens official Claude reset controls only for Claude accounts',async()=>{
  vi.mocked(api.agentConnections.quota).mockImplementation(async id=>Response.json({connectionId:id,windows:[]}));
  const view=render(<AccountQuota id="claude:fixture"/>);
  expect(screen.getByRole('link',{name:'使用重置卡 ↗'}).getAttribute('href')).toBe('https://claude.ai/settings/usage');
  view.rerender(<AccountQuota id="antigravity:fixture"/>);
  expect(screen.queryByRole('link',{name:'使用重置卡 ↗'})).toBeNull();
});


it('unified quota bar exposes the official Codex reset and redeems only after confirmation',async()=>{
  vi.mocked(api.agentConnections.quota).mockResolvedValue(Response.json({connectionId:'codex:fixture',windows:[],resetCredits:{availableCount:1,credits:null}}));
  vi.mocked(api.codexConnections.consumeReset).mockResolvedValue(Response.json({connectionId:'fixture',resetOutcome:'nothingToReset'}));
  render(<AccountQuota id="codex:fixture"/>);
  fireEvent.click(await screen.findByRole('button',{name:'使用重置卡（1）'}));
  expect(api.codexConnections.consumeReset).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:'确认使用一张'}));
  await screen.findByText('当前额度无需重置，卡未消耗。');
  expect(api.codexConnections.consumeReset).toHaveBeenCalledWith('fixture',expect.any(String),undefined);
});

it('API quota does not offer an official account reset',async()=>{
  vi.mocked(api.agentConnections.quota).mockResolvedValue(Response.json({connectionId:'api:fixture',windows:[]}));
  render(<AccountQuota id="api:fixture"/>);
  expect(screen.queryByRole('button',{name:/使用重置卡/})).toBeNull();
});

it('separates embedded mobile Codex reset controls into their own wrapping row without crowding the header', async () => {
  vi.mocked(api.agentConnections.quota).mockResolvedValue(Response.json({
    connectionId: 'codex:team-acct',
    planType: 'team',
    checkedAt: Date.parse('2030-02-01T01:11:58Z'),
    resetCredits: { availableCount: 3, credits: [{ id: 'c1', title: 'Reset' }] },
    windows: [
      { bucket: 'codex', minutes: 300, remainingPercent: 67, resetsAt: Date.parse('2030-02-01T01:53:00Z') / 1000 },
      { bucket: 'codex', minutes: 10080, remainingPercent: 67, resetsAt: Date.parse('2030-02-06T15:27:00Z') / 1000 },
    ],
  }));

  render(<AccountQuota id="codex:team-acct" embedded showUtilities={false} />);

  const resetBtn = await screen.findByRole('button', { name: '使用重置卡（3）' });
  const officialLink = screen.getByRole('link', { name: '官方用量与重置 ↗' });
  const toggleBtn = screen.getByRole('button', { name: '收起账号额度' });
  const refreshBtn = screen.getByRole('button', { name: '刷新额度' });
  const actionsRow = screen.getByTestId('embedded-quota-actions');

  expect(actionsRow.contains(resetBtn)).toBe(true);
  expect(actionsRow.contains(officialLink)).toBe(true);
  expect(actionsRow.contains(toggleBtn)).toBe(false);
  expect(actionsRow.contains(refreshBtn)).toBe(false);
  expect(actionsRow.className).toContain('flex-wrap');
  expect(toggleBtn.className).toContain('overflow-hidden');
  expect(within(toggleBtn).getByText('team')).toBeTruthy();
  expect(within(toggleBtn).getByText('剩余额度')).toBeTruthy();
});
