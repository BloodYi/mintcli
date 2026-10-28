import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/shared/api';

/** Used by ChatInterface to restore and save each Codex session's speed selection. */
export function useCodexFastMode(sessionId: string | null, enabled: boolean) {
  // New chats inherit the last explicit choice; existing sessions load their own value.
  const [defaultFastMode, setDefaultFastMode] = useState(() => localStorage.getItem('codex-fast-mode') === 'true');
  // Keyed by session so a navigation never displays or sends the previous session's value.
  const [selection, setSelection] = useState<{ sessionId: string; value: boolean } | null>(null);
  // Disables repeat toggles while saving and surfaces persistence failures in the composer.
  const [saving, setSaving] = useState(false);
  // Keeps persistence failures visible without falsely showing a successful toggle.
  const [error, setError] = useState(false);
  const generation = useRef(0);
  const currentSession = useRef(sessionId);
  currentSession.current = sessionId;

  useEffect(() => {
    const request = ++generation.current;
    setError(false);
    setSaving(false);
    if (!enabled || !sessionId) return;
    void api.providers.sessionFastMode(sessionId).then(async response => {
      const body = await response.json();
      if (!response.ok || !body.success || typeof body.data?.fastMode !== 'boolean') throw new Error('Invalid Fast setting');
      if (generation.current === request) setSelection({ sessionId, value: body.data.fastMode });
    }).catch(() => {
      if (generation.current === request) setError(true);
    });
    return () => { generation.current += 1; };
  }, [enabled, sessionId]);

  // Undefined during loading leaves the backend's saved setting authoritative for an immediate send.
  const fastMode = !enabled ? false : !sessionId ? defaultFastMode
    : selection?.sessionId === sessionId ? selection.value : undefined;

  const selectFastMode = useCallback(async (value: boolean) => {
    const request = ++generation.current;
    setError(false);
    if (sessionId) {
      setSaving(true);
      try {
        const response = await api.providers.setSessionFastMode(sessionId, value);
        const body = await response.json();
        if (!response.ok || !body.success || body.data?.fastMode !== value) throw new Error('Fast setting was not saved');
        if (generation.current !== request || currentSession.current !== sessionId) return;
        setSelection({ sessionId, value });
      } catch {
        if (generation.current === request) setError(true);
        return;
      } finally {
        if (generation.current === request) setSaving(false);
      }
    }
    localStorage.setItem('codex-fast-mode', String(value));
    setDefaultFastMode(value);
  }, [sessionId]);

  return { fastMode, selectFastMode, fastModePending: saving || (enabled && fastMode === undefined && !error), fastModeError: error };
}
