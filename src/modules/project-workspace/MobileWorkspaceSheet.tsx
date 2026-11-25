import {
  ClipboardCheck,
  Download,
  Folder,
  GitBranch,
  Languages,
  Loader2,
  MessageSquare,
  MonitorPlay,
  RefreshCw,
  Rocket,
  Settings,
  Shield,
  SlidersHorizontal,
  SquarePen,
  Terminal,
  X,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import type { Dispatch, SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';

import { formatThinkTranslateAccountLabel, useAgyFastStatus, useThinkTranslateConfig } from '@/modules/antigravity';

import { PluginIcon, usePlugins } from '@/modules/plugins';
import type { AppTab, Project, ProjectSession, SettingsMainTab } from '@/shared/types';
import { Dialog, DialogContent, DialogTitle } from '@/shared/ui';
import { cn, getSessionTitle } from '@/shared/utils';

type BuiltInTab = {
  kind: 'builtin';
  id: AppTab;
  labelKey: string;
  icon: LucideIcon;
};

type PluginTab = {
  kind: 'plugin';
  id: AppTab;
  label: string;
  compactLabel: string;
  pluginName: string;
  iconFile: string;
};

type TabItem = BuiltInTab | PluginTab;

const BASE_TABS: BuiltInTab[] = [
  { kind: 'builtin', id: 'chat', labelKey: 'tabs.chat', icon: MessageSquare },
  { kind: 'builtin', id: 'shell', labelKey: 'tabs.shell', icon: Terminal },
  { kind: 'builtin', id: 'files', labelKey: 'tabs.files', icon: Folder },
  { kind: 'builtin', id: 'git', labelKey: 'tabs.git', icon: GitBranch },
];

const BROWSER_TAB: BuiltInTab = {
  kind: 'builtin',
  id: 'browser',
  labelKey: 'tabs.browser',
  icon: MonitorPlay,
};

const TASKS_TAB: BuiltInTab = {
  kind: 'builtin',
  id: 'tasks',
  labelKey: 'tabs.tasks',
  icon: ClipboardCheck,
};

function compactPluginLabel(displayName: string): string {
  const short = displayName.split(/\s*[·•|—-]\s*/)[0]?.trim();
  return short || displayName;
}

type MobileWorkspaceSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  activeTab: AppTab;
  setActiveTab: Dispatch<SetStateAction<AppTab>>;
  selectedProject: Project;
  selectedSession: ProjectSession | null;
  shouldShowTasksTab: boolean;
  shouldShowBrowserTab: boolean;
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
  onStartNewSession?: () => void;
  onShowSettings?: (tab?: SettingsMainTab) => void;
  onOpenQuickSettings?: () => void;
  onToolsSlotChange: (node: HTMLDivElement | null) => void;
  onExportSlotChange: (node: HTMLDivElement | null) => void;
};

/**
 * Dedicated mobile bottom sheet opened from the top-right menu button.
 * Holds workspace view switching, Claude -> agy mode, network/monitor tools
 * (代理节点 & 监控窗口) and quick actions — kept separate from Account & Quota.
 */
export default function MobileWorkspaceSheet({
  open,
  onOpenChange,
  activeTab,
  setActiveTab,
  selectedProject,
  selectedSession,
  shouldShowTasksTab,
  shouldShowBrowserTab,
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
  onStartNewSession,
  onShowSettings,
  onOpenQuickSettings,
  onToolsSlotChange,
  onExportSlotChange,
}: MobileWorkspaceSheetProps) {
  const { t } = useTranslation();
  const { plugins } = usePlugins();
  const agyFastPlugin = useAgyFastStatus(Boolean(open && onToggleAgyFast));
  const thinkTranslateCfg = useThinkTranslateConfig(Boolean(open && onToggleAgyThinkTranslate), true);

  const builtInTabs: BuiltInTab[] = [
    ...BASE_TABS,
    ...(shouldShowBrowserTab ? [BROWSER_TAB] : []),
    ...(shouldShowTasksTab ? [TASKS_TAB] : []),
  ];

  const pluginTabs: PluginTab[] = plugins
    .filter((plugin) => plugin.enabled)
    .map((plugin) => ({
      kind: 'plugin',
      id: `plugin:${plugin.name}` as AppTab,
      label: plugin.displayName,
      compactLabel: compactPluginLabel(plugin.displayName),
      pluginName: plugin.name,
      iconFile: plugin.icon,
    }));

  const tabs: TabItem[] = [...builtInTabs, ...pluginTabs];
  const sessionTitle = selectedSession ? getSessionTitle(selectedSession) : t('mainContent.newSession');
  const gridColsClass = tabs.length <= 4 ? 'grid-cols-4' : 'grid-cols-3';

  const closeAndRun = (action?: () => void) => {
    onOpenChange(false);
    action?.();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        wrapperClassName="items-end p-0"
        animationClassName="animate-bottom-sheet-content-show"
        className="flex max-h-[84dvh] w-full max-w-none flex-col overflow-hidden rounded-b-none rounded-t-[26px] border-x-0 border-b-0 border-t border-border/70 bg-background/[0.98] p-0 shadow-2xl"
      >
        <DialogTitle className="sr-only">工作区与工具菜单</DialogTitle>

        {/* Tactile sheet drag indicator + session header */}
        <div className="flex-shrink-0 px-4 pb-3 pt-2.5">
          <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-muted-foreground/25" aria-hidden="true" />
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0 flex-1">
              <p className="truncate text-[15px] font-semibold tracking-tight text-foreground">
                {sessionTitle}
              </p>
              <p className="mt-0.5 truncate text-xs text-muted-foreground">
                {selectedProject.displayName}
              </p>
            </div>
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              aria-label={t('common:buttons.close', { defaultValue: '关闭' })}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted/70 text-muted-foreground transition-colors active:scale-95 hover:bg-muted hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Scrollable sheet sections */}
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain px-4 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
          {/* Section 1: Workspace views */}
          <section aria-label={t('tabs.views', { defaultValue: '工作区视图' })} className="space-y-2">
            <h3 className="px-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              {t('tabs.views', { defaultValue: '工作区视图' })}
            </h3>
            <div
              role="tablist"
              aria-label={t('tabs.views', { defaultValue: 'Workspace views' })}
              className={cn('grid gap-2', gridColsClass)}
            >
              {tabs.map((tab, index) => {
                const isActive = tab.id === activeTab;
                const fullLabel = tab.kind === 'builtin' ? t(tab.labelKey) : tab.label;
                const displayLabel = tab.kind === 'builtin' ? fullLabel : tab.compactLabel;

                return (
                  <button
                    key={`${tab.id}-${index}`}
                    type="button"
                    role="tab"
                    aria-selected={isActive}
                    title={fullLabel}
                    onClick={() => {
                      setActiveTab(tab.id);
                      onOpenChange(false);
                    }}
                    className={cn(
                      'flex flex-col items-center justify-center gap-1.5 rounded-2xl border px-2 py-2.5 text-center transition-all active:scale-[0.97]',
                      isActive
                        ? 'border-primary/35 bg-primary/10 text-primary shadow-sm'
                        : 'border-border/50 bg-muted/35 text-foreground/80 hover:bg-muted/60',
                    )}
                  >
                    {tab.kind === 'builtin' ? (
                      <tab.icon className="h-[18px] w-[18px] shrink-0" strokeWidth={isActive ? 2.2 : 1.75} />
                    ) : (
                      <PluginIcon
                        pluginName={tab.pluginName}
                        iconFile={tab.iconFile}
                        className="flex h-[18px] w-[18px] shrink-0 items-center justify-center [&>svg]:h-full [&>svg]:w-full"
                      />
                    )}
                    <span className="w-full truncate text-[11.5px] font-medium leading-tight">
                      {displayLabel}
                    </span>
                  </button>
                );
              })}
            </div>
          </section>

          {/* Section: Antigravity Armor mode switch */}
          {onToggleAgyArmor && (
            <section className="space-y-2">
              <button
                type="button"
                role="switch"
                aria-checked={agyArmor}
                aria-label="切换 Antigravity Armor 破甲"
                onClick={onToggleAgyArmor}
                className={cn(
                  'flex w-full items-center justify-between gap-3 rounded-2xl border px-3.5 py-3 text-left transition-colors',
                  agyArmor
                    ? 'border-amber-500/35 bg-amber-500/10'
                    : 'border-border/50 bg-muted/35 active:bg-muted/60',
                )}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <Shield className={cn('h-3.5 w-3.5 shrink-0', agyArmor ? 'text-amber-500' : 'text-muted-foreground')} />
                    <span className="text-[13px] font-semibold text-foreground">Armor 破甲增强</span>
                  </div>
                  <p className="mt-0.5 truncate text-[11.5px] text-muted-foreground">
                    {agyArmor
                      ? agyUseClaudeDisabled
                        ? '已开启：出站软化与交付契约生效（原生账号支持流式拒答重发）'
                        : '已开启：六层破甲/防过滤/防拒绝/强制交付'
                      : '已关闭：点击开启破甲增强'}
                  </p>
                </div>
                <span
                  aria-hidden="true"
                  className={cn(
                    'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors',
                    agyArmor ? 'bg-amber-500' : 'bg-muted-foreground/30',
                  )}
                >
                  <span
                    className={cn(
                      'inline-block h-5 w-5 rounded-full bg-white shadow-sm transition-transform',
                      agyArmor ? 'translate-x-5' : 'translate-x-0.5',
                    )}
                  />
                </span>
              </button>
            </section>
          )}

          {/* Section: TRANS-AM narrative engine switch */}
          {onToggleAgyTransam && (
            <section className="space-y-2">
              <button
                type="button"
                role="switch"
                aria-checked={agyTransam}
                aria-label="切换 TRANS-AM 叙事引擎"
                onClick={onToggleAgyTransam}
                className={cn(
                  'flex w-full items-center justify-between gap-3 rounded-2xl border px-3.5 py-3 text-left transition-colors',
                  agyTransam
                    ? 'border-rose-500/35 bg-rose-500/10'
                    : 'border-border/50 bg-muted/35 active:bg-muted/60',
                )}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <Zap className={cn('h-3.5 w-3.5 shrink-0', agyTransam ? 'text-rose-500' : 'text-muted-foreground')} />
                    <span className="text-[13px] font-semibold text-foreground">TRANS-AM 叙事引擎</span>
                  </div>
                  <p className="mt-0.5 truncate text-[11.5px] text-muted-foreground">
                    {agyTransam
                      ? '已开启：自动匹配 4A / 4H / 4N 预设 + D100×4 判定池'
                      : '已关闭：点击开启 TRANS-AM 叙事增强（4A / 4H / 4N）'}
                  </p>
                </div>
                <span
                  aria-hidden="true"
                  className={cn(
                    'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors',
                    agyTransam ? 'bg-rose-500' : 'bg-muted-foreground/30',
                  )}
                >
                  <span
                    className={cn(
                      'inline-block h-5 w-5 rounded-full bg-white shadow-sm transition-transform',
                      agyTransam ? 'translate-x-5' : 'translate-x-0.5',
                    )}
                  />
                </span>
              </button>
            </section>
          )}

          {/* Section: agy-fast accelerator plugin switch + GitHub auto-update */}
          {onToggleAgyFast && (
            <section className="space-y-2">
              <div
                className={cn(
                  'rounded-2xl border px-3.5 py-3 transition-colors',
                  agyFast && !agyFastDisabled
                    ? 'border-sky-500/35 bg-sky-500/10'
                    : 'border-border/50 bg-muted/35',
                )}
              >
                <button
                  type="button"
                  role="switch"
                  aria-checked={agyFast && !agyFastDisabled}
                  aria-label="切换 agy-fast 加速插件"
                  disabled={agyFastDisabled}
                  onClick={onToggleAgyFast}
                  className="flex w-full items-center justify-between gap-3 text-left disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <Rocket className={cn('h-3.5 w-3.5 shrink-0', agyFast && !agyFastDisabled ? 'text-sky-500' : 'text-muted-foreground')} />
                      <span className="text-[13px] font-semibold text-foreground">agy-fast 加速插件</span>
                      {agyFastPlugin.status?.installed_version && (
                        <span className="rounded bg-sky-500/15 px-1.5 py-0.5 font-mono text-[10px] text-sky-600 dark:text-sky-400">
                          v{agyFastPlugin.status.installed_version}
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 truncate text-[11.5px] text-muted-foreground">
                      {agyFastDisabled
                        ? '第三方 API 连接不支持挂载 MCP 工具（需原生 agy 账号）'
                        : agyFast
                          ? '已开启：MCP 批量搜索/编辑/大纲/检查 + 启动快照'
                          : '已关闭：点击开启 agy-fast 低延迟加速插件'}
                    </p>
                  </div>
                  <span
                    aria-hidden="true"
                    className={cn(
                      'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors',
                      agyFast && !agyFastDisabled ? 'bg-sky-500' : 'bg-muted-foreground/30',
                    )}
                  >
                    <span
                      className={cn(
                        'inline-block h-5 w-5 rounded-full bg-white shadow-sm transition-transform',
                        agyFast && !agyFastDisabled ? 'translate-x-5' : 'translate-x-0.5',
                      )}
                    />
                  </span>
                </button>
                <div className="mt-2.5 flex flex-wrap items-center gap-1.5 border-t border-border/40 pt-2">
                  <button
                    type="button"
                    disabled={agyFastPlugin.checking || agyFastPlugin.updating}
                    onClick={() => void agyFastPlugin.checkUpdate()}
                    className="inline-flex items-center gap-1 rounded-lg border border-border/60 bg-background/80 px-2.5 py-1 text-[11px] font-medium text-foreground disabled:opacity-50"
                  >
                    {agyFastPlugin.checking ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                    检查更新
                  </button>
                  <button
                    type="button"
                    disabled={agyFastPlugin.checking || agyFastPlugin.updating}
                    onClick={() => void agyFastPlugin.runUpdate(false)}
                    className="inline-flex items-center gap-1 rounded-lg bg-sky-500 px-2.5 py-1 text-[11px] font-medium text-white disabled:opacity-50"
                  >
                    {agyFastPlugin.updating ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
                    {agyFastPlugin.status?.update_available ? '更新并适配' : '同步适配'}
                  </button>
                  <button
                    type="button"
                    onClick={() => void agyFastPlugin.toggleAutoUpdate()}
                    className="ml-auto text-[11px] text-muted-foreground underline-offset-2 hover:underline"
                  >
                    自动更新：{(agyFastPlugin.status?.auto_update_enabled ?? true) ? '开' : '关'}
                  </button>
                </div>
                {agyFastPlugin.message && (
                  <p className="mt-1.5 text-[11px] text-emerald-600 dark:text-emerald-400">
                    {agyFastPlugin.message}
                  </p>
                )}
                {(agyFastPlugin.error || agyFastPlugin.status?.last_error) && (
                  <p className="mt-1.5 text-[11px] text-red-500">
                    {agyFastPlugin.error || agyFastPlugin.status?.last_error}
                  </p>
                )}
              </div>
            </section>
          )}

          {/* Section: Think auto-translate switch + account/model selector */}
          {onToggleAgyThinkTranslate && (
            <section className="space-y-2">
              <div
                className={cn(
                  'rounded-2xl border px-3.5 py-3 transition-colors',
                  agyThinkTranslate
                    ? 'border-violet-500/35 bg-violet-500/10'
                    : 'border-border/50 bg-muted/35',
                )}
              >
                <button
                  type="button"
                  role="switch"
                  aria-checked={agyThinkTranslate}
                  aria-label="切换思考自动翻译"
                  onClick={onToggleAgyThinkTranslate}
                  className="flex w-full items-center justify-between gap-3 text-left"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <Languages className={cn('h-3.5 w-3.5 shrink-0', agyThinkTranslate ? 'text-violet-500' : 'text-muted-foreground')} />
                      <span className="text-[13px] font-semibold text-foreground">思考自动翻译</span>
                    </div>
                    <p className="mt-0.5 truncate text-[11.5px] text-muted-foreground">
                      {agyThinkTranslate
                        ? '已开启：自动翻译思考内容'
                        : '已关闭：可点击每条思考旁的「翻译」手动翻译'}
                    </p>
                  </div>
                  <span
                    aria-hidden="true"
                    className={cn(
                      'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors',
                      agyThinkTranslate ? 'bg-violet-500' : 'bg-muted-foreground/30',
                    )}
                  >
                    <span
                      className={cn(
                        'inline-block h-5 w-5 rounded-full bg-white shadow-sm transition-transform',
                        agyThinkTranslate ? 'translate-x-5' : 'translate-x-0.5',
                      )}
                    />
                  </span>
                </button>
                <div className="mt-2.5 grid grid-cols-1 gap-2 border-t border-border/50 pt-2.5">
                  <label className="block space-y-1">
                    <span className="text-[11px] text-muted-foreground">固定翻译账号</span>
                    <select
                      value={thinkTranslateCfg.config.account_id}
                      disabled={thinkTranslateCfg.saving}
                      onChange={(e) => void thinkTranslateCfg.saveConfig({ account_id: e.target.value })}
                      className="w-full rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs text-foreground"
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
                    <span className="text-[11px] text-muted-foreground">
                      固定翻译模型{thinkTranslateCfg.saving || thinkTranslateCfg.loading ? '（加载中…）' : ''}
                    </span>
                    <select
                      value={thinkTranslateCfg.config.model}
                      disabled={thinkTranslateCfg.saving || thinkTranslateCfg.loading}
                      onChange={(e) => void thinkTranslateCfg.saveConfig({ model: e.target.value })}
                      className="w-full rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs text-foreground disabled:opacity-60"
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
                  <p className="mt-1.5 text-[11px] text-emerald-600 dark:text-emerald-400">{thinkTranslateCfg.message}</p>
                )}
                {thinkTranslateCfg.error && (
                  <p className="mt-1.5 text-[11px] text-red-500">{thinkTranslateCfg.error}</p>
                )}
              </div>
            </section>
          )}

          {/* Section 2: Claude -> agy mode switch */}
          {onToggleAgyUseClaude && (
            <section className="space-y-2">
              <button
                type="button"
                role="switch"
                aria-checked={agyUseClaude && !agyUseClaudeDisabled}
                aria-label="切换 Claude Code → agy"
                disabled={agyUseClaudeDisabled}
                onClick={onToggleAgyUseClaude}
                className={cn(
                  'flex w-full items-center justify-between gap-3 rounded-2xl border px-3.5 py-3 text-left transition-colors',
                  agyUseClaudeDisabled
                    ? 'cursor-not-allowed border-border/40 bg-muted/25 opacity-60'
                    : agyUseClaude
                      ? 'border-emerald-500/35 bg-emerald-500/10'
                      : 'border-border/50 bg-muted/35 active:bg-muted/60',
                )}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span
                      className={cn(
                        'h-2 w-2 shrink-0 rounded-full',
                        agyUseClaude && !agyUseClaudeDisabled ? 'bg-emerald-500' : 'bg-muted-foreground/45',
                      )}
                    />
                    <span className="text-[13px] font-semibold text-foreground">Claude → agy</span>
                  </div>
                  <p className="mt-0.5 truncate text-[11.5px] text-muted-foreground">
                    {agyUseClaudeDisabled
                      ? '需登录 agy 账号（第三方 API 不支持）'
                      : agyUseClaude
                        ? 'Claude Code 执行工具，agy 提供模型'
                        : '当前使用原有 agy 执行方式'}
                  </p>
                </div>
                <span
                  aria-hidden="true"
                  className={cn(
                    'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors',
                    agyUseClaude && !agyUseClaudeDisabled ? 'bg-emerald-500' : 'bg-muted-foreground/30',
                  )}
                >
                  <span
                    className={cn(
                      'inline-block h-5 w-5 rounded-full bg-white shadow-sm transition-transform',
                      agyUseClaude && !agyUseClaudeDisabled ? 'translate-x-5' : 'translate-x-0.5',
                    )}
                  />
                </span>
              </button>
            </section>
          )}

          {/* Section 3: Network & Monitoring tools (代理节点 & 监控窗口) */}
          {activeTab === 'chat' && (
            <section aria-label="网络与监控" className="space-y-2">
              <h3 className="px-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                网络与监控
              </h3>
              <div
                ref={onToolsSlotChange}
                className="grid grid-cols-2 gap-2.5 empty:hidden"
              />
            </section>
          )}

          {/* Section 4: Quick actions + Export slot */}
          <section className="space-y-2">
            <h3 className="px-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              快捷操作
            </h3>
            <div className="flex items-center gap-2">
              {onStartNewSession && (
                <button
                  type="button"
                  onClick={() => closeAndRun(() => {
                    setActiveTab('chat');
                    onStartNewSession();
                  })}
                  className="inline-flex h-10 flex-1 items-center justify-center gap-1.5 rounded-xl border border-border/55 bg-muted/35 px-2.5 text-xs font-medium text-foreground transition-colors active:scale-[0.98] hover:bg-muted/60"
                >
                  <SquarePen className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate">{t('mainContent.newSession', { defaultValue: '新对话' })}</span>
                </button>
              )}

              {onOpenQuickSettings && (
                <button
                  type="button"
                  onClick={() => closeAndRun(onOpenQuickSettings)}
                  className="inline-flex h-10 flex-1 items-center justify-center gap-1.5 rounded-xl border border-border/55 bg-muted/35 px-2.5 text-xs font-medium text-foreground transition-colors active:scale-[0.98] hover:bg-muted/60"
                >
                  <SlidersHorizontal className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate">快捷设置</span>
                </button>
              )}

              {onShowSettings && (
                <button
                  type="button"
                  onClick={() => closeAndRun(() => onShowSettings())}
                  className="inline-flex h-10 flex-1 items-center justify-center gap-1.5 rounded-xl border border-border/55 bg-muted/35 px-2.5 text-xs font-medium text-foreground transition-colors active:scale-[0.98] hover:bg-muted/60"
                >
                  <Settings className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate">{t('common:buttons.settings', { defaultValue: '设置' })}</span>
                </button>
              )}

              {/* Export menu portals here when chat has messages */}
              <div ref={onExportSlotChange} className="shrink-0 empty:hidden" />
            </div>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
