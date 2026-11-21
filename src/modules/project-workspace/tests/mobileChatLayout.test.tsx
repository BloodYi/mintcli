import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import '@/modules/i18n';
import { ScheduleMessagePopover } from '@/modules/chat/composer/ScheduleMessagePopover';
import MobileAccountSheet from '@/modules/project-workspace/MobileAccountSheet';
import MobileWorkspaceSheet from '@/modules/project-workspace/MobileWorkspaceSheet';
import WorkspaceHeader from '@/modules/project-workspace/WorkspaceHeader';
import type { AgentConnectionChoice, Project, ProjectSession } from '@/shared/types';

vi.mock('@/shared/context/WebSocketContext', () => ({
  useWebSocket: () => ({ connectionStatus: 'connected' }),
}));

vi.mock('@/modules/plugins', () => ({
  usePlugins: () => ({
    plugins: [
      {
        name: 'github',
        displayName: 'GitHub · PR 与议题',
        enabled: true,
        icon: 'icon.svg',
      },
      {
        name: 'token-monitor',
        displayName: 'Token Monitor · 真实返回与用量',
        enabled: true,
        icon: 'Activity',
      },
    ],
  }),
  PluginIcon: ({ pluginName }: { pluginName: string }) => <span data-testid={`plugin-icon-${pluginName}`} />,
}));

const project: Project = {
  projectId: 'p1',
  displayName: 'mintcli',
  fullPath: '/work/mintcli',
  path: '/work/mintcli',
};

const session: ProjectSession = {
  id: 'session-1',
  summary: '移动端聊天体验优化',
  __provider: 'antigravity',
};

const activeAccount: AgentConnectionChoice = {
  id: 'antigravity:a',
  accountId: 'a',
  provider: 'antigravity',
  kind: 'antigravity',
  name: 'july9577qi@gmail.com',
  email: 'july9577qi@gmail.com',
  current: true,
  authorized: true,
};

afterEach(cleanup);

describe('Mobile chat floating header, separate sheets, and popover viewport clamping', () => {
  it('separates top-center account switcher pill from top-right workspace & tools menu', () => {
    const onOpenMobileAccount = vi.fn();
    const onOpenMobileControls = vi.fn();
    const onStartNewSession = vi.fn();

    render(
      <WorkspaceHeader
        activeTab="chat"
        setActiveTab={vi.fn()}
        selectedProject={project}
        selectedSession={session}
        shouldShowTasksTab={false}
        shouldShowBrowserTab={false}
        isMobile={true}
        onMenuClick={vi.fn()}
        onOpenMobileAccount={onOpenMobileAccount}
        mobileAccountOpen={false}
        activeAccount={activeAccount}
        activeProvider="antigravity"
        onOpenMobileControls={onOpenMobileControls}
        mobileControlsOpen={false}
        onStartNewSession={onStartNewSession}
        onRenameSession={vi.fn(async () => true)}
        agyUseClaude={true}
        onToggleAgyUseClaude={vi.fn()}
      />,
    );

    const header = document.querySelector('header');
    expect(header).not.toBeNull();
    expect(header?.className).toContain('absolute');
    // Connection live region stays mounted inside <header>.
    expect(document.querySelector('header [role="status"][aria-live="polite"]')).not.toBeNull();
    // Desktop tablist is folded out of the top header on mobile.
    expect(screen.queryByRole('tablist')).toBeNull();

    // Top-center pill displays the active account short name and opens the dedicated Account sheet.
    const accountPill = screen.getByRole('button', { name: '切换账号与查看额度' });
    expect(accountPill.textContent).toContain('july9577qi');
    fireEvent.click(accountPill);
    expect(onOpenMobileAccount).toHaveBeenCalledTimes(1);
    expect(onOpenMobileControls).not.toHaveBeenCalled();

    // Top-right button opens the separate Workspace & Tools sheet.
    fireEvent.click(screen.getByRole('button', { name: '打开控制菜单' }));
    expect(onOpenMobileControls).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: /New Session|新对话/i }));
    expect(onStartNewSession).toHaveBeenCalledTimes(1);
  });

  it('mounts dedicated account slot inside MobileAccountSheet', () => {
    const onAccountSlotChange = vi.fn();
    render(
      <MobileAccountSheet
        open={true}
        onOpenChange={vi.fn()}
        onAccountSlotChange={onAccountSlotChange}
      />,
    );

    expect(screen.getByRole('heading', { name: '账号与额度' })).toBeTruthy();
    expect(onAccountSlotChange).toHaveBeenCalledWith(expect.any(HTMLDivElement));
  });

  it('keeps MobileWorkspaceSheet focused on views, mode switch, tools slot, and quick actions', () => {
    const setActiveTab = vi.fn();
    const onOpenChange = vi.fn();
    const onToggleAgyUseClaude = vi.fn();
    const onToolsSlotChange = vi.fn();

    render(
      <MobileWorkspaceSheet
        open={true}
        onOpenChange={onOpenChange}
        activeTab="chat"
        setActiveTab={setActiveTab}
        selectedProject={project}
        selectedSession={session}
        shouldShowTasksTab={false}
        shouldShowBrowserTab={false}
        agyUseClaude={false}
        onToggleAgyUseClaude={onToggleAgyUseClaude}
        onStartNewSession={vi.fn()}
        onShowSettings={vi.fn()}
        onOpenQuickSettings={vi.fn()}
        onToolsSlotChange={onToolsSlotChange}
        onExportSlotChange={vi.fn()}
      />,
    );

    // Compact plugin labels avoid awkward truncation on mobile tiles.
    const tabs = screen.getAllByRole('tab');
    expect(tabs.length).toBe(6);
    expect(screen.getByText('GitHub')).toBeTruthy();
    expect(screen.getByText('Token Monitor')).toBeTruthy();

    // Claude -> agy switch works.
    const claudeAgySwitch = screen.getByRole('switch', { name: '切换 Claude Code → agy' });
    fireEvent.click(claudeAgySwitch);
    expect(onToggleAgyUseClaude).toHaveBeenCalledTimes(1);

    // Dedicated tools slot receives a mounted DOM element (for 代理节点 & 监控窗口).
    expect(onToolsSlotChange).toHaveBeenCalledWith(expect.any(HTMLDivElement));

    // Clicking a view switches tab and closes the sheet.
    fireEvent.click(tabs[2]);
    expect(setActiveTab).toHaveBeenCalledWith('files');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('clamps ScheduleMessagePopover inside a narrow mobile viewport without left-edge clipping', () => {
    const originalWidth = window.innerWidth;
    const originalHeight = window.innerHeight;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 360 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 780 });

    try {
      render(<ScheduleMessagePopover disabled={false} onSchedule={vi.fn()} />);
      const trigger = screen.getByRole('button');
      vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({
        top: 710,
        bottom: 742,
        left: 113,
        right: 145,
        width: 32,
        height: 32,
        x: 113,
        y: 710,
        toJSON: () => ({}),
      });

      fireEvent.click(trigger);
      const menu = screen.getByRole('menu');
      const right = Number.parseFloat(menu.style.right);
      const maxWidth = Number.parseFloat(menu.style.maxWidth);

      expect(right).toBeGreaterThanOrEqual(8);
      expect(maxWidth).toBeLessThanOrEqual(360 - 16);
      // Left edge when rendered at full maxWidth must remain at least 8px inside the viewport.
      expect(360 - right - maxWidth).toBeGreaterThanOrEqual(8);
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalWidth });
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: originalHeight });
    }
  });
});
