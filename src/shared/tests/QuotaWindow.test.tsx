import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QuotaWindow } from '@/shared/ui/QuotaWindow';

const NOW = new Date('2026-11-09T12:00:00Z').getTime();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('quota reset cards', () => {
  it('shows an exact reset timestamp and advances the countdown locally', () => {
    const resetsAt = NOW / 1000 + 7200;
    const { container } = render(<QuotaWindow label="5 小时额度" remainingPercent={75} resetsAt={resetsAt} />);
    const time = container.querySelector('time')!;
    expect(time.dateTime).toBe(new Date(resetsAt * 1000).toISOString());
    expect(time.textContent).toMatch(/^11月09日 \d{2}:\d{2}$/);
    expect(screen.getByText('2 小时后重置')).toBeTruthy();
    const progress = screen.getByRole('progressbar', { name: '5 小时额度剩余额度' });
    expect(progress.getAttribute('aria-valuenow')).toBe('75');
    act(() => vi.advanceTimersByTime(60000));
    expect(screen.getByText('1 小时 59 分钟后重置')).toBeTruthy();
  });

  it('includes days for a weekly reset', () => {
    render(<QuotaWindow label="周额度" remainingPercent={20} resetsAt={NOW / 1000 + 2 * 86400 + 3 * 3600 + 5 * 60} />);
    expect(screen.getByText('2 天 3 小时 5 分钟后重置')).toBeTruthy();
  });

  it('waits for provider data after the reset without fabricating a full balance', () => {
    render(<QuotaWindow label="5 小时额度" remainingPercent={0} resetsAt={NOW / 1000 + 30} />);
    expect(screen.getByText('不到 1 分钟后重置')).toBeTruthy();
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('0');
    act(() => vi.advanceTimersByTime(30000));
    expect(screen.getByText('已到重置时间，等待刷新')).toBeTruthy();
    expect(screen.getByText('0%')).toBeTruthy();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('handles a reset already in the past', () => {
    render(<QuotaWindow label="周额度" remainingPercent={12} resetsAt={NOW / 1000 - 1} />);
    expect(screen.getByText('已到重置时间，等待刷新')).toBeTruthy();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([null, NaN, Infinity, -1, 0, Number.MAX_VALUE])('keeps missing or invalid reset %s explicit', resetsAt => {
    const { container } = render(<QuotaWindow label="周额度" remainingPercent={null} resetsAt={resetsAt} />);
    expect(screen.getByText('重置时间暂未提供')).toBeTruthy();
    expect(screen.getByText('未返回')).toBeTruthy();
    expect(container.querySelector('time')).toBeNull();
    expect(screen.getByRole('progressbar').hasAttribute('aria-valuenow')).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([NaN, Infinity, -1, 101])('does not present invalid percentage %s as a real balance', remainingPercent => {
    render(<QuotaWindow label="周额度" remainingPercent={remainingPercent} resetsAt={null} />);
    expect(screen.getByText('未返回')).toBeTruthy();
    expect(screen.getByRole('progressbar').getAttribute('aria-valuetext')).toBe('额度未返回');
    expect(screen.getByRole('progressbar').hasAttribute('aria-valuenow')).toBe(false);
  });

  it('updates the time for a changed account and clears its timer on unmount', () => {
    const { rerender, unmount } = render(<QuotaWindow label="周额度" remainingPercent={93} resetsAt={NOW / 1000 + 86400} />);
    expect(vi.getTimerCount()).toBe(1);
    rerender(<QuotaWindow label="周额度" remainingPercent={50} resetsAt={NOW / 1000 + 3600} />);
    expect(screen.getByText('1 小时后重置')).toBeTruthy();
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
