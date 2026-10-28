import { act, renderHook } from '@testing-library/react';
import { expect, it } from 'vitest';
import { useSessionStore } from '@/modules/chat/hooks/useSessionStore';
import type { NormalizedMessage } from '@/shared/types';
it('a new native snapshot replaces the earlier text without creating a second assistant row', () => {
  const { result } = renderHook(() => useSessionStore());
  const base: NormalizedMessage = { id: 'agy-message', provider: 'antigravity', sessionId: 's', timestamp: new Date().toISOString(), kind: 'text', role: 'assistant', content: '正在' };
  act(() => { result.current.appendRealtime('s', base); result.current.appendRealtime('s', { ...base, content: '正在回复，已完成' }); });
  expect(result.current.getMessages('s')).toHaveLength(1);
  expect(result.current.getMessages('s')[0].content).toBe('正在回复，已完成');
});
