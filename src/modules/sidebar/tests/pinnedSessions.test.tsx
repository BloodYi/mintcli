import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';

import type * as sharedApiModule from '@/shared/api';

const saved: Record<string, unknown>[] = [];
let failSave = false;
vi.mock('@/shared/api', async (importOriginal) => {
  const original = await importOriginal<typeof sharedApiModule>();
  return {
    ...original,
    api: { ...original.api, user: { ...original.api.user, savePreferences: vi.fn(async (updates: Record<string, unknown>) => {
      saved.push(updates);
      return new Response(JSON.stringify(failSave ? { error: 'offline' } : { success: true }), { status: failSave ? 500 : 200 });
    }) } },
  };
});

import { useSessionPin } from '@/modules/sidebar/hooks/usePinnedSessions';
import { writeUserPreference } from '@/shared/userSettings';

beforeEach(() => {
  writeUserPreference('pinnedSessionIds', [], false);
  saved.length = 0;
  failSave = false;
});

test('different row pins are serialized and unpin preserves the other conversation', async () => {
  const first = renderHook(() => useSessionPin('first'));
  const second = renderHook(() => useSessionPin('second'));
  await act(async () => {
    await Promise.all([first.result.current.togglePin(), second.result.current.togglePin()]);
  });
  expect(first.result.current.pinned).toBe(true);
  expect(second.result.current.pinned).toBe(true);
  expect(saved).toEqual([{ pinnedSessionIds: ['first'] }, { pinnedSessionIds: ['first', 'second'] }]);
  await act(async () => { await first.result.current.togglePin(); });
  expect(first.result.current.pinned).toBe(false);
  expect(second.result.current.pinned).toBe(true);
  expect(saved.at(-1)).toEqual({ pinnedSessionIds: ['second'] });
});

test('a failed save keeps the previous pin and can be retried', async () => {
  failSave = true;
  const row = renderHook(() => useSessionPin('retry'));
  await act(async () => { await row.result.current.togglePin(); });
  expect(row.result.current.pinned).toBe(false);
  expect(row.result.current.error).toBe(true);
  failSave = false;
  await act(async () => { await row.result.current.togglePin(); });
  await waitFor(() => expect(row.result.current.pinned).toBe(true));
  expect(row.result.current.error).toBe(false);
});
