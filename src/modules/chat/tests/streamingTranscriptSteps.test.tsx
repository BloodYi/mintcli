import assert from 'node:assert/strict';

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, test } from 'vitest';

import { normalizedToChatMessages } from '@/modules/chat/hooks/useChatMessages';
import MessageComponent from '@/modules/chat/transcript/MessageComponent';
import ToolGroupContainer from '@/modules/chat/transcript/ToolGroupContainer';
import { getIntrinsicMessageKey } from '@/modules/chat/utils/messageKeys';
import { UiPreferencesProvider } from '@/shared/context/UiPreferencesContext';
import type { ChatMessage, DiffLine, NormalizedMessage, ToolGroupItem } from '@/shared/types';

afterEach(() => {
  cleanup();
});

const createDiff = (): DiffLine[] => [];

test('normalizedToChatMessages preserves isStreaming on thinking and assistant text rows', () => {
  const rows: NormalizedMessage[] = [
    {
      id: 'asst-1:thinking:1',
      sessionId: 's1',
      timestamp: '2026-11-21T19:00:00.000Z',
      provider: 'antigravity',
      kind: 'thinking',
      content: 'Inspecting project files',
      isStreaming: true,
    },
    {
      id: 'asst-1:text:2',
      sessionId: 's1',
      timestamp: '2026-11-21T19:00:01.000Z',
      provider: 'antigravity',
      kind: 'text',
      role: 'assistant',
      content: 'Working on it...',
      isStreaming: true,
    },
  ];

  const chat = normalizedToChatMessages(rows);
  assert.equal(chat.length, 2);
  assert.equal(chat[0].isThinking, true);
  assert.equal(chat[0].isStreaming, true);
  assert.equal(chat[0].modelSourceId, 'asst-1:thinking:1');
  assert.equal(chat[1].isStreaming, true);
  assert.equal(chat[1].modelSourceId, 'asst-1:text:2');
});

test('getIntrinsicMessageKey stays stable via modelSourceId as a streaming row grows', () => {
  const shortRow: ChatMessage = {
    type: 'assistant',
    content: 'Hi',
    timestamp: '2026-11-21T19:00:00.000Z',
    modelSourceId: 'asst-1:text:2',
    isStreaming: true,
  };
  const longerRow: ChatMessage = {
    ...shortRow,
    content: 'Hi there, streaming a longer reply across multiple deltas.',
  };

  assert.equal(getIntrinsicMessageKey(shortRow), getIntrinsicMessageKey(longerRow));
});

test('streaming thinking auto-opens with Thinking indicator and hides ReplyModelDetails while text streams', () => {
  const thinkingMsg: ChatMessage = {
    type: 'assistant',
    content: 'Planning tool calls',
    timestamp: '2026-11-21T19:00:00.000Z',
    isThinking: true,
    isStreaming: true,
    modelSourceId: 'asst-1:thinking:1',
  };

  const view = render(
    <UiPreferencesProvider>
      <MessageComponent
        message={thinkingMsg}
        prevMessage={null}
        createDiff={createDiff}
        showThinking
        provider="antigravity"
      />
    </UiPreferencesProvider>,
  );

  assert.ok(screen.getByText('Antigravity'));
  assert.ok(screen.getByText('Thinking...'));
  assert.ok(screen.getByText('Planning tool calls'));

  const streamingReply: ChatMessage = {
    type: 'assistant',
    content: 'Streaming answer...',
    timestamp: '2026-11-21T19:00:02.000Z',
    isStreaming: true,
    modelSourceId: 'asst-1:text:2',
    model: 'gemini-4-neon-high',
  };

  view.rerender(
    <UiPreferencesProvider>
      <MessageComponent
        message={streamingReply}
        prevMessage={thinkingMsg}
        createDiff={createDiff}
        showThinking
        provider="antigravity"
      />
    </UiPreferencesProvider>,
  );

  assert.equal(screen.queryByLabelText('回复模型信息'), null);

  view.rerender(
    <UiPreferencesProvider>
      <MessageComponent
        message={{ ...streamingReply, isStreaming: false }}
        prevMessage={thinkingMsg}
        createDiff={createDiff}
        showThinking
        provider="antigravity"
      />
    </UiPreferencesProvider>,
  );

  assert.ok(screen.getByLabelText('回复模型信息'));
});

test('ToolGroupContainer displays a live Running badge when any grouped tool is in progress', () => {
  const group: ToolGroupItem = {
    _isGroup: true,
    toolName: 'Read',
    timestamp: '2026-11-21T19:00:00.000Z',
    preview: '/a.ts, /b.ts',
    messages: [
      {
        type: 'assistant',
        content: '',
        timestamp: '2026-11-21T19:00:00.000Z',
        isToolUse: true,
        toolName: 'Read',
        toolId: 't1',
        toolInput: JSON.stringify({ file_path: '/a.ts' }),
        toolStatus: 'completed',
        toolResult: { content: 'a', isError: false },
      },
      {
        type: 'assistant',
        content: '',
        timestamp: '2026-11-21T19:00:01.000Z',
        isToolUse: true,
        toolName: 'Read',
        toolId: 't2',
        toolInput: JSON.stringify({ file_path: '/b.ts' }),
        toolStatus: 'in_progress',
        toolResult: null,
      },
    ],
  };

  render(
    <UiPreferencesProvider>
      <ToolGroupContainer
        group={group}
        prevMessage={null}
        createDiff={createDiff}
        getMessageKey={(m) => m.toolId || 'k'}
        provider="antigravity"
      />
    </UiPreferencesProvider>,
  );

  assert.ok(screen.getByText('Running'));
});
