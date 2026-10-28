import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AccountQuota } from '@/modules/agent-connections/AccountQuota';
import { api } from '@/shared/api';
vi.mock('@/shared/api', () => ({ api: { agentConnections: { quota: vi.fn() } }, readApiJson: async (response: Response) => response.json() }));
afterEach(cleanup);
it('a slow response from the previous provider cannot replace the new account quota', async () => {
  let finish: (value: Response) => void = () => {};
  vi.mocked(api.agentConnections.quota).mockImplementation(async id => id === 'codex:a' ? new Promise(resolve => { finish = resolve; }) : Response.json({ connectionId: id, windows: [{ bucket: 'Gemini', remainingPercent: 98, resetsAt: null }] }));
  const view = render(<AccountQuota id="codex:a" />);
  view.rerender(<AccountQuota id="antigravity:b" />);
  await screen.findByText('98%');
  finish(Response.json({ connectionId: 'codex:a', windows: [{ bucket: 'Codex', remainingPercent: 5, resetsAt: null }] }));
  await Promise.resolve();
  expect(screen.queryByText('Codex · 剩余 5%')).toBeNull();
});

it('groups native agy allowances and removes paid Argon when switching to a free account', async () => {
  vi.mocked(api.agentConnections.quota).mockImplementation(async id => Response.json({ connectionId: id, windows: [
    { model: 'Gemini Models', type: 'five_hour', bucket: 'Five Hour Limit Remaining', remainingPercent: 57, resetsAt: null },
    { model: 'Gemini Models', type: 'weekly', bucket: 'Weekly Limit Remaining', remainingPercent: 93, resetsAt: null },
    { model: 'Claude and GPT models', type: 'weekly', bucket: 'Weekly Limit Remaining', remainingPercent: 100, resetsAt: null },
    ...(id === 'antigravity:paid' ? [{ model: 'Gemini 4 Argon', type: 'weekly', bucket: 'Gemini 4 Argon Weekly Limit', remainingPercent: 0, resetsAt: null }] : []),
  ] }));
  const view = render(<AccountQuota id="antigravity:paid" />);
  await screen.findByText('Gemini 4 Argon Weekly Limit');
  expect(screen.getByText('Gemini 模型')).toBeTruthy();
  expect(screen.getByText('Claude 与 GPT 模型')).toBeTruthy();
  const gemini = screen.getByText('Gemini 模型').parentElement!;
  expect(gemini.textContent!.indexOf('每周配额剩余')).toBeLessThan(gemini.textContent!.indexOf('5 小时配额剩余'));
  expect(screen.getByText('0%')).toBeTruthy();
  view.rerender(<AccountQuota id="antigravity:free" />);
  expect(screen.queryByText('Gemini 4 Argon')).toBeNull();
  await screen.findByText('Gemini 模型');
  expect(screen.queryByText('Gemini 4 Argon Weekly Limit')).toBeNull();
});
