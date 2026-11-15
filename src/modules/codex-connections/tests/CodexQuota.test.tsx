import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodexQuota } from '@/modules/codex-connections/CodexQuota';
import { api } from '@/shared/api';
vi.mock('@/shared/api',()=>({api:{codexConnections:{quota:vi.fn(),consumeReset:vi.fn()}}}));
vi.mock('@/modules/egress', () => ({ EgressButton: () => null }));
beforeEach(()=> { vi.clearAllMocks(); localStorage.clear(); }); afterEach(cleanup);
const response=(value: unknown)=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});

describe('real account quota display',()=>{
  it('shows server percentages for dynamic window durations',async()=>{
    vi.mocked(api.codexConnections.quota).mockResolvedValue(response({connectionId:'a',status:'available',planType:'business',windows:[{bucket:'codex',minutes:300,remainingPercent:75,resetsAt:Date.parse('2030-02-01T08:30:00Z') / 1000},{bucket:'codex',minutes:10080,remainingPercent:20,resetsAt:Date.parse('2030-02-06T18:00:00Z') / 1000}]}));
    render(<CodexQuota connectionId="a"/>);
    const fiveHour = await screen.findByRole('region', { name: 'codex · 5 小时额度' });
    const weekly = screen.getByRole('region', { name: 'codex · 7 天额度' });
    expect(within(fiveHour).getByText('75%')).toBeTruthy();
    expect(within(weekly).getByText('20%')).toBeTruthy();
    expect(fiveHour.querySelector('time')?.getAttribute('datetime')).toBe('2030-02-01T08:30:00.000Z');
    expect(weekly.querySelector('time')?.getAttribute('datetime')).toBe('2030-02-06T18:00:00.000Z');
  });
  it('shows unavailable provider balance without converting missing data to zero',async()=>{
    vi.mocked(api.codexConnections.quota).mockResolvedValue(response({connectionId:'api',status:'unavailable',windows:[],reason:'第三方 API 未提供通用余额接口；请以服务商后台为准。'}));
    render(<CodexQuota connectionId="api"/>);
    await screen.findByText('第三方 API 未提供通用余额接口；请以服务商后台为准。');
    expect(screen.queryByText('0%')).toBeNull();
    expect(screen.queryByRole('progressbar')).toBeNull();
  });
});


it('only redeems the selected account after confirmation, once, then refreshes quota',async()=>{
  vi.mocked(api.codexConnections.quota).mockResolvedValue(response({connectionId:'a',status:'available',windows:[],resetCredits:{availableCount:1,credits:[{id:'card-a',title:'Full reset',expiresAt:1900000000}]}}));
  vi.mocked(api.codexConnections.consumeReset).mockResolvedValue(response({connectionId:'a',status:'completed',resetOutcome:'reset'}));
  render(<CodexQuota connectionId="a"/>);
  fireEvent.click(await screen.findByRole('button',{name:'使用重置卡（1）'}));
  expect(api.codexConnections.consumeReset).not.toHaveBeenCalled();
  expect(screen.getByRole('combobox',{name:'选择重置卡'})).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'确认使用一张'}));
  await screen.findByText('重置成功，正在刷新额度。');
  expect(api.codexConnections.consumeReset).toHaveBeenCalledTimes(1);
  expect(api.codexConnections.consumeReset).toHaveBeenCalledWith('a',expect.any(String),'card-a');
  await waitFor(()=>expect(api.codexConnections.quota).toHaveBeenCalledTimes(2));
});

it('hides an account confirmation when switching accounts and never mutates on mount or refresh',async()=>{
  vi.mocked(api.codexConnections.quota).mockImplementation(id=>Promise.resolve(response({connectionId:id,status:'available',windows:[],resetCredits:{availableCount:1,credits:null}})));
  const view=render(<CodexQuota connectionId="a"/>);
  fireEvent.click(await screen.findByRole('button',{name:'使用重置卡（1）'}));
  view.rerender(<CodexQuota connectionId="b"/>);
  await waitFor(()=>expect(screen.queryByRole('dialog')).toBeNull());
  expect(api.codexConnections.consumeReset).not.toHaveBeenCalled();
});
