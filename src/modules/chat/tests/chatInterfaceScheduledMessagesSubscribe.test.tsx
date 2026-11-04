import assert from 'node:assert/strict';

import { fireEvent, render } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { test, vi } from 'vitest';

import '@/modules/i18n';
import type { LLMProvider, Project, ProjectSession, ServerEvent } from '@/shared/types';

/**
 * The scheduled-message banner follows the server's `scheduled_messages_changed`
 * frames only because ChatInterface hands the websocket context's `subscribe`
 * to useScheduledMessages (#1546). The hook takes it as an optional second
 * argument, so a call that drops it still type-checks and the hook's own tests
 * still pass, while the banner silently goes back to stale-until-reload. This
 * renders ChatInterface with everything else stubbed to catch exactly that.
 */

const harness = vi.hoisted(() => ({
  sessionId: 'session-a',
  setProvider: vi.fn(),
  setCurrentSessionId: vi.fn(),
  // The websocket context's own function; ChatInterface must pass this one on, not a stand-in.
  subscribe: (_listener: (event: ServerEvent) => void) => () => {},
  useScheduledMessages: vi.fn((_sessionId: string | null, _subscribe?: unknown) => ({
    scheduledMessages: [],
    schedule: async () => null,
    cancel: async () => false,
  })),
}));

vi.mock('@/modules/chat/composer/useScheduledMessages', () => ({
  useScheduledMessages: harness.useScheduledMessages,
}));
vi.mock('@/shared/context/WebSocketContext', () => ({
  useWebSocket: () => ({ subscribe: harness.subscribe }),
}));
vi.mock('@/shared/context/SessionProtectionContext', () => ({
  useProcessingSessions: () => new Map(),
  useSessionProtectionActions: () => ({
    markSessionProcessing: () => {},
    markSessionIdle: () => {},
    markSessionBackground: () => {},
    getSessionActivity: () => null,
  }),
}));
vi.mock('@/modules/task-master', () => ({
  useTasksSettings: () => ({ tasksEnabled: false, isTaskMasterInstalled: false }),
}));
vi.mock('@/modules/command-palette', () => ({ usePaletteOpsRegister: () => {} }));
vi.mock('@/modules/chat/hooks/useChatProviderState', () => ({
  useChatProviderState: () => ({ provider: 'antigravity', setProvider: harness.setProvider, pendingPermissionRequests: [] }),
}));
vi.mock('@/modules/chat/hooks/useChatSessionState', () => ({
  useChatSessionState: () => ({
    chatMessages: [],
    currentSessionId: harness.sessionId,
    setCurrentSessionId: harness.setCurrentSessionId,
    requestLatestMessages: async () => {},
  }),
}));
vi.mock('@/modules/chat/hooks/useChatRealtimeHandlers', () => ({ useChatRealtimeHandlers: () => {} }));
vi.mock('@/modules/chat/hooks/useChatComposerState', () => ({
  useChatComposerState: () => ({ input: '', setInput: () => {}, textareaRef: { current: null } }),
}));
vi.mock('@/modules/chat/hooks/useSessionStore', () => ({ useSessionStore: () => ({}) }));
vi.mock('@/modules/chat/transcript/ChatMessagesPane', () => ({ default: () => null }));
vi.mock('@/modules/chat/composer/ChatComposer', () => ({ default: () => null }));
vi.mock('@/modules/chat/modals/CommandResultModal', () => ({ default: () => null }));
vi.mock('@/modules/agent-connections', () => ({
  AgentConnections: ({ onProviderChange }: { onProviderChange: (provider: LLMProvider) => void }) => (
    <button onClick={() => onProviderChange('codex')}>切换到 GPT 账号</button>
  ),
}));

const { default: ChatInterface } = await import('@/modules/chat/ChatInterface');

const project: Project = { projectId: 'p1', displayName: 'repo', fullPath: '/work/repo', path: '/work/repo' };
const session: ProjectSession = { id: harness.sessionId, provider: 'claude' };

test('ChatInterface gives useScheduledMessages the websocket subscribe, so the banner stays live', () => {
  render(
    <MemoryRouter><ChatInterface
      isActive
      selectedProject={project}
      selectedSession={session}
      ws={null}
      sendMessage={() => {}}
    /></MemoryRouter>,
  );

  const calls = harness.useScheduledMessages.mock.calls;
  assert.ok(calls.length > 0, 'ChatInterface no longer reads the scheduled list through useScheduledMessages');
  for (const [sessionId, subscribe] of calls) {
    assert.equal(sessionId, harness.sessionId);
    assert.equal(
      subscribe,
      harness.subscribe,
      'useScheduledMessages must get the websocket context\'s subscribe, or scheduled_messages_changed is never heard',
    );
  }
});

test('switching an agy conversation to GPT keeps its session, URL and workspace selection', () => {
  const startNew = vi.fn();
  const established = vi.fn();
  function Location() { return <output data-testid="location">{useLocation().pathname}</output>; }
  const view = render(
    <MemoryRouter initialEntries={['/session/session-a']}><Location /><ChatInterface
      isActive selectedProject={project} selectedSession={{ ...session, __provider: 'antigravity' }}
      ws={null} sendMessage={() => {}} onStartNewSession={startNew} onSessionEstablished={established}
    /></MemoryRouter>,
  );
  fireEvent.click(view.getByRole('button', { name: '切换到 GPT 账号' }));
  assert.equal(view.getByTestId('location').textContent, '/session/session-a');
  assert.equal(startNew.mock.calls.length, 0);
  assert.equal(harness.setCurrentSessionId.mock.calls.length, 0);
  assert.deepEqual(harness.setProvider.mock.calls.at(-1), ['codex']);
  assert.equal(established.mock.calls[0]?.[0], 'session-a');
  assert.equal(established.mock.calls[0]?.[1].provider, 'codex');
});
