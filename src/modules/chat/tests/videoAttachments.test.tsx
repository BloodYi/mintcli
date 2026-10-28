import type { ClipboardEvent } from 'react';
import { act, renderHook } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import '@/modules/i18n';
import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';

afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });

const renderComposer = () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ commands: [] }))));
  return renderHook(() => useChatComposerState({
    selectedProject: null, selectedSession: null, currentSessionId: null,
    provider: 'codex', permissionMode: 'default', cyclePermissionMode: () => {},
    resolvePermissionModeForProvider: () => 'default', currentProviderModel: 'test-model',
    currentProviderEffort: 'medium', isLoading: false, canAbortSession: false,
    tokenBudget: null, sendMessage: () => {}, scrollToBottom: () => {},
    addMessage: () => {}, setIsUserScrolledUp: () => {}, setPendingPermissionRequests: () => {},
  }));
};

test('pasted videos larger than 10MB remain attached to the composer', () => {
  const { result } = renderComposer();
  const file = new File([], 'clip.mp4', { type: 'video/mp4' });
  Object.defineProperty(file, 'size', { value: 12 * 1024 * 1024 });
  act(() => result.current.handlePaste({ clipboardData: {
    items: [{ kind: 'file', type: 'video/mp4', getAsFile: () => file }], files: [file],
  } } as unknown as ClipboardEvent<HTMLTextAreaElement>));
  expect(result.current.attachedFiles).toEqual([file]);
  expect(result.current.fileErrors.size).toBe(0);
});

test('videos over 200MB show a useful error without being attached', () => {
  const { result } = renderComposer();
  const file = new File([], 'large.mov', { type: 'video/quicktime' });
  Object.defineProperty(file, 'size', { value: 200 * 1024 * 1024 + 1 });
  act(() => result.current.handlePaste({ clipboardData: { items: [], files: [file] } } as unknown as ClipboardEvent<HTMLTextAreaElement>));
  expect(result.current.attachedFiles).toEqual([]);
  expect(result.current.fileErrors.get(file.name)).toContain('200MB');
});
