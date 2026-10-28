import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { useCodexFastMode } from '@/modules/chat/hooks/useCodexFastMode';

const mocks = vi.hoisted(() => ({ read: vi.fn(), save: vi.fn() }));
vi.mock('@/shared/api', () => ({ api: { providers: { sessionFastMode: mocks.read, setSessionFastMode: mocks.save } } }));
const response = (fastMode: boolean, ok = true) => ({ ok, json: async () => ({ success: ok, data: { fastMode } }) });
beforeEach(() => { localStorage.clear(); mocks.read.mockReset(); mocks.save.mockReset(); });
afterEach(() => { localStorage.clear(); });

test('new chats start standard, preserve the explicit choice, and other providers disable Fast', async () => {
  const hook = renderHook(({ enabled }) => useCodexFastMode(null, enabled), { initialProps: { enabled: true } });
  expect(hook.result.current.fastMode).toBe(false);
  await act(async () => hook.result.current.selectFastMode(true));
  expect(localStorage.getItem('codex-fast-mode')).toBe('true');
  expect(hook.result.current.fastMode).toBe(true);
  hook.rerender({ enabled: false });
  expect(hook.result.current.fastMode).toBe(false);
  expect(mocks.read).not.toHaveBeenCalled();
});

test('session loads ignore late replies from the previous conversation', async () => {
  let release!: (value: ReturnType<typeof response>) => void;
  mocks.read.mockImplementationOnce(() => new Promise(resolve => { release = resolve; })).mockResolvedValueOnce(response(false));
  const hook = renderHook(({ id }) => useCodexFastMode(id, true), { initialProps: { id: 'a' } });
  expect(hook.result.current.fastMode).toBeUndefined();
  hook.rerender({ id: 'b' });
  await waitFor(() => expect(hook.result.current.fastMode).toBe(false));
  await act(async () => release(response(true)));
  expect(hook.result.current.fastMode).toBe(false);
});

test('saving survives remount and failures keep the last confirmed value', async () => {
  mocks.read.mockResolvedValue(response(true));
  mocks.save.mockResolvedValue(response(false));
  const hook = renderHook(() => useCodexFastMode('a', true));
  await waitFor(() => expect(hook.result.current.fastMode).toBe(true));
  await act(async () => hook.result.current.selectFastMode(false));
  expect(mocks.save).toHaveBeenCalledWith('a', false);
  expect(hook.result.current.fastMode).toBe(false);
  mocks.save.mockResolvedValue(response(true, false));
  await act(async () => hook.result.current.selectFastMode(true));
  expect(hook.result.current.fastMode).toBe(false);
  expect(hook.result.current.fastModeError).toBe(true);
  expect(localStorage.getItem('codex-fast-mode')).toBe('false');
  hook.unmount();
  mocks.read.mockResolvedValue(response(false));
  const reopened = renderHook(() => useCodexFastMode('a', true));
  await waitFor(() => expect(reopened.result.current.fastMode).toBe(false));
});

test('a late save cannot replace a different session or its new-chat default', async () => {
  mocks.read.mockResolvedValue(response(false));
  let release!: (value: ReturnType<typeof response>) => void;
  mocks.save.mockImplementation(() => new Promise(resolve => { release = resolve; }));
  const hook = renderHook(({ id }) => useCodexFastMode(id, true), { initialProps: { id: 'a' } });
  await waitFor(() => expect(hook.result.current.fastMode).toBe(false));
  let pending!: Promise<void>;
  act(() => { pending = hook.result.current.selectFastMode(true); });
  hook.rerender({ id: 'b' });
  await waitFor(() => expect(hook.result.current.fastMode).toBe(false));
  await act(async () => { release(response(true)); await pending; });
  expect(hook.result.current.fastMode).toBe(false);
  expect(localStorage.getItem('codex-fast-mode')).toBeNull();
});
