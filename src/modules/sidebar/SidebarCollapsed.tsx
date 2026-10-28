import { Settings, PanelLeftOpen, AlertTriangle } from 'lucide-react';
import type { TFunction } from 'i18next';

type SidebarCollapsedProps = {
  onExpand: () => void;
  onShowSettings: () => void;
  updateAvailable: boolean;
  restartRequired: boolean;
  onShowVersionModal: () => void;
  t: TFunction;
};

/** Used by Sidebar for the collapsed navigation and settings rail. */
export default function SidebarCollapsed({ onExpand, onShowSettings, restartRequired, t }: SidebarCollapsedProps) {
  return <div className="flex h-full w-12 flex-col items-center gap-1 bg-background/80 py-3 backdrop-blur-sm">
    <button onClick={onExpand} className="flex h-8 w-8 items-center justify-center rounded-lg hover:bg-accent" aria-label={t('common:versionUpdate.ariaLabels.showSidebar')}><PanelLeftOpen className="h-4 w-4" /></button>
    <div className="nav-divider my-1 w-6" />
    <button onClick={onShowSettings} className="flex h-8 w-8 items-center justify-center rounded-lg hover:bg-accent" aria-label={t('actions.settings')}><Settings className="h-4 w-4" /></button>
    {restartRequired && <div title={t('version.restartRequired')}><AlertTriangle className="h-4 w-4 text-amber-500" /></div>}
  </div>;
}
