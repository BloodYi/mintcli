import { Settings, AlertTriangle } from 'lucide-react';
import type { TFunction } from 'i18next';
import type { ReleaseInfo } from '@/shared/types';

type SidebarFooterProps = {
  updateAvailable: boolean;
  restartRequired: boolean;
  releaseInfo: ReleaseInfo | null;
  latestVersion: string | null;
  currentVersion: string;
  onShowVersionModal: () => void;
  onShowSettings: () => void;
  t: TFunction;
};

/** Used by SidebarContent for settings and the installed mintcli version. */
export default function SidebarFooter({ restartRequired, currentVersion, onShowSettings, t }: SidebarFooterProps) {
  return <div className="flex-shrink-0" style={{ paddingBottom: 'env(safe-area-inset-bottom, 0)' }}>
    <div className="nav-divider" />
    {restartRequired && <div role="status" className="flex items-center gap-2 px-3 py-2 text-xs text-amber-600"><AlertTriangle className="h-4 w-4" />{t('version.restartRequired')}</div>}
    <div className="px-3 py-2">
      <button type="button" onClick={onShowSettings} className="flex min-h-10 w-full items-center gap-2 rounded-lg px-2.5 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"><Settings className="h-4 w-4" />{t('actions.settings')}</button>
    </div>
    <div className="px-3 pb-2 text-center text-[10px] text-muted-foreground/60">mintcli v{currentVersion}</div>
  </div>;
}
