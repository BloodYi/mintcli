import { useCallback, useRef } from 'react';

/** Used by the account manager and native login card to open OAuth from the user's click before awaiting the CLI. */
export function useAuthorizationPopup() {
  const popup = useRef<Window | null>(null);
  const openedUrl = useRef<string | null>(null);
  const open = useCallback(() => {
    openedUrl.current = null;
    popup.current = window.open('about:blank', '_blank');
    if (popup.current) {
      popup.current.opener = null;
      popup.current.document.title = '官方账号授权';
      popup.current.document.body.textContent = '正在生成官方授权链接，请稍候…';
    }
  }, []);
  const navigate = useCallback((url?: string) => {
    if (!url || openedUrl.current === url || !popup.current || popup.current.closed) return;
    try {
      const target = new URL(url);
      if (target.protocol !== 'https:') return;
      popup.current.location.replace(target.href); openedUrl.current = url;
    } catch { /* The visible link remains available if this window was closed. */ }
  }, []);
  const closePlaceholder = useCallback(() => {
    if (!openedUrl.current) popup.current?.close();
  }, []);
  return { open, navigate, closePlaceholder };
}
