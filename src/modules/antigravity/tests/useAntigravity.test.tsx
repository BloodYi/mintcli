import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api } from '@/shared/api';
import { useAntigravity } from '@/modules/antigravity/hooks/useAntigravity';

vi.mock('@/shared/api', () => ({
  api: { antigravity: {
    accounts: vi.fn(), conversations: vi.fn(), models: vi.fn(), quota: vi.fn(), chat: vi.fn(),
    turn: vi.fn(), events: vi.fn(), messages: vi.fn(),
  } },
  readApiJson: async (response: Response) => {
    const value = await response.json();
    if (!response.ok) throw new Error(value.detail);
    return value;
  },
}));

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks(); sessionStorage.clear();
  vi.mocked(api.antigravity.accounts).mockImplementation(async () => Response.json({ accounts: [{ id: 'fixture', active: true }] }));
  vi.mocked(api.antigravity.conversations).mockImplementation(async () => Response.json({ conversations: [] }));
  vi.mocked(api.antigravity.models).mockImplementation(async () => Response.json({ models: [] }));
  vi.mocked(api.antigravity.quota).mockImplementation(async () => Response.json({ quotas: [] }));
});

it('submits a native-compatible turn ID and restores the draft history after a rejected request', async () => {
  vi.mocked(api.antigravity.chat).mockImplementation(async body => {
    expect(body.turn_id).toMatch(/^[a-f0-9]{32}$/);
    return Response.json({ detail: 'fixture rejection' }, { status: 409 });
  });
  const { result } = renderHook(useAntigravity);
  await waitFor(() => expect(result.current.loading).toBe(false));
  await act(async () => { expect(await result.current.send('native fixture', '', '', [])).toBe(false); });
  expect(api.antigravity.chat).toHaveBeenCalledOnce();
  expect(result.current.messages).toEqual([]);
  expect(result.current.notice).toBe('fixture rejection');
});

it('reattaches a task by its pending ID after navigation before the native conversation ID was known', async () => {
  const id = 'a'.repeat(32);
  sessionStorage.setItem('mint.antigravity.pendingTurn', id);
  vi.mocked(api.antigravity.conversations).mockImplementation(async () => Response.json({ conversations: [], active_id: 'previous-chat' }));
  vi.mocked(api.antigravity.turn).mockResolvedValue(Response.json({ id, conversation_id: null, status: 'running', message: { id: 'assistant', role: 'assistant', content: '' } }));
  vi.mocked(api.antigravity.events).mockResolvedValue(new Response(
    'data: {"event":"snapshot","conversation_id":"native-chat","message":{"id":"assistant","role":"assistant","content":"native reply"}}\n\n' +
    'data: {"event":"done"}\n\n', { headers: { 'Content-Type': 'text/event-stream' } }));
  vi.mocked(api.antigravity.messages).mockResolvedValue(Response.json({ messages: [{ id: 'user', role: 'user', content: 'native prompt' }, { id: 'assistant', role: 'assistant', content: 'native reply' }], revision: 'native-revision' }));
  const { result } = renderHook(useAntigravity);
  await waitFor(() => expect(result.current.loading).toBe(false));
  await waitFor(() => expect(result.current.messages).toHaveLength(2));
  expect(result.current.conversationId).toBe('native-chat');
  expect(api.antigravity.events).toHaveBeenCalledWith(id, expect.any(AbortSignal));
  expect(api.antigravity.messages).not.toHaveBeenCalledWith('previous-chat', expect.anything());
  expect(sessionStorage.getItem('mint.antigravity.pendingTurn')).toBeNull();
});
