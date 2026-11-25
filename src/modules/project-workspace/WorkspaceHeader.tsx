import { ChevronDown, ChevronLeft, ChevronRight, Download, ExternalLink, Languages, Loader2, RefreshCw, Rocket, Settings2, Shield, SlidersHorizontal, SquarePen, Zap } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';

import { formatThinkTranslateAccountLabel, useAgyFastStatus, useThinkTranslateConfig } from '@/modules/antigravity';

import type { AgentConnectionChoice, AppTab, LLMProvider, Project, ProjectSession } from '@/shared/types';
import { LLMProviderLogo } from '@/shared/ui';
import { cn } from '@/shared/utils';
import MobileMenuButton from '@/modules/project-workspace/MobileMenuButton';
import WorkspaceConnectionStatus from '@/modules/project-workspace/WorkspaceConnectionStatus';
import WorkspaceTabs from '@/modules/project-workspace/WorkspaceTabs';
import WorkspaceTitle from '@/modules/project-workspace/WorkspaceTitle';

function formatCompactAccountLabel(account: AgentConnectionChoice | null | undefined): string {
  if (!account) {
    return '账号管理';
  }
  const raw = (account.name || account.email || '').trim();
  if (!raw) {
    return '账号管理';
  }
  if (raw.includes('@')) {
    const localPart = raw.split('@')[0]?.trim();
    if (localPart) return localPart;
  }
  return raw;
}

type WorkspaceHeaderProps = {
  activeTab: AppTab;
  setActiveTab: Dispatch<SetStateAction<AppTab>>;
  selectedProject: Project;
  selectedSession: ProjectSession | null;
  shouldShowTasksTab: boolean;
  shouldShowBrowserTab: boolean;
  isMobile: boolean;
  onMenuClick: () => void;
  /** Opens the dedicated mobile Account & Quota sheet from the top-center pill. */
  onOpenMobileAccount?: () => void;
  mobileAccountOpen?: boolean;
  /** Active account choice shown in the mobile top-center account pill. */
  activeAccount?: AgentConnectionChoice | null;
  activeProvider?: LLMProvider;
  /** Opens the dedicated mobile Workspace & Tools sheet from the top-right button. */
  onOpenMobileControls?: () => void;
  mobileControlsOpen?: boolean;
  onStartNewSession?: () => void;
  /** Persists a new title for a session; resolves false when the backend refuses it. */
  onRenameSession: (sessionId: string, summary: string) => Promise<boolean>;
  agyUseClaude?: boolean;
  agyUseClaudeDisabled?: boolean;
  onToggleAgyUseClaude?: () => void;
  agyArmor?: boolean;
  onToggleAgyArmor?: () => void;
  agyTransam?: boolean;
  onToggleAgyTransam?: () => void;
  agyFast?: boolean;
  agyFastDisabled?: boolean;
  onToggleAgyFast?: () => void;
  agyThinkTranslate?: boolean;
  onToggleAgyThinkTranslate?: () => void;
};

/** Rendered by WorkspaceMain to show the workspace title and chat connection status alongside the scrollable tab bar. */
export default function WorkspaceHeader({
  activeTab,
  setActiveTab,
  selectedProject,
  selectedSession,
  shouldShowTasksTab,
  shouldShowBrowserTab,
  isMobile,
  onMenuClick,
  onOpenMobileAccount,
  mobileAccountOpen = false,
  activeAccount = null,
  activeProvider,
  onOpenMobileControls,
  mobileControlsOpen = false,
  onStartNewSession,
  onRenameSession,
  agyUseClaude = false,
  agyUseClaudeDisabled = false,
  onToggleAgyUseClaude,
  agyArmor = false,
  onToggleAgyArmor,
  agyTransam = false,
  onToggleAgyTransam,
  agyFast = false,
  agyFastDisabled = false,
  onToggleAgyFast,
  agyThinkTranslate = false,
  onToggleAgyThinkTranslate,
}: WorkspaceHeaderProps) {
  const { t } = useTranslation();
  const scrollRef = useRef<HTMLDivElement>(null);
  const agyFastMenuRef = useRef<HTMLDivElement>(null);
  const thinkTranslateMenuRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);
  const [agyFastMenuOpen, setAgyFastMenuOpen] = useState(false);
  const [thinkTranslateMenuOpen, setThinkTranslateMenuOpen] = useState(false);
  const agyFastPlugin = useAgyFastStatus(Boolean(onToggleAgyFast) && !isMobile);
  const thinkTranslateCfg = useThinkTranslateConfig(Boolean(onToggleAgyThinkTranslate) && !isMobile);
  const hasOverflow = canScrollLeft || canScrollRight;

  useEffect(() => {
    if (!agyFastMenuOpen && !thinkTranslateMenuOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (agyFastMenuOpen && agyFastMenuRef.current && !agyFastMenuRef.current.contains(event.target as Node)) {
        setAgyFastMenuOpen(false);
      }
      if (thinkTranslateMenuOpen && thinkTranslateMenuRef.current && !thinkTranslateMenuRef.current.contains(event.target as Node)) {
        setThinkTranslateMenuOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setAgyFastMenuOpen(false);
        setThinkTranslateMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [agyFastMenuOpen, thinkTranslateMenuOpen]);

  const updateScrollState = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setCanScrollLeft(el.scrollLeft > 2);
    setCanScrollRight(el.scrollLeft < el.scrollWidth - el.clientWidth - 2);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    updateScrollState();

    const observer = new ResizeObserver(updateScrollState);
    observer.observe(el);
    if (el.firstElementChild) observer.observe(el.firstElementChild);

    return () => observer.disconnect();
  }, [updateScrollState]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const handleWheel = (event: WheelEvent) => {
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;

      const maxScrollLeft = el.scrollWidth - el.clientWidth;
      const canMove = event.deltaY < 0 ? el.scrollLeft > 0 : el.scrollLeft < maxScrollLeft;
      if (!canMove) return;

      event.preventDefault();
      const lineMultiplier = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 20 : 1;
      el.scrollBy({ left: event.deltaY * lineMultiplier, behavior: 'auto' });
    };

    el.addEventListener('wheel', handleWheel, { passive: false });
    return () => el.removeEventListener('wheel', handleWheel);
  }, []);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const activeTabElement = scrollRef.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
      activeTabElement?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
      updateScrollState();
    });

    return () => window.cancelAnimationFrame(frame);
  }, [activeTab, updateScrollState]);

  const scrollTabs = (direction: -1 | 1) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollBy({ left: direction * Math.max(180, el.clientWidth * 0.65), behavior: 'smooth' });
  };

  if (isMobile) {
    const isFloatingChatHeader = activeTab === 'chat';
    const hasActiveAgyClaude = Boolean(onToggleAgyUseClaude && agyUseClaude && !agyUseClaudeDisabled);
    const hasActiveAgyArmor = Boolean(onToggleAgyArmor && agyArmor);
    const hasActiveAgyTransam = Boolean(onToggleAgyTransam && agyTransam);
    const hasActiveAgyFast = Boolean(onToggleAgyFast && agyFast);
    const hasActiveAgyThinkTranslate = Boolean(onToggleAgyThinkTranslate && agyThinkTranslate);
    const showAccountPill = isFloatingChatHeader && Boolean(onOpenMobileAccount);
    const pillProvider = activeAccount?.provider ?? selectedSession?.__provider ?? activeProvider;
    const accountLabel = formatCompactAccountLabel(activeAccount);

    return (
      <header
        className={cn(
          'z-20 flex-shrink-0 px-3 transition-colors',
          isFloatingChatHeader
            ? 'pointer-events-none absolute inset-x-0 top-0 bg-gradient-to-b from-background/95 via-background/75 to-transparent pb-3 pt-[max(0.625rem,env(safe-area-inset-top))]'
            : 'pwa-header-safe border-b border-border/50 bg-background/95 py-2 backdrop-blur-md',
        )}
      >
        <div className="flex h-10 min-w-0 items-center justify-between gap-2">
          {/* Left: Sidebar / conversation list trigger */}
          <MobileMenuButton
            onMenuClick={onMenuClick}
            className="pointer-events-auto flex h-9 w-9 items-center justify-center rounded-full border border-border/50 bg-background/80 p-0 text-foreground/80 shadow-sm backdrop-blur-md transition-all active:scale-95 hover:bg-accent/70 hover:text-foreground"
          />

          {/* Center: On chat tab, dedicated Account & Quota switcher pill; on other tabs, current view title */}
          {showAccountPill ? (
            <button
              type="button"
              onClick={onOpenMobileAccount}
              aria-expanded={mobileAccountOpen}
              aria-label="切换账号与查看额度"
              title={activeAccount ? `${activeAccount.name}${activeAccount.email && activeAccount.email !== activeAccount.name ? ` · ${activeAccount.email}` : ''}` : '账号与额度'}
              className={cn(
                'pointer-events-auto flex h-9 min-w-0 max-w-[calc(100%-7.5rem)] items-center gap-1.5 rounded-full border px-3 shadow-sm backdrop-blur-md transition-all active:scale-[0.98]',
                mobileAccountOpen
                  ? 'border-primary/40 bg-primary/10 text-primary'
                  : 'border-border/50 bg-background/80 text-foreground hover:bg-accent/60',
              )}
            >
              {pillProvider && (
                <LLMProviderLogo provider={pillProvider} className="h-3.5 w-3.5 shrink-0" />
              )}
              <span className="truncate text-[13px] font-semibold leading-tight">
                {accountLabel}
              </span>
              <WorkspaceConnectionStatus />
              <ChevronDown
                className={cn(
                  'h-3.5 w-3.5 shrink-0 text-muted-foreground/75 transition-transform duration-200',
                  mobileAccountOpen && 'rotate-180',
                )}
              />
            </button>
          ) : (
            <div
              role={onOpenMobileControls ? 'button' : undefined}
              tabIndex={onOpenMobileControls ? 0 : undefined}
              aria-expanded={onOpenMobileControls ? mobileControlsOpen : undefined}
              aria-label={onOpenMobileControls ? '切换工作区视图' : undefined}
              onClick={(event) => {
                if (!onOpenMobileControls) return;
                if ((event.target as HTMLElement).closest('input')) return;
                onOpenMobileControls();
              }}
              onKeyDown={(event) => {
                if (!onOpenMobileControls) return;
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onOpenMobileControls();
                }
              }}
              className={cn(
                'pointer-events-auto flex h-9 min-w-0 max-w-[calc(100%-7.5rem)] items-center gap-1.5 rounded-full border border-border/50 bg-background/80 px-3 shadow-sm backdrop-blur-md transition-all',
                onOpenMobileControls && 'cursor-pointer active:scale-[0.98] hover:bg-accent/60',
              )}
            >
              <WorkspaceTitle
                activeTab={activeTab}
                selectedProject={selectedProject}
                selectedSession={selectedSession}
                shouldShowTasksTab={shouldShowTasksTab}
                compact
                onRenameSession={onRenameSession}
              />
              <WorkspaceConnectionStatus />
              {onOpenMobileControls && (
                <ChevronDown
                  className={cn(
                    'h-3.5 w-3.5 shrink-0 text-muted-foreground/75 transition-transform duration-200',
                    mobileControlsOpen && 'rotate-180',
                  )}
                />
              )}
            </div>
          )}

          {/* Right: New Chat + Workspace & Tools Menu trigger */}
          <div className="pointer-events-auto flex shrink-0 items-center gap-1.5">
            {onStartNewSession && (
              <button
                type="button"
                onClick={() => {
                  setActiveTab('chat');
                  onStartNewSession();
                }}
                aria-label={t('mainContent.newSession', { defaultValue: '新对话' })}
                title={t('mainContent.newSession', { defaultValue: '新对话' })}
                className="flex h-9 w-9 items-center justify-center rounded-full border border-border/50 bg-background/80 text-foreground/80 shadow-sm backdrop-blur-md transition-all active:scale-95 hover:bg-accent/70 hover:text-foreground"
              >
                <SquarePen className="h-4 w-4" />
              </button>
            )}

            {onOpenMobileControls && (
              <button
                type="button"
                onClick={onOpenMobileControls}
                aria-expanded={mobileControlsOpen}
                aria-label="打开控制菜单"
                title="工作区视图、节点与监控菜单"
                className={cn(
                  'relative flex h-9 w-9 items-center justify-center rounded-full border shadow-sm backdrop-blur-md transition-all active:scale-95',
                  mobileControlsOpen
                    ? 'border-primary/40 bg-primary/10 text-primary'
                    : 'border-border/50 bg-background/80 text-foreground/80 hover:bg-accent/70 hover:text-foreground',
                )}
              >
                <SlidersHorizontal className="h-4 w-4" />
                {(hasActiveAgyArmor || hasActiveAgyTransam || hasActiveAgyFast || hasActiveAgyThinkTranslate || hasActiveAgyClaude) && (
                  <span
                    aria-hidden="true"
                    className="absolute right-1 top-1 flex items-center gap-0.5"
                  >
                    {hasActiveAgyArmor && (
                      <span className="h-2 w-2 rounded-full bg-amber-500 ring-2 ring-background" />
                    )}
                    {hasActiveAgyTransam && (
                      <span className="h-2 w-2 rounded-full bg-rose-500 ring-2 ring-background" />
                    )}
                    {hasActiveAgyFast && (
                      <span className="h-2 w-2 rounded-full bg-sky-500 ring-2 ring-background" />
                    )}
                    {hasActiveAgyThinkTranslate && (
                      <span className="h-2 w-2 rounded-full bg-violet-500 ring-2 ring-background" />
                    )}
                    {hasActiveAgyClaude && (
                      <span className="h-2 w-2 rounded-full bg-emerald-500 ring-2 ring-background" />
                    )}
                  </span>
                )}
              </button>
            )}
          </div>
        </div>
      </header>
    );
  }

  return (
    <header className="pwa-header-safe flex-shrink-0 border-b border-border/60 bg-background/95 px-3 py-1.5 backdrop-blur-sm sm:px-4 sm:py-2">
      <div className="flex min-w-0 flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-3">
        <div className="flex min-w-0 items-center gap-2 sm:max-w-[min(34%,24rem)] sm:flex-[1_1_18rem]">
          {isMobile && <MobileMenuButton onMenuClick={onMenuClick} />}
          <WorkspaceTitle
            activeTab={activeTab}
            selectedProject={selectedProject}
            selectedSession={selectedSession}
            shouldShowTasksTab={shouldShowTasksTab}
            onRenameSession={onRenameSession}
          />
          <WorkspaceConnectionStatus />
        </div>

        <div className="-mx-3 flex min-w-0 items-center justify-end gap-2 sm:mx-0 sm:flex-1">
          <div className="relative ml-auto w-fit max-w-full min-w-0">
            {canScrollLeft && (
              <div className="pointer-events-none absolute inset-y-0 left-0 z-10 w-12 bg-gradient-to-r from-background via-background/90 to-transparent" />
            )}
            <div
              ref={scrollRef}
              onScroll={updateScrollState}
              className={cn(
                'scrollbar-hide max-w-full scroll-smooth overflow-x-auto overscroll-x-contain px-3 [-webkit-overflow-scrolling:touch]',
                hasOverflow ? 'sm:px-9' : 'sm:pl-3 sm:pr-0',
              )}
            >
              <WorkspaceTabs
                activeTab={activeTab}
                setActiveTab={setActiveTab}
                shouldShowTasksTab={shouldShowTasksTab}
                shouldShowBrowserTab={shouldShowBrowserTab}
              />
            </div>
            {canScrollRight && (
              <div className="pointer-events-none absolute inset-y-0 right-0 z-10 w-12 bg-gradient-to-l from-background via-background/90 to-transparent" />
            )}

            {canScrollLeft && (
              <button
                type="button"
                onClick={() => scrollTabs(-1)}
                aria-label={t('navigation.scrollTabsLeft', { defaultValue: 'Scroll tabs left' })}
                className="absolute left-1 top-1/2 z-20 hidden h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md border border-border/70 bg-background/95 text-muted-foreground shadow-sm outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/60 sm:flex"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
            )}
            {canScrollRight && (
              <button
                type="button"
                onClick={() => scrollTabs(1)}
                aria-label={t('navigation.scrollTabsRight', { defaultValue: 'Scroll tabs right' })}
                className="absolute right-1 top-1/2 z-20 hidden h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md border border-border/70 bg-background/95 text-muted-foreground shadow-sm outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/60 sm:flex"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            )}
          </div>

          {onToggleAgyArmor && (
            <button
              type="button"
              role="switch"
              aria-checked={agyArmor}
              aria-label="切换 Antigravity Armor 破甲"
              title={
                agyArmor
                  ? agyUseClaudeDisabled
                    ? '已开启：Antigravity Armor 破甲（第三方 API 模式生效出站软化与交付契约；登录原生 agy 账号可启用流式拒答重发）'
                    : '已开启：Antigravity Armor 破甲（六层破甲/防过滤/防拒绝/强制交付）'
                  : '已关闭：点击开启 Antigravity Armor 破甲增强'
              }
              onClick={onToggleAgyArmor}
              className={cn(
                'mr-2 inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-primary/60',
                agyArmor
                  ? 'border-amber-500/50 bg-amber-500/15 text-amber-600 hover:bg-amber-500/20 dark:text-amber-400'
                  : 'border-border/70 bg-muted/40 text-muted-foreground hover:bg-accent hover:text-foreground',
              )}
            >
              <Shield className={cn('h-3.5 w-3.5', agyArmor ? 'text-amber-500' : 'text-muted-foreground')} />
              <span>Armor 破甲</span>
            </button>
          )}

          {onToggleAgyTransam && (
            <button
              type="button"
              role="switch"
              aria-checked={agyTransam}
              aria-label="切换 TRANS-AM 叙事引擎"
              title={
                agyTransam
                  ? '已开启：TRANS-AM 叙事引擎（按模型自动匹配 4A v1.2.4 / 4H v1.1.4 / 4N v1.0.1 预设 + D100×4 判定池 + 上下文净化）'
                  : '已关闭：点击开启 TRANS-AM 叙事引擎（4A / 4H / 4N）'
              }
              onClick={onToggleAgyTransam}
              className={cn(
                'mr-2 inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-primary/60',
                agyTransam
                  ? 'border-rose-500/50 bg-rose-500/15 text-rose-600 hover:bg-rose-500/20 dark:text-rose-400'
                  : 'border-border/70 bg-muted/40 text-muted-foreground hover:bg-accent hover:text-foreground',
              )}
            >
              <Zap className={cn('h-3.5 w-3.5', agyTransam ? 'text-rose-500' : 'text-muted-foreground')} />
              <span>TRANS-AM</span>
            </button>
          )}

          {onToggleAgyFast && (
            <div ref={agyFastMenuRef} className="relative mr-2 inline-flex shrink-0 items-center">
              <button
                type="button"
                role="switch"
                aria-checked={agyFast && !agyFastDisabled}
                aria-label="切换 agy-fast 加速插件"
                disabled={agyFastDisabled}
                title={
                  agyFastDisabled
                    ? '第三方 API 连接不支持挂载 agy-fast MCP 工具（需要已登录的原生 agy 账号）'
                    : agyFast
                      ? `已开启：agy-fast 加速插件${agyFastPlugin.status?.installed_version ? ` (v${agyFastPlugin.status.installed_version})` : ''}（批量搜索 / 多文件原子编辑 / 符号大纲 / 并发检查 + 启动快照）`
                      : '已关闭：点击开启 agy-fast 加速插件（MCP 批量工具 + 启动快照）'
                }
                onClick={onToggleAgyFast}
                className={cn(
                  'inline-flex h-8 items-center gap-1.5 rounded-l-full border border-r-0 px-2.5 text-xs font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-primary/60 disabled:cursor-not-allowed disabled:opacity-45',
                  agyFast && !agyFastDisabled
                    ? 'border-sky-500/50 bg-sky-500/15 text-sky-600 hover:bg-sky-500/20 dark:text-sky-400'
                    : 'border-border/70 bg-muted/40 text-muted-foreground hover:bg-accent hover:text-foreground',
                )}
              >
                <Rocket className={cn('h-3.5 w-3.5', agyFast && !agyFastDisabled ? 'text-sky-500' : 'text-muted-foreground')} />
                <span>agy-fast</span>
              </button>
              <button
                type="button"
                aria-label="agy-fast 插件更新与设置"
                aria-expanded={agyFastMenuOpen}
                title="检查 GitHub 更新、自动更新适配与插件状态"
                onClick={() => {
                  setAgyFastMenuOpen((open) => {
                    const next = !open;
                    if (next) void agyFastPlugin.refresh();
                    return next;
                  });
                }}
                className={cn(
                  'relative inline-flex h-8 items-center justify-center rounded-r-full border px-2 text-xs transition-colors outline-none focus-visible:ring-2 focus-visible:ring-primary/60',
                  agyFast && !agyFastDisabled
                    ? 'border-sky-500/50 bg-sky-500/15 text-sky-600 hover:bg-sky-500/25 dark:text-sky-400'
                    : 'border-border/70 bg-muted/40 text-muted-foreground hover:bg-accent hover:text-foreground',
                )}
              >
                <RefreshCw className={cn('h-3 w-3', (agyFastPlugin.checking || agyFastPlugin.updating) && 'animate-spin')} />
                {agyFastPlugin.status?.update_available && (
                  <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-sky-500" />
                )}
              </button>
              {agyFastMenuOpen && (
                <div className="absolute right-0 top-10 z-50 w-72 rounded-xl border border-border bg-popover p-3 text-xs text-popover-foreground shadow-lg">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5 font-semibold">
                      <Rocket className="h-3.5 w-3.5 text-sky-500" />
                      <span>agy-fast 插件</span>
                      {agyFastPlugin.status?.installed_version && (
                        <span className="rounded bg-sky-500/15 px-1.5 py-0.5 font-mono text-[10px] text-sky-600 dark:text-sky-400">
                          v{agyFastPlugin.status.installed_version}
                        </span>
                      )}
                    </div>
                    <a
                      href={agyFastPlugin.status?.repo_url || 'https://github.com/INK-Q/agy-fast'}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-0.5 text-[11px] text-muted-foreground hover:text-foreground"
                    >
                      GitHub <ExternalLink className="h-3 w-3" />
                    </a>
                  </div>
                  {agyFastPlugin.status?.adapted_tools?.length ? (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {agyFastPlugin.status.adapted_tools.map((tool) => (
                        <span key={tool} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                          {tool}
                        </span>
                      ))}
                    </div>
                  ) : null}
                  <div className="mt-2.5 flex items-center justify-between gap-2 border-t border-border/60 pt-2">
                    <span className="text-[11px] text-muted-foreground">定时自动检查并更新适配</span>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={agyFastPlugin.status?.auto_update_enabled ?? true}
                      onClick={() => void agyFastPlugin.toggleAutoUpdate()}
                      className={cn(
                        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors',
                        (agyFastPlugin.status?.auto_update_enabled ?? true) ? 'bg-sky-500' : 'bg-muted-foreground/30',
                      )}
                    >
                      <span
                        className={cn(
                          'inline-block h-4 w-4 rounded-full bg-white shadow-sm transition-transform',
                          (agyFastPlugin.status?.auto_update_enabled ?? true) ? 'translate-x-4' : 'translate-x-0.5',
                        )}
                      />
                    </button>
                  </div>
                  <div className="mt-2.5 flex items-center gap-1.5">
                    <button
                      type="button"
                      disabled={agyFastPlugin.checking || agyFastPlugin.updating}
                      onClick={() => void agyFastPlugin.checkUpdate()}
                      className="inline-flex flex-1 items-center justify-center gap-1 rounded-lg border border-border bg-background px-2 py-1.5 text-[11px] font-medium hover:bg-accent disabled:opacity-50"
                    >
                      {agyFastPlugin.checking ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                      检查更新
                    </button>
                    <button
                      type="button"
                      disabled={agyFastPlugin.checking || agyFastPlugin.updating}
                      onClick={() => void agyFastPlugin.runUpdate(false)}
                      className="inline-flex flex-1 items-center justify-center gap-1 rounded-lg bg-sky-500 px-2 py-1.5 text-[11px] font-medium text-white hover:bg-sky-600 disabled:opacity-50"
                    >
                      {agyFastPlugin.updating ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
                      {agyFastPlugin.status?.update_available ? '更新并适配' : '同步适配'}
                    </button>
                  </div>
                  {agyFastPlugin.message && (
                    <p className="mt-2 text-[11px] text-emerald-600 dark:text-emerald-400">{agyFastPlugin.message}</p>
                  )}
                  {(agyFastPlugin.error || agyFastPlugin.status?.last_error) && (
                    <p className="mt-2 text-[11px] text-red-600 dark:text-red-400">
                      {agyFastPlugin.error || agyFastPlugin.status?.last_error}
                    </p>
                  )}
                </div>
              )}
            </div>
          )}

          {onToggleAgyThinkTranslate && (
            <div ref={thinkTranslateMenuRef} className="relative mr-2 inline-flex shrink-0 items-center">
              <button
                type="button"
                role="switch"
                aria-checked={agyThinkTranslate}
                aria-label="切换思考自动翻译"
                title={
                  agyThinkTranslate
                    ? '已开启：自动翻译思考内容（关闭时仍可点击每条思考旁的「翻译」按钮手动翻译）'
                    : '已关闭：点击开启自动翻译思考内容（未开启时也可点击思考旁的「翻译」按钮手动翻译）'
                }
                onClick={onToggleAgyThinkTranslate}
                className={cn(
                  'inline-flex h-8 items-center gap-1.5 rounded-l-full border border-r-0 px-2.5 text-xs font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-primary/60',
                  agyThinkTranslate
                    ? 'border-violet-500/50 bg-violet-500/15 text-violet-600 hover:bg-violet-500/20 dark:text-violet-400'
                    : 'border-border/70 bg-muted/40 text-muted-foreground hover:bg-accent hover:text-foreground',
                )}
              >
                <Languages className={cn('h-3.5 w-3.5', agyThinkTranslate ? 'text-violet-500' : 'text-muted-foreground')} />
                <span>思考翻译</span>
              </button>
              <button
                type="button"
                aria-label="配置思考翻译账号与模型"
                aria-expanded={thinkTranslateMenuOpen}
                title="选择固定用于思考翻译的账号和模型"
                onClick={() => {
                  setThinkTranslateMenuOpen((open) => {
                    const next = !open;
                    if (next) void thinkTranslateCfg.refresh();
                    return next;
                  });
                }}
                className={cn(
                  'inline-flex h-8 items-center justify-center rounded-r-full border px-2 text-xs transition-colors outline-none focus-visible:ring-2 focus-visible:ring-primary/60',
                  agyThinkTranslate
                    ? 'border-violet-500/50 bg-violet-500/15 text-violet-600 hover:bg-violet-500/25 dark:text-violet-400'
                    : 'border-border/70 bg-muted/40 text-muted-foreground hover:bg-accent hover:text-foreground',
                )}
              >
                <Settings2 className="h-3 w-3" />
              </button>
              {thinkTranslateMenuOpen && (
                <div className="absolute right-0 top-10 z-50 w-72 rounded-xl border border-border bg-popover p-3 text-xs text-popover-foreground shadow-lg">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5 font-semibold">
                      <Languages className="h-3.5 w-3.5 text-violet-500" />
                      <span>思考翻译设置</span>
                    </div>
                    <button
                      type="button"
                      disabled={thinkTranslateCfg.loading}
                      onClick={() => void thinkTranslateCfg.refresh()}
                      className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-50"
                    >
                      <RefreshCw className={cn('h-3 w-3', thinkTranslateCfg.loading && 'animate-spin')} />
                      刷新
                    </button>
                  </div>
                  <p className="mt-1.5 text-[11px] text-muted-foreground">
                    选定账号与模型后，自动翻译和手动点击「翻译」都将固定使用该账号的模型。
                  </p>
                  <div className="mt-2.5 space-y-2">
                    <label className="block space-y-1">
                      <span className="text-[11px] font-medium text-muted-foreground">翻译账号</span>
                      <select
                        value={thinkTranslateCfg.config.account_id}
                        disabled={thinkTranslateCfg.saving}
                        onChange={(e) => void thinkTranslateCfg.saveConfig({ account_id: e.target.value })}
                        className="w-full rounded-lg border border-border bg-background px-2 py-1.5 text-xs text-foreground outline-none focus:border-violet-500"
                      >
                        <option value="">跟随当前活跃账号</option>
                        {thinkTranslateCfg.accounts.map((acc) => (
                          <option key={acc.id} value={acc.id}>
                            {formatThinkTranslateAccountLabel(acc)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="block space-y-1">
                      <span className="text-[11px] font-medium text-muted-foreground">
                        翻译模型{thinkTranslateCfg.saving || thinkTranslateCfg.loading ? '（加载中…）' : ''}
                      </span>
                      <select
                        value={thinkTranslateCfg.config.model}
                        disabled={thinkTranslateCfg.saving || thinkTranslateCfg.loading}
                        onChange={(e) => void thinkTranslateCfg.saveConfig({ model: e.target.value })}
                        className="w-full rounded-lg border border-border bg-background px-2 py-1.5 text-xs text-foreground outline-none focus:border-violet-500 disabled:opacity-60"
                      >
                        <option value="">默认模型</option>
                        {thinkTranslateCfg.models.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.name || m.id}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  {thinkTranslateCfg.message && (
                    <p className="mt-2 text-[11px] text-emerald-600 dark:text-emerald-400">{thinkTranslateCfg.message}</p>
                  )}
                  {thinkTranslateCfg.error && (
                    <p className="mt-2 text-[11px] text-red-600 dark:text-red-400">{thinkTranslateCfg.error}</p>
                  )}
                </div>
              )}
            </div>
          )}

          {onToggleAgyUseClaude && (
            <button
              type="button"
              role="switch"
              aria-checked={agyUseClaude && !agyUseClaudeDisabled}
              aria-label="切换 Claude Code → agy"
              disabled={agyUseClaudeDisabled}
              title={agyUseClaudeDisabled
                ? '第三方 API 连接不支持 Claude → agy 模式（需要已登录的 agy 账号）'
                : agyUseClaude
                  ? '已开启：Claude Code 执行工具，agy 提供模型（用于 agy 聊天）'
                  : '已关闭：agy 聊天使用原有执行方式'}
              onClick={onToggleAgyUseClaude}
              className={cn(
                'mr-3 inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-primary/60 sm:mr-0',
                agyUseClaudeDisabled
                  ? 'cursor-not-allowed border-border/50 bg-muted/30 text-muted-foreground/60 opacity-60'
                  : agyUseClaude
                    ? 'border-emerald-500/50 bg-emerald-500/15 text-emerald-600 hover:bg-emerald-500/20 dark:text-emerald-400'
                    : 'border-border/70 bg-muted/40 text-muted-foreground hover:bg-accent hover:text-foreground',
              )}
            >
              <span
                className={cn(
                  'h-2 w-2 rounded-full transition-colors',
                  agyUseClaude && !agyUseClaudeDisabled ? 'bg-emerald-500' : 'bg-muted-foreground/45',
                )}
              />
              <span>Claude → agy</span>
            </button>
          )}
        </div>
      </div>
    </header>
  );
}
