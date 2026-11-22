import { useId, useRef, useState } from 'react';

import { api } from '@/shared/api';
import type { CodexResetCredits } from '@/shared/types';
import { Dialog, DialogContent, DialogTitle } from '@/shared/ui';

/** Used by the unified agent-account quota and legacy Codex quota bars for explicit, account-scoped official resets. */
export function CodexResetButton({
  connectionId,
  credits,
  onReset,
  embedded = false,
}: {
  connectionId: string;
  credits?: CodexResetCredits | null;
  onReset: () => void;
  embedded?: boolean;
}) {
  const helpId = 'reset-credit-' + useId();
  // Keep confirmation and result messages tied to the account shown when the user opened the dialog.
  const [reset, setReset] = useState<{ id: string; busy: boolean; message: string; open: boolean; creditId?: string } | null>(null);
  // Reuse the same native idempotency key if the network loses the reset response.
  const attempt = useRef<{ id: string; key: string; creditId?: string } | null>(null);
  const consumeReset = async () => {
    if (!connectionId || !reset || reset.id !== connectionId || reset.busy) return;
    const id = connectionId;
    if (!attempt.current || attempt.current.id !== id || attempt.current.creditId !== reset.creditId) {
      attempt.current = { id, key: crypto.randomUUID(), creditId: reset.creditId };
    }
    const request = attempt.current;
    setReset({ ...reset, busy: true, message: '' });
    try {
      const response = await api.codexConnections.consumeReset(id, request.key, request.creditId);
      if (!response.ok) throw new Error('reset unavailable');
      const result = await response.json() as { connectionId: string; resetOutcome?: string };
      if (result.connectionId !== id || !result.resetOutcome) throw new Error('unknown outcome');
      const messages: Record<string, string> = { reset: '重置成功，正在刷新额度。', nothingToReset: '当前额度无需重置，卡未消耗。', noCredit: '官方返回没有可用重置卡。', alreadyRedeemed: '这次重置已处理，请刷新额度查看。' };
      setReset({ id, busy: false, open: false, message: messages[result.resetOutcome] || '请刷新官方额度查看结果。' });
      attempt.current = null;
      onReset();
    } catch {
      setReset({ ...reset, busy: false, open: true, message: '暂未确认结果。请先刷新额度核对；再次确认会沿用本次请求，避免重复消耗。' });
    }
  };
  return <>
      <button
        type="button"
        disabled={reset?.busy || !credits?.availableCount}
        className={
          embedded
            ? 'inline-flex h-7 shrink-0 items-center rounded-full border border-border/70 bg-background px-2.5 text-[11px] font-medium text-foreground/85 transition-colors active:scale-95 hover:bg-muted/60 disabled:opacity-50'
            : 'shrink-0 rounded border border-border px-2 py-1 disabled:opacity-50'
        }
        onClick={() => setReset({ id: connectionId, busy: false, message: '', open: true, creditId: credits?.credits?.[0]?.id })}
      >
        使用重置卡{credits ? `（${credits.availableCount}）` : '（暂不可读）'}
      </button>
      <a
        href="https://chatgpt.com/codex/settings/usage"
        target="_blank"
        rel="noopener noreferrer"
        className={
          embedded
            ? 'inline-flex shrink-0 items-center whitespace-nowrap text-[11px] font-medium text-primary underline underline-offset-2'
            : 'shrink-0 whitespace-nowrap text-primary underline'
        }
      >
        官方用量与重置 ↗
      </a>
    {reset?.id === connectionId && reset.message && <p role="status" className="w-full text-[11px] text-muted-foreground">{reset.message}</p>}
    <Dialog open={reset?.id === connectionId && reset.open} onOpenChange={open => { if (reset && !reset.busy) setReset({ ...reset, open }); }}>
      <DialogContent className="w-[calc(100%-1.5rem)] space-y-3 p-4 sm:max-w-lg sm:p-6" aria-describedby={helpId}>
        <DialogTitle>使用 Codex 重置卡</DialogTitle>
        <p id={helpId} className="text-sm">仅对当前账号生效，会消耗一张已领取的重置卡。官方决定可恢复的额度；使用后无法撤销。</p>
        {Boolean(credits?.credits?.length) && <label className="block text-sm">选择重置卡
          <select aria-label="选择重置卡" value={reset?.creditId || ''} disabled={reset?.busy} onChange={event => { if (reset) setReset({ ...reset, creditId: event.target.value }); }} className="mt-1 block w-full rounded border border-border bg-background p-2">
            {credits?.credits?.map(credit => <option key={credit.id} value={credit.id}>{credit.title || 'Codex 额度重置'}{credit.expiresAt ? ' · 到期 ' + new Date(credit.expiresAt * 1000).toLocaleString() : ''}</option>)}
          </select>
          {credits?.credits?.find(credit => credit.id === reset?.creditId)?.description && <p className="mt-2 text-muted-foreground">{credits.credits.find(credit => credit.id === reset?.creditId)?.description}</p>}
        </label>}
        <div className="flex justify-end gap-2">
          <button type="button" disabled={reset?.busy} className="rounded border px-3 py-2" onClick={() => { if (reset) setReset({ ...reset, open: false }); }}>取消</button>
          <button type="button" disabled={reset?.busy} className="rounded bg-primary px-3 py-2 text-primary-foreground disabled:opacity-50" onClick={() => void consumeReset()}>{reset?.busy ? '正在重置…' : '确认使用一张'}</button>
        </div>
      </DialogContent>
    </Dialog>
  </>;
}
