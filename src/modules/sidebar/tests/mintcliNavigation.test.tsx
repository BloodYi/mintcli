import { cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { TFunction } from 'i18next';
import SidebarFooter from '@/modules/sidebar/SidebarFooter';
import SidebarCollapsed from '@/modules/sidebar/SidebarCollapsed';
import { useVersionCheck } from '@/shared/hooks/useVersionCheck';

const t = ((key: string) => key) as TFunction;
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it('mintcli does not render community, issue or upstream update links even if stale props offer an update', () => {
  const common = { updateAvailable: true, restartRequired: false, onShowVersionModal: vi.fn(), onShowSettings: vi.fn(), t };
  const { container } = render(<><SidebarFooter {...common} currentVersion="1.0.0" latestVersion="99.0.0" releaseInfo={null} /><SidebarCollapsed {...common} onExpand={vi.fn()} /></>);
  expect(container.querySelectorAll('a')).toHaveLength(0);
  expect(screen.getByText('mintcli v1.0.0')).toBeTruthy();
  expect(screen.queryByText('actions.reportIssue')).toBeNull();
  expect(screen.queryByText('actions.joinCommunity')).toBeNull();
});
it('version checks read local health and never request upstream releases', async () => {
  const fetcher = vi.fn(async () => Response.json({ version: '0.0.0-test', installMode: 'git' }));
  vi.stubGlobal('fetch', fetcher);
  const { result } = renderHook(() => useVersionCheck());
  await waitFor(() => expect(fetcher).toHaveBeenCalledWith('/health'));
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(result.current.updateAvailable).toBe(false);
  expect(result.current.latestVersion).toBeNull();
});
