import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodexQuota } from '@/modules/codex-connections/CodexQuota';
import { api } from '@/shared/api';
vi.mock('@/shared/api',()=>({api:{codexConnections:{quota:vi.fn()}}}));
beforeEach(()=>vi.clearAllMocks()); afterEach(cleanup);
const response=(value: unknown)=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});

describe('real account quota display',()=>{
  it('shows server percentages for dynamic window durations',async()=>{
    vi.mocked(api.codexConnections.quota).mockResolvedValue(response({connectionId:'a',status:'available',planType:'business',windows:[{bucket:'codex',minutes:300,remainingPercent:75,resetsAt:1800000000},{bucket:'codex',minutes:10080,remainingPercent:20,resetsAt:1800000001}]}));
    render(<CodexQuota connectionId="a"/>);
    await screen.findByText('codex · 5 小时 · 剩余 75%');
    await screen.findByText('codex · 7 天 · 剩余 20%');
  });
  it('shows unavailable provider balance without converting missing data to zero',async()=>{
    vi.mocked(api.codexConnections.quota).mockResolvedValue(response({connectionId:'api',status:'unavailable',windows:[],reason:'第三方 API 未提供通用余额接口；请以服务商后台为准。'}));
    render(<CodexQuota connectionId="api"/>);
    await screen.findByText('第三方 API 未提供通用余额接口；请以服务商后台为准。');
    expect(screen.queryByText(/剩余 0%/)).toBeNull();
  });
});
