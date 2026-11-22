import { useTranslation } from 'react-i18next';

import { Button, Dialog, DialogContent, DialogTitle } from '@/shared/ui';
import type { ChatMessage } from '@/shared/types';

export type RecallMessageTarget = {
  message: ChatMessage;
  isLatestUserMessage: boolean;
  userTurnFromEnd: number;
};

type RecallMessageDialogProps = {
  target: RecallMessageTarget | null;
  isSubmitting: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
};

/**
 * Confirmation prompt shown before recalling a user message from the
 * conversation transcript. Cancel appears first in DOM order so initial focus
 * lands on it rather than on the destructive action.
 */
export default function RecallMessageDialog({
  target,
  isSubmitting,
  error,
  onCancel,
  onConfirm,
}: RecallMessageDialogProps) {
  const { t } = useTranslation('chat');
  const previewText = String(target?.message.content || '').trim();

  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open && !isSubmitting) {
          onCancel();
        }
      }}
    >
      <DialogContent
        aria-describedby="recall-message-dialog-description"
        className="max-w-md p-5"
      >
        <DialogTitle className="not-sr-only text-base font-semibold text-foreground">
          {t('message.recallConfirmTitle', {
            defaultValue: 'Recall this message?',
          })}
        </DialogTitle>

        <p
          id="recall-message-dialog-description"
          className="mt-2.5 text-sm leading-relaxed text-muted-foreground"
        >
          {target?.isLatestUserMessage
            ? t('message.recallConfirmLatest', {
                defaultValue:
                  'This latest message and its reply will be removed, and its text will be placed back into the input box for editing.',
              })
            : t('message.recallConfirmEarlier', {
                defaultValue:
                  'This message and all subsequent turns will be deleted, and its text will be placed back into the input box for editing.',
              })}
        </p>

        {previewText && (
          <div className="mt-3 line-clamp-3 break-words rounded-lg border border-border/70 bg-muted/50 px-3 py-2 text-xs text-foreground/90">
            {previewText}
          </div>
        )}

        {error && (
          <p role="alert" className="mt-3 text-xs text-destructive">
            {error}
          </p>
        )}

        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={isSubmitting}
            onClick={onCancel}
          >
            {t('message.recallCancel', { defaultValue: 'Cancel' })}
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={isSubmitting}
            onClick={onConfirm}
          >
            {isSubmitting
              ? t('message.recallRecalling', { defaultValue: 'Recalling...' })
              : t('message.recallConfirmButton', { defaultValue: 'Recall' })}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
