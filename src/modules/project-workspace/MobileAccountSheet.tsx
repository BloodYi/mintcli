import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Dialog, DialogContent, DialogTitle } from '@/shared/ui';

type MobileAccountSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAccountSlotChange: (node: HTMLDivElement | null) => void;
};

/**
 * Dedicated mobile bottom sheet opened from the top-center account pill.
 * Keeps account switching and expandable quota cards spacious and focused,
 * completely separate from workspace navigation and system tools.
 */
export default function MobileAccountSheet({
  open,
  onOpenChange,
  onAccountSlotChange,
}: MobileAccountSheetProps) {
  const { t } = useTranslation();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        wrapperClassName="items-end p-0"
        animationClassName="animate-bottom-sheet-content-show"
        className="flex max-h-[84dvh] w-full max-w-none flex-col overflow-hidden rounded-b-none rounded-t-[26px] border-x-0 border-b-0 border-t border-border/70 bg-background/[0.98] p-0 shadow-2xl"
      >
        <DialogTitle className="sr-only">账号与额度</DialogTitle>

        <div className="flex-shrink-0 px-4 pb-3 pt-2.5">
          <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-muted-foreground/25" aria-hidden="true" />
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0 flex-1">
              <p className="truncate text-[15px] font-semibold tracking-tight text-foreground">
                账号与额度
              </p>
              <p className="mt-0.5 truncate text-xs text-muted-foreground">
                切换当前账号或展开查看剩余配额
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

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
          <div ref={onAccountSlotChange} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
