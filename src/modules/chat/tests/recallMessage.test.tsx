import assert from 'node:assert/strict';

import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';

import type { ChatMessage, NormalizedMessage } from '@/shared/types';
import RecallMessageDialog from '@/modules/chat/modals/RecallMessageDialog';

const sessionMessages = vi.fn();

vi.mock('@/shared/api', () => ({
  api: {
    providers: {
      sessionMessages: (...args: unknown[]) => sessionMessages(...args),
    },
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? _key,
  }),
}));

const makeRow = (id: string, role: 'user' | 'assistant', content: string): NormalizedMessage => ({
  id,
  kind: 'text',
  role,
  provider: 'antigravity',
  sessionId: 'session-recall-1',
  content,
  timestamp: `2026-01-01T00:00:0${id}.000Z`,
  ...(role === 'user' ? { transcriptAnchorId: id } : {}),
} as NormalizedMessage);

beforeEach(() => {
  sessionMessages.mockReset();
});

afterEach(() => {
  vi.resetModules();
});

describe('RecallMessageDialog', () => {
  const sampleMessage: ChatMessage = {
    type: 'user',
    content: 'Please refactor the parser',
    timestamp: '2026-01-01T00:00:00.000Z',
    transcriptAnchorId: 'u-1',
  };

  it('shows latest-message explanation and invokes confirm/cancel handlers', () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();

    render(
      <RecallMessageDialog
        target={{ message: sampleMessage, isLatestUserMessage: true, userTurnFromEnd: 0 }}
        isSubmitting={false}
        error={null}
        onCancel={onCancel}
        onConfirm={onConfirm}
      />,
    );

    assert.ok(screen.getByText('Recall this message?'));
    assert.ok(screen.getByText(/This latest message and its reply will be removed/));
    assert.ok(screen.getByText('Please refactor the parser'));

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    assert.equal(onCancel.mock.calls.length, 1);

    fireEvent.click(screen.getByRole('button', { name: 'Recall' }));
    assert.equal(onConfirm.mock.calls.length, 1);
  });

  it('shows earlier-message warning when recalling a non-latest turn', () => {
    render(
      <RecallMessageDialog
        target={{ message: sampleMessage, isLatestUserMessage: false, userTurnFromEnd: 2 }}
        isSubmitting={false}
        error="Network failed"
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );

    assert.ok(screen.getByText(/This message and all subsequent turns will be deleted/));
    assert.ok(screen.getByRole('alert'));
    assert.ok(screen.getByText('Network failed'));
  });
});

describe('useSessionStore.resetAndFetchFromServer', () => {
  it('clears stale realtime messages and replaces transcript with server state', async () => {
    const initialHistory = [
      makeRow('1', 'user', 'first question'),
      makeRow('2', 'assistant', 'first answer'),
      makeRow('3', 'user', 'second question'),
      makeRow('4', 'assistant', 'second answer'),
    ];
    const recalledHistory = [
      makeRow('1', 'user', 'first question'),
      makeRow('2', 'assistant', 'first answer'),
    ];

    sessionMessages
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: { messages: initialHistory, total: initialHistory.length, hasMore: false },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: { messages: recalledHistory, total: recalledHistory.length, hasMore: false },
        }),
      });

    const { useSessionStore } = await import('@/modules/chat/hooks/useSessionStore');
    const { result } = renderHook(() => useSessionStore());

    await act(async () => {
      await result.current.fetchFromServer('session-recall-1', { limit: 20, offset: 0 });
    });

    act(() => {
      result.current.appendRealtime(
        'session-recall-1',
        makeRow('5', 'user', 'optimistic third question'),
      );
      result.current.updateStreaming('session-recall-1', 'partial streaming reply', 'antigravity');
    });

    assert.equal(result.current.getMessages('session-recall-1').length, 6);

    await act(async () => {
      await result.current.resetAndFetchFromServer('session-recall-1', { limit: 20, offset: 0 });
    });

    assert.deepEqual(
      result.current.getMessages('session-recall-1').map((msg) => msg.content),
      ['first question', 'first answer'],
    );
  });

  it('handles recalling the very first message (empty server response)', async () => {
    const initialHistory = [
      makeRow('1', 'user', 'only prompt'),
      makeRow('2', 'assistant', 'only reply'),
    ];

    sessionMessages
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: { messages: initialHistory, total: initialHistory.length, hasMore: false },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: { messages: [], total: 0, hasMore: false },
        }),
      });

    const { useSessionStore } = await import('@/modules/chat/hooks/useSessionStore');
    const { result } = renderHook(() => useSessionStore());

    await act(async () => {
      await result.current.fetchFromServer('session-recall-1', { limit: 20, offset: 0 });
      await result.current.resetAndFetchFromServer('session-recall-1', { limit: 20, offset: 0 });
    });

    assert.deepEqual(result.current.getMessages('session-recall-1'), []);
  });
});
