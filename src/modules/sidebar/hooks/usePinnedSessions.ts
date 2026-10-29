import { useMemo, useState, useSyncExternalStore } from 'react';

import { api, readApiJson } from '@/shared/api';
import { readUserPreference, subscribeToUserPreferences, writeUserPreference } from '@/shared/userSettings';

const snapshot = () => JSON.stringify(readUserPreference<unknown>('pinnedSessionIds', []));
// Serialize different row actions too, so two quick pins cannot overwrite each other.
let pendingWrite: Promise<void> = Promise.resolve();

function toggleSavedPin(sessionId: string): Promise<void> {
  const operation = pendingWrite.then(async () => {
    const stored: unknown = JSON.parse(snapshot());
    const next = new Set<string>(Array.isArray(stored) ? stored.filter((id): id is string => typeof id === 'string') : []);
    if (next.has(sessionId)) next.delete(sessionId);
    else next.add(sessionId);
    await readApiJson(await api.user.savePreferences({ pinnedSessionIds: [...next] }));
    writeUserPreference('pinnedSessionIds', [...next], false);
  });
  pendingWrite = operation.catch(() => {});
  return operation;
}

/** Used by sidebar lists and row controls to share the user's persisted pins. */
export function usePinnedSessions() {
  const stored = useSyncExternalStore(subscribeToUserPreferences, snapshot);
  return useMemo(() => {
    const value: unknown = JSON.parse(stored);
    return new Set<string>(Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []);
  }, [stored]);
}

/** Used by desktop and mobile row menus; publish a pin only after its save succeeds. */
export function useSessionPin(sessionId: string) {
  const pins = usePinnedSessions();
  // Prevent repeated clicks while the account preference is being saved.
  const [saving, setSaving] = useState(false);
  // Keep a failed save visible next to the action so it can be retried.
  const [error, setError] = useState(false);
  const togglePin = async () => {
    if (saving) return;
    setSaving(true);
    setError(false);
    try {
      await toggleSavedPin(sessionId);
    } catch {
      setError(true);
    } finally {
      setSaving(false);
    }
  };
  return { pinned: pins.has(sessionId), saving, error, togglePin };
}
