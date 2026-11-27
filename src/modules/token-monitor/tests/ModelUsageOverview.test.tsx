import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ModelUsageOverview } from '@/modules/token-monitor/ModelUsageOverview';
import { ReplyModelDetails, ReplyModelProvider } from '@/modules/token-monitor/ReplyModels';
import { MonitorButton, TokenMonitorProvider } from '@/modules/token-monitor';
import { api } from '@/shared/api';
import type { MonitorSessionsPayload } from '@/shared/types';

vi.mock('@/shared/api', () => ({
  api: {
    tokenMonitor: {
      replyModels: vi.fn().mockImplementation(async id => Response.json({ sessionId: id, status: 'ok', models: [] })),
      updateTask: vi.fn().mockImplementation(async () => Response.json({ task: null })),
      startUpdate: vi.fn(),
      snapshot: vi.fn(),
      updates: vi.fn().mockResolvedValue(
        Response.json({
          status: 'ok',
          updateAvailable: false,
          installedVersion: '0.97.0',
          latestVersion: '0.97.0',
          url: 'https://github.com/Javis603/token-monitor',
        }),
      ),
      sessions: vi.fn(),
    },
  },
  readApiJson: async (response: Response) => response.json(),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const samplePayload: MonitorSessionsPayload = {
  sessions: [
    {
      sessionId: 's1',
      provider: 'codex',
      title: 'Codex 主力会话',
      archived: false,
      recordedModels: ['gpt-6.2-sol'],
      reportedModels: ['gpt-6.2-sol'],
      totals: { input: 1000, output: 500, cacheRead: 4000, cacheWrite: 0, reasoning: 100, total: 5500 },
      speed: 42.5,
      timedOutputTokens: 500,
      timedDurationMs: 11765,
      modelUsage: [
        {
          model: 'gpt-6.2-sol',
          source: 'reported',
          tokens: { input: 1000, output: 500, cacheRead: 4000, cacheWrite: 0, reasoning: 100, total: 5500 },
          reportedTokens: { input: 1000, output: 500, cacheRead: 4000, cacheWrite: 0, reasoning: 100, total: 5500 },
          turnCount: 3,
          timedOutputTokens: 500,
          timedDurationMs: 11765,
          speed: 42.5,
          share: 1,
        },
      ],
    },
    {
      sessionId: 's2',
      provider: 'antigravity',
      title: 'AGY 高速会话',
      archived: true,
      recordedModels: ['gemini-4-neon-medium'],
      reportedModels: ['gemini-4-neon'],
      totals: { input: 500, output: 1200, cacheRead: 300, cacheWrite: 0, reasoning: 0, total: 2000 },
      speed: 96.4,
      timedOutputTokens: 1200,
      timedDurationMs: 12448,
      modelUsage: [
        {
          model: 'gemini-4-neon',
          source: 'reported',
          tokens: { input: 500, output: 1200, cacheRead: 300, cacheWrite: 0, reasoning: 0, total: 2000 },
          reportedTokens: { input: 500, output: 1200, cacheRead: 300, cacheWrite: 0, reasoning: 0, total: 2000 },
          turnCount: 2,
          timedOutputTokens: 1200,
          timedDurationMs: 12448,
          speed: 96.4,
          share: 1,
        },
      ],
    },
    {
      sessionId: 's3',
      provider: 'codex',
      title: '旧版仅请求记录',
      archived: true,
      recordedModels: ['legacy-requested-only'],
      reportedModels: [],
      totals: { input: 300, output: 100, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 400 },
      speed: null,
      timedOutputTokens: 0,
      timedDurationMs: 0,
      modelUsage: [
        {
          model: 'legacy-requested-only',
          source: 'requested',
          tokens: { input: 300, output: 100, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 400 },
          reportedTokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0 },
          turnCount: 1,
          timedOutputTokens: 0,
          timedDurationMs: 0,
          speed: null,
          share: 1,
        },
      ],
    },
  ],
};

it('renders all-model token usage, tok/s speed, scope toggle and speed sorting', () => {
  render(<ModelUsageOverview data={samplePayload} />);
  const section = screen.getByRole('group', { name: '全部模型用量与速度统计' });
  expect(within(section).getByText(/3 个模型 · 总计 7,900/)).toBeTruthy();
  expect(within(section).getByText('⚡ 42.5 tok/s')).toBeTruthy();
  expect(within(section).getByText('⚡ 96.4 tok/s')).toBeTruthy();
  expect(within(section).getByText('legacy-requested-only')).toBeTruthy();

  // Filter strictly to response-reported models
  fireEvent.change(within(section).getByRole('combobox', { name: '模型归因口径' }), {
    target: { value: 'reported' },
  });
  expect(within(section).queryByText('legacy-requested-only')).toBeNull();
  expect(within(section).getByText(/2 个模型 · 总计 7,500/)).toBeTruthy();

  // Sort by fastest output speed (gemini-4-neon 96.4 tok/s ahead of gpt-6.2-sol 42.5 tok/s)
  fireEvent.change(within(section).getByRole('combobox', { name: '模型统计排序' }), {
    target: { value: 'speed' },
  });
  const text = section.textContent || '';
  expect(text.indexOf('gemini-4-neon')).toBeLessThan(text.indexOf('gpt-6.2-sol'));

  // Filter by tool
  fireEvent.change(within(section).getByRole('combobox', { name: '按工具筛选模型统计' }), {
    target: { value: 'antigravity' },
  });
  expect(within(section).queryByText('gpt-6.2-sol')).toBeNull();
  expect(within(section).getByText('gemini-4-neon')).toBeTruthy();
});

it('renders session tok/s speed in MonitorButton, inspector dialog, and per-reply annotations', async () => {
  vi.mocked(api.tokenMonitor.sessions).mockResolvedValue(Response.json(samplePayload));
  vi.mocked(api.tokenMonitor.snapshot).mockResolvedValue(
    Response.json({
      sessionId: 's1',
      provider: 'codex',
      configuredModel: 'gpt-6.2-sol',
      returnedModel: 'gpt-6.2-sol',
      checkedAt: Date.now(),
      status: 'ok',
      limited: false,
      totals: { input: 1000, output: 500, cacheRead: 4000, cacheWrite: 0, reasoning: 100, total: 5500 },
      totalsScope: 'session',
      speed: 42.5,
      latestSpeed: 48.2,
      timedOutputTokens: 500,
      timedDurationMs: 11765,
      modelUsage: samplePayload.sessions[0].modelUsage,
      alerts: [],
      replies: [],
      usage: [
        {
          timestamp: '2026-11-25T00:00:10Z',
          tokens: { input: 1000, output: 500, cacheRead: 4000, cacheWrite: 0, reasoning: 100, total: 5500 },
          model: 'gpt-6.2-sol',
          durationMs: 10373,
          tokensPerSec: 48.2,
        },
      ],
    }),
  );
  vi.mocked(api.tokenMonitor.replyModels).mockResolvedValue(
    Response.json({
      sessionId: 's1',
      status: 'ok',
      models: [
        {
          messageIds: ['msg-speed'],
          timestamp: '2026-11-25T00:00:10Z',
          requestedModel: 'gpt-6.2-sol',
          reportedModel: 'gpt-6.2-sol',
          durationMs: 10373,
          tokensPerSec: 48.2,
        },
      ],
    }),
  );

  render(
    <TokenMonitorProvider sessionId="s1" model="gpt-6.2-sol">
      <MonitorButton variant="card" />
      <MonitorButton model />
      <ReplyModelProvider sessionId="s1">
        <ReplyModelDetails sessionId="s1" messageId="msg-speed" timestamp="2026-11-25T00:00:10Z" provider="codex" />
      </ReplyModelProvider>
    </TokenMonitorProvider>,
  );

  await screen.findByText('gpt-6.2-sol · 48.2 tok/s');
  await screen.findByText('48.2 tok/s (10.4s)');

  fireEvent.click(screen.getByRole('button', { name: '查看真实返回模型与 token' }));
  const dialog = await screen.findByRole('dialog');
  expect(within(dialog).getByText('模型输出速度')).toBeTruthy();
  expect(within(dialog).getAllByText(/42\.5 tok\/s/).length).toBeGreaterThan(0);
  await within(dialog).findByText(/3 个模型 · 总计 7,900/);
});

it('renders ThinkTranslateOverview failover diagnostics and AGY channel/plugin annotations', async () => {
  vi.mocked(api.tokenMonitor.sessions).mockResolvedValue(
    Response.json({
      ...samplePayload,
      thinkTranslate: {
        configuredAccountId: 'agy:user-a@example.com',
        configuredModel: 'gemini-4-hydrogen-medium',
        totalCalls: 4,
        cachedCalls: 1,
        fallbackCalls: 2,
        failedCalls: 0,
        tokens: { input: 18000, output: 360, cacheRead: 6000, cacheWrite: 0, reasoning: 0, total: 24360 },
        timedOutputTokens: 360,
        timedDurationMs: 6000,
        speed: 60,
        models: [
          {
            model: 'gemini-3.8-flash-low',
            platform: 'agy',
            callCount: 3,
            tokens: { input: 18000, output: 360, cacheRead: 6000, cacheWrite: 0, reasoning: 0, total: 24360 },
            timedOutputTokens: 360,
            timedDurationMs: 6000,
            speed: 60,
          },
        ],
        cooldowns: [
          {
            accountId: 'agy:user-a@example.com',
            model: '',
            reason: '翻译模型额度已耗尽（HTTP 429，约 163h 后重置）',
            remainingSeconds: 18000,
          },
        ],
        recent: [
          {
            timestamp: '2026-11-25T16:58:00Z',
            platform: 'agy',
            accountLabel: 'agy:user-b@example.com',
            requestedModel: 'gemini-3.8-flash-low',
            reportedModel: 'gemini-3.8-flash-low',
            tokens: { input: 6000, output: 120, cacheRead: 2000, cacheWrite: 0, reasoning: 0, total: 8120 },
            durationMs: 2000,
            tokensPerSec: 60,
            cached: false,
            fallbackUsed: true,
            fallbackReason: '原账号 429',
            status: 'ok',
            errorMessage: null,
          },
        ],
      },
    }),
  );
  vi.mocked(api.tokenMonitor.snapshot).mockResolvedValue(
    Response.json({
      sessionId: 'agy-1',
      provider: 'antigravity',
      configuredModel: 'gemini-4-carbon-high',
      returnedModel: 'gemini-4-carbon',
      checkedAt: Date.now(),
      status: 'ok',
      limited: false,
      totals: { input: 1000, output: 200, cacheRead: 500, cacheWrite: 0, reasoning: 50, total: 1700 },
      totalsScope: 'session',
      speed: 50,
      latestSpeed: 50,
      timedOutputTokens: 200,
      timedDurationMs: 4000,
      modelUsage: [],
      alerts: [],
      replies: [],
      usage: [],
    }),
  );
  vi.mocked(api.tokenMonitor.replyModels).mockResolvedValue(
    Response.json({
      sessionId: 'agy-1',
      status: 'ok',
      models: [
        {
          messageIds: ['msg-agy-1'],
          timestamp: '2026-11-25T16:58:10Z',
          requestedModel: 'gemini-4-carbon-high',
          reportedModel: 'gemini-4-carbon',
          durationMs: 4000,
          tokensPerSec: 50,
          transport: 'claude_agy',
          plugins: ['Armor', 'agy-fast'],
        },
      ],
    }),
  );

  render(
    <TokenMonitorProvider sessionId="agy-1" model="gemini-4-carbon-high">
      <MonitorButton />
      <ReplyModelProvider sessionId="agy-1">
        <ReplyModelDetails sessionId="agy-1" messageId="msg-agy-1" timestamp="2026-11-25T16:58:10Z" provider="antigravity" />
      </ReplyModelProvider>
    </TokenMonitorProvider>,
  );

  await screen.findByText('Claude → agy · Armor · agy-fast');
  fireEvent.click(screen.getByRole('button', { name: '开关监控窗口' }));
  const dialog = await screen.findByRole('dialog');
  await within(dialog).findByText(/思考翻译模型监控/);
  expect(within(dialog).getByText(/已自动旁路额度受限的翻译账号/)).toBeTruthy();
  expect(within(dialog).getByText(/容灾成功/)).toBeTruthy();
  expect(within(dialog).getByText(/mintcli 适配版 v1\.19\.0/)).toBeTruthy();
});
