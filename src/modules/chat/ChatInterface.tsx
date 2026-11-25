import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { ArrowDownIcon } from 'lucide-react';

import { useTasksSettings } from '@/modules/task-master';
import { usePaletteOpsRegister } from '@/modules/command-palette';
import { useWebSocket } from '@/shared/context/WebSocketContext';
import PermissionContext from '@/modules/chat/context/PermissionContext';
import { MarkdownWorkspaceContext } from '@/modules/chat/context/MarkdownWorkspaceContext';
import { TranscriptSessionContext } from '@/modules/chat/context/TranscriptSessionContext';
import { api, readApiErrorMessage } from '@/shared/api';
import { AgentConnections } from '@/modules/agent-connections';
import { EgressButton } from '@/modules/egress';
import { MonitorButton, TokenMonitorProvider } from '@/modules/token-monitor';
import { writeSelectedProvider } from '@/shared/selectedProvider';
import type {
  ChatMessage,
  AgentConnectionChoice,
  LLMProvider,
  Project,
  ProjectSession,
  SessionEstablishedContext,
  SessionNavigationOptions,
} from '@/shared/types';
import { useCodexFastMode } from '@/modules/chat/hooks/useCodexFastMode';
import { useChatProviderState } from '@/modules/chat/hooks/useChatProviderState';
import { useScheduledMessages } from '@/modules/chat/composer/useScheduledMessages';
import { useChatSessionState } from '@/modules/chat/hooks/useChatSessionState';
import { useChatRealtimeHandlers } from '@/modules/chat/hooks/useChatRealtimeHandlers';
import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import { useSessionStore } from '@/modules/chat/hooks/useSessionStore';
import {
  useProcessingSessions,
  useSessionProtectionActions,
} from '@/shared/context/SessionProtectionContext';
import ChatMessagesPane from '@/modules/chat/transcript/ChatMessagesPane';
import ChatComposer from '@/modules/chat/composer/ChatComposer';
import CommandResultModal from '@/modules/chat/modals/CommandResultModal';
import RecallMessageDialog, { type RecallMessageTarget } from '@/modules/chat/modals/RecallMessageDialog';
import { SESSION_MESSAGES_PAGE_SIZE } from '@/modules/chat/utils/sessionMessagePagination';

type ChatInterfaceProps = {
  isActive: boolean;
  isMobile?: boolean;
  mobileAccountSlot?: HTMLElement | null;
  mobileToolsSlot?: HTMLElement | null;
  mobileExportSlot?: HTMLElement | null;
  onCloseMobileAccount?: () => void;
  onCloseMobileControls?: () => void;
  onActiveConnectionChange?: (choice: AgentConnectionChoice | null) => void;
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  ws: WebSocket | null;
  sendMessage: (message: unknown) => void;
  onFileOpen?: (filePath: string, diffInfo?: any) => void;
  onNavigateToSession?: (targetSessionId: string, options?: SessionNavigationOptions) => void;
  onStartNewSession?: () => void;
  onSessionEstablished?: (sessionId: string, context: SessionEstablishedContext) => void;
  onShowSettings?: () => void;
  showRawParameters?: boolean;
  showThinking?: boolean;
  sendByCtrlEnter?: boolean;
  agyUseClaude?: boolean;
  agyArmor?: boolean;
  agyTransam?: boolean;
  agyFast?: boolean;
  agyThinkLang?: boolean;
  onAgyApiConnectionChange?: (usingApi: boolean) => void;
  externalMessageUpdate?: number;
  newSessionTrigger?: number;
  onTaskClick?: (...args: unknown[]) => void;
  onShowAllTasks?: (() => void) | null;
};

/**
 * Used by the project-workspace module (via the chat barrel) to render a
 * project session's chat tab; it owns the session, provider, realtime and
 * composer state that ChatMessagesPane and ChatComposer render.
 */
function ChatInterface({
  isActive,
  isMobile = false,
  mobileAccountSlot = null,
  mobileToolsSlot = null,
  mobileExportSlot = null,
  onCloseMobileAccount,
  onCloseMobileControls,
  onActiveConnectionChange,
  selectedProject,
  selectedSession,
  ws,
  sendMessage,
  onFileOpen,
  onNavigateToSession,
  onSessionEstablished,
  onShowSettings,
  showRawParameters,
  showThinking,
  sendByCtrlEnter,
  agyUseClaude = false,
  agyArmor = false,
  agyTransam = false,
  agyFast = false,
  agyThinkLang = false,
  onAgyApiConnectionChange,
  externalMessageUpdate,
  newSessionTrigger,
  onShowAllTasks,
}: ChatInterfaceProps) {
  const { tasksEnabled, isTaskMasterInstalled } = useTasksSettings();
  const { subscribe } = useWebSocket();
  const { t } = useTranslation('chat');
  // API connections own their configured model; hide the native CLI model controls for them.
  const [activeConnection, setActiveConnection] = useState<AgentConnectionChoice | null>(null);
  const processingSessions = useProcessingSessions();
  const {
    markSessionProcessing: onSessionProcessing,
    markSessionIdle: onSessionIdle,
    markSessionBackground: onSessionBackground,
    getSessionActivity,
  } = useSessionProtectionActions();

  const sessionStore = useSessionStore();
  const streamTimerRef = useRef<number | null>(null);
  const accumulatedStreamRef = useRef('');
  // When each session's `chat.subscribe` was last sent; idle acks older than
  // a later local request are discarded as stale.
  const statusCheckSentAtRef = useRef(new Map<string, number>());
  // Highest live `seq` observed per session. Written by the realtime handler
  // on every sequenced frame, read whenever a `chat.subscribe` is sent so the
  // server replays only the events this client actually missed.
  const lastSeqRef = useRef(new Map<string, number>());

  const resetStreamingState = useCallback(() => {
    if (streamTimerRef.current) {
      clearTimeout(streamTimerRef.current);
      streamTimerRef.current = null;
    }
    accumulatedStreamRef.current = '';
  }, []);

  const {
    provider,
    setProvider,
    providerModels,
    setStoredProviderModel,
    providerEfforts,
    setStoredProviderEffort,
    currentProviderEffort,
    currentProviderEffortOptions,
    currentProviderModel,
    currentProviderModelOptions,
    permissionMode,
    pendingPermissionRequests,
    setPendingPermissionRequests,
    availablePermissionModes,
    selectPermissionMode,
    cyclePermissionMode,
    providerModelCatalog,
    providerModelsLoading,
    providerModelActions,
    selectProviderModel,
    selectProviderEffort,
    resolvePermissionModeForProvider,
    supportsMessageEditing,
    supportsSessionForking,
  } = useChatProviderState({
    selectedSession,
    selectedProject,
    codexConnectionId: activeConnection?.id,
  });
  const usingApiConnection = provider === 'codex' && activeConnection?.kind === 'api';
  const agyUsingApiConnection = provider === 'antigravity' && activeConnection?.kind === 'api';
  const effectiveAgyUseClaude = agyUseClaude && !agyUsingApiConnection;

  useEffect(() => {
    onAgyApiConnectionChange?.(agyUsingApiConnection);
  }, [agyUsingApiConnection, onAgyApiConnectionChange]);

  useEffect(() => {
    onActiveConnectionChange?.(activeConnection);
  }, [activeConnection, onActiveConnectionChange]);

  const {
    chatMessages,
    addMessage,
    sessionActivity,
    isProcessing,
    canAbortSession,
    currentSessionId,
    setCurrentSessionId,
    isLoadingSessionMessages,
    isLoadingMoreMessages,
    hasMoreMessages,
    totalMessages,
    isUserScrolledUp,
    setIsUserScrolledUp,
    tokenBudget,
    setTokenBudget,
    visibleMessageCount,
    visibleMessages,
    loadEarlierMessages,
    revealMessage,
    loadAllMessages,
    loadFullTranscript,
    allMessagesLoaded,
    isLoadingAllMessages,
    loadAllJustFinished,
    showLoadAllOverlay,
    createDiff,
    scrollContainerRef,
    scrollToBottom,
    scrollToBottomAndReset,
    handleScroll,
    requestLatestMessages,
  } = useChatSessionState({
    isActive,
    selectedProject,
    selectedSession,
    ws,
    sendMessage,
    externalMessageUpdate,
    newSessionTrigger,
    processingSessions,
    onSessionIdle,
    resetStreamingState,
    statusCheckSentAtRef,
    lastSeqRef,
    sessionStore,
  });

  const handleAccountProviderChange = useCallback((next: LLMProvider) => {
    if (next !== provider) {
      writeSelectedProvider(next);
      setProvider(next);
      // The server has already handed the existing conversation to this
      // engine. Keep its id, draft and URL while updating workspace metadata.
      const sessionId = currentSessionId || selectedSession?.id;
      if (sessionId && selectedProject) {
        onSessionEstablished?.(sessionId, { provider: next, project: selectedProject, summary: selectedSession?.summary });
      }
    }
  }, [currentSessionId, onSessionEstablished, provider, selectedProject, selectedSession, setProvider]);

  const supportsFastMode = provider === 'codex' && !usingApiConnection;
  const { fastMode, selectFastMode, fastModePending, fastModeError } = useCodexFastMode(
    currentSessionId || selectedSession?.id || null, supportsFastMode,
  );

  // Brand-new conversation: the composer allocated a stable session id via
  // the session gateway before the first send. Record it locally and put it
  // in the URL — this id never changes again, so there is no later handoff.
  const handleSessionEstablished = useCallback<NonNullable<ChatInterfaceProps['onSessionEstablished']>>((sessionId, context) => {
    setCurrentSessionId(sessionId);
    onSessionEstablished?.(sessionId, context);
    onNavigateToSession?.(sessionId);
  }, [setCurrentSessionId, onSessionEstablished, onNavigateToSession]);

  const {
    input,
    setInput,
    textareaRef,
    inputHighlightRef,
    isTextareaExpanded,
    slashCommandsCount,
    filteredCommands,
    frequentCommands,
    commandQuery,
    showCommandMenu,
    selectedCommandIndex,
    resetCommandMenuState,
    handleCommandSelect,
    handleToggleCommandMenu,
    showFileDropdown,
    filteredFiles,
    selectedFileIndex,
    renderInputWithMentions,
    selectFile,
    attachedFiles,
    setAttachedFiles,
    fileErrors,
    getRootProps,
    getInputProps,
    isDragActive,
    openAttachmentPicker,
    handleSubmit,
    backgroundSendPrompt,
    resolveBackgroundSendPrompt,
    queuedDraft,
    editQueuedDraft,
    deleteQueuedDraft,
    handleVoiceTranscript,
    handleInputChange,
    handleKeyDown,
    handlePaste,
    handleTextareaClick,
    handleTextareaInput,
    syncInputOverlayScroll,
    handleClearInput,
    handleAbortSession,
    handlePermissionDecision,
    handleGrantToolPermission,
    handleInputFocusChange,
    isInputFocused,
    commandModalPayload,
    closeCommandModal,
    showCostModal,
    editingAnchorId,
    beginEditMessage,
    cancelEditMessage,
    loadRecalledInput,
  } = useChatComposerState({
    selectedProject,
    selectedSession,
    currentSessionId,
    connectionId: activeConnection?.accountId,
    provider,
    permissionMode,
    cyclePermissionMode,
    currentProviderModel,
    currentProviderEffort,
    fastMode: supportsFastMode ? fastMode : undefined,
    agyUseClaude: effectiveAgyUseClaude,
    agyArmor: agyArmor,
    agyTransam: agyTransam,
    agyFast: agyFast,
    agyThinkLang: agyThinkLang,
    isLoading: isProcessing,
    processingSessions,
    canAbortSession,
    tokenBudget,
    sendMessage,
    sendByCtrlEnter,
    onSessionProcessing,
    onSessionEstablished: handleSessionEstablished,
    onFileOpen,
    onShowSettings,
    scrollToBottom,
    addMessage,
    setIsUserScrolledUp,
    setPendingPermissionRequests,
    resolvePermissionModeForProvider,
  });

  // On WebSocket reconnect, request a bounded persisted-tail sync (deferred
  // while Chat is hidden), then re-subscribe — the
  // `chat_subscribed` ack restores or clears the activity indicator, replays
  // missed live events, and re-attaches a still-running stream to this socket.
  const handleWebSocketReconnect = useCallback(async () => {
    if (!selectedProject || !selectedSession) return;
    await requestLatestMessages(selectedSession.id, isActive);
    statusCheckSentAtRef.current.set(selectedSession.id, Date.now());
    sendMessage({
      type: 'chat.subscribe',
      sessions: [{
        sessionId: selectedSession.id,
        lastSeq: lastSeqRef.current.get(selectedSession.id) ?? 0,
      }],
    });
  }, [isActive, requestLatestMessages, selectedProject, selectedSession, sendMessage]);

  useChatRealtimeHandlers({
    isActive,
    subscribe,
    provider,
    selectedSession,
    currentSessionId,
    setTokenBudget,
    pendingPermissionRequests,
    setPendingPermissionRequests,
    streamTimerRef,
    accumulatedStreamRef,
    lastSeqRef,
    statusCheckSentAtRef,
    onSessionProcessing,
    onSessionIdle,
    onSessionBackground,
    getSessionActivity,
    onWebSocketReconnect: handleWebSocketReconnect,
    requestLatestMessages,
    sessionStore,
  });

  // Lets other modules (the quick settings Commands tab) hand text to the
  // composer: append it after a separating space, then focus the textarea with
  // the caret at the end once React has rendered the new value.
  const insertComposerText = useCallback((text: string) => {
    setInput((previous) => {
      const separator = previous && !/\s$/.test(previous) ? ' ' : '';
      return `${previous}${separator}${text}`;
    });
    window.requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) {
        return;
      }
      textarea.focus();
      const caretPosition = textarea.value.length;
      textarea.setSelectionRange(caretPosition, caretPosition);
    });
  }, [setInput, textareaRef]);

  usePaletteOpsRegister({ insertComposerText });

  const [recallTarget, setRecallTarget] = useState<(RecallMessageTarget & { sessionId: string }) | null>(null);
  const [isRecallingMessage, setIsRecallingMessage] = useState(false);
  const [recallError, setRecallError] = useState<string | null>(null);
  const activeSessionId = currentSessionId || selectedSession?.id || null;
  const activeRecallTarget = recallTarget && recallTarget.sessionId === activeSessionId
    ? recallTarget
    : null;

  useEffect(() => {
    if (!canAbortSession || activeRecallTarget) {
      return;
    }

    const handleGlobalEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.repeat || event.defaultPrevented) {
        return;
      }

      event.preventDefault();
      handleAbortSession();
    };

    document.addEventListener('keydown', handleGlobalEscape, { capture: true });
    return () => {
      document.removeEventListener('keydown', handleGlobalEscape, { capture: true });
    };
  }, [activeRecallTarget, canAbortSession, handleAbortSession]);

  useEffect(() => {
    return () => {
      resetStreamingState();
    };
  }, [resetStreamingState]);

  const handleRequestRecallMessage = useCallback((message: ChatMessage) => {
    if (!activeSessionId) return;
    const userMessages = chatMessages.filter((item) => item.type === 'user');
    let userIndex = userMessages.lastIndexOf(message);
    if (userIndex < 0 && message.transcriptAnchorId) {
      userIndex = userMessages.findIndex(
        (item) => item.transcriptAnchorId === message.transcriptAnchorId,
      );
    }
    if (userIndex < 0 && message.modelSourceId) {
      userIndex = userMessages.findIndex(
        (item) => item.modelSourceId === message.modelSourceId,
      );
    }
    if (userIndex < 0) return;

    const userTurnFromEnd = userMessages.length - 1 - userIndex;
    setRecallError(null);
    setRecallTarget({
      sessionId: activeSessionId,
      message,
      isLatestUserMessage: userTurnFromEnd === 0,
      userTurnFromEnd,
    });
  }, [activeSessionId, chatMessages]);

  const handleCancelRecallMessage = useCallback(() => {
    if (isRecallingMessage) return;
    setRecallTarget(null);
    setRecallError(null);
  }, [isRecallingMessage]);

  const handleConfirmRecallMessage = useCallback(async () => {
    if (!activeRecallTarget || !activeSessionId || isRecallingMessage) return;

    setIsRecallingMessage(true);
    setRecallError(null);
    try {
      const { message, userTurnFromEnd } = activeRecallTarget;
      const response = await api.recallSessionMessage(activeSessionId, {
        ...(message.transcriptAnchorId ? { anchorId: message.transcriptAnchorId } : {}),
        ...(message.modelSourceId ? { messageId: message.modelSourceId } : {}),
        userTurnFromEnd,
        content: message.content || '',
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(
          readApiErrorMessage(payload)
          || t('message.recallFailed', { defaultValue: 'Failed to recall message. Please try again.' }),
        );
      }

      resetStreamingState();
      onSessionIdle(activeSessionId);
      setPendingPermissionRequests((previous) =>
        previous.filter((request) => request.sessionId !== activeSessionId),
      );
      lastSeqRef.current.delete(activeSessionId);

      await sessionStore.resetAndFetchFromServer(activeSessionId, {
        limit: SESSION_MESSAGES_PAGE_SIZE,
        offset: 0,
      });

      const recalledContent = typeof payload?.data?.recalledContent === 'string'
        ? payload.data.recalledContent
        : (message.content || '');
      setRecallTarget(null);
      loadRecalledInput(recalledContent);
    } catch (error) {
      console.error('Error recalling message:', error);
      setRecallError(
        error instanceof Error && error.message
          ? error.message
          : t('message.recallFailed', { defaultValue: 'Failed to recall message. Please try again.' }),
      );
    } finally {
      setIsRecallingMessage(false);
    }
  }, [
    activeRecallTarget,
    activeSessionId,
    isRecallingMessage,
    loadRecalledInput,
    onSessionIdle,
    resetStreamingState,
    sessionStore,
    setPendingPermissionRequests,
    t,
  ]);

  /**
   * Branches the conversation into a new session that ends at this message,
   * then opens it. The session being viewed is left exactly as it was.
   */
  const handleForkFromMessage = useCallback(async (message: ChatMessage) => {
    const anchorId = message.transcriptAnchorId;
    const sourceSessionId = selectedSession?.id;
    if (!anchorId || !sourceSessionId) return;

    try {
      const response = await api.forkSession(sourceSessionId, { upToAnchorId: anchorId });
      const payload = await response.json();
      const forkedSessionId = payload?.data?.sessionId;
      if (!response.ok || typeof forkedSessionId !== 'string') {
        throw new Error(payload?.message || `HTTP ${response.status}`);
      }
      onNavigateToSession?.(forkedSessionId);
    } catch (error) {
      console.error('Error forking session:', error);
    }
  }, [onNavigateToSession, selectedSession?.id]);

  const { scheduledMessages, schedule: scheduleMessage, cancel: cancelScheduledMessage } =
    useScheduledMessages(currentSessionId || selectedSession?.id || null, subscribe);

  /**
   * Hands the composer's current text to the server to send later, and clears
   * the box as a send would — the message has left the composer either way.
   */
  const handleScheduleMessage = useCallback(async (scheduledFor: Date) => {
    const content = input.trim();
    if (!content) return;

    const scheduled = await scheduleMessage({
      content,
      scheduledFor,
      options: { model: currentProviderModel, effort: currentProviderEffort, permissionMode,
        ...(supportsFastMode && fastMode !== undefined ? { fastMode } : {}),
        ...(provider === 'antigravity' && effectiveAgyUseClaude ? { useClaudeAgy: true } : {}),
        ...(provider === 'antigravity' && agyArmor ? { useArmor: true } : {}),
        ...(provider === 'antigravity' && agyTransam ? { useTransam: true } : {}),
        ...(provider === 'antigravity' && agyFast ? { useAgyFast: true } : {}),
        ...(provider === 'antigravity' && agyThinkLang ? { useThinkLang: true } : {}) },
    });
    if (scheduled) {
      setInput('');
    }
  }, [effectiveAgyUseClaude, agyArmor, agyTransam, agyFast, agyThinkLang, currentProviderEffort, currentProviderModel, input, permissionMode, provider, scheduleMessage, setInput, supportsFastMode, fastMode]);

  const permissionContextValue = useMemo(() => ({
    pendingPermissionRequests,
    handlePermissionDecision,
  }), [pendingPermissionRequests, handlePermissionDecision]);

  // Lets markdown image paths in the transcript resolve against this project.
  const markdownWorkspaceValue = useMemo(() => ({
    projectId: selectedProject?.projectId ?? null,
  }), [selectedProject?.projectId]);

  // Lets a workflow card fetch its agents' timelines for this session.
  const transcriptSessionValue = useMemo(() => ({ sessionId: currentSessionId }), [currentSessionId]);

  // A composer pick becomes the default for new chats and, when a session is
  // open, is recorded against that session so reopening it restores this model.
  const handleSelectComposerModel = useCallback(async (model: string) => {
    try {
      await selectProviderModel(provider, model, currentSessionId || selectedSession?.id || null);
    } catch (error) {
      console.error('Error changing the active session model:', error);
    }
  }, [currentSessionId, provider, selectProviderModel, selectedSession?.id]);

  const handleSelectComposerEffort = useCallback(async (effort: string) => {
    try {
      await selectProviderEffort(provider, effort, currentSessionId || selectedSession?.id || null);
    } catch (error) {
      console.error('Error changing the active session reasoning effort:', error);
    }
  }, [currentSessionId, provider, selectProviderEffort, selectedSession?.id]);

  const handleSelectComposerModelAndEffort = useCallback(async (nextModel: string, nextEffort: string) => {
    const targetSessionId = currentSessionId || selectedSession?.id || null;
    try {
      await selectProviderModel(provider, nextModel, targetSessionId);
      await selectProviderEffort(provider, nextEffort, targetSessionId);
    } catch (error) {
      console.error('Error changing the active session model and reasoning effort:', error);
    }
  }, [currentSessionId, provider, selectProviderEffort, selectProviderModel, selectedSession?.id]);

  // Mirrors ChatComposer's own visibility check so the message pane can
  // reserve enough bottom space to keep the floating status tab from
  // overlapping the last message.
  const hasActivityIndicator = Boolean(sessionActivity && pendingPermissionRequests.length === 0);

  const selectedProviderLabel =
    provider === 'antigravity' ? 'agy' : provider === 'cursor'
      ? t('messageTypes.cursor')
      : provider === 'codex'
        ? t('messageTypes.codex')
        : provider === 'opencode'
            ? t('messageTypes.opencode', { defaultValue: 'OpenCode' })
          : t('messageTypes.claude');

  if (!selectedProject) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center text-muted-foreground">
          <p className="text-sm">
            {t('projectSelection.startChatWithProvider', {
              provider: selectedProviderLabel,
              defaultValue: 'Select a project to start chatting with {{provider}}',
            })}
          </p>
        </div>
      </div>
    );
  }


  return (
    <TokenMonitorProvider sessionId={selectedSession?.id || currentSessionId} model={currentProviderModel}>
    <PermissionContext.Provider value={permissionContextValue}>
      <div className="flex h-full min-h-0 flex-col">
        <AgentConnections
          provider={provider}
          sessionId={selectedSession?.id || currentSessionId}
          disabled={isProcessing}
          onChoice={setActiveConnection}
          onProviderChange={handleAccountProviderChange}
          mobileFolded={isMobile}
          mobileSlot={mobileAccountSlot}
          onOpenManager={onCloseMobileAccount}
        />
        {isMobile && (
          <>
            <EgressButton
              connectionId={activeConnection?.id}
              variant="card"
              triggerSlot={mobileToolsSlot}
              onBeforeOpen={onCloseMobileControls}
            />
            {mobileToolsSlot && createPortal(
              <MonitorButton variant="card" onBeforeOpen={onCloseMobileControls} />,
              mobileToolsSlot,
            )}
          </>
        )}
        <MarkdownWorkspaceContext.Provider value={markdownWorkspaceValue}>
          <TranscriptSessionContext.Provider value={transcriptSessionValue}>
            <ChatMessagesPane
              isMobile={isMobile}
              mobileExportSlot={mobileExportSlot}
              scrollContainerRef={scrollContainerRef}
              // Not redundant with the `scroll` listener. A first page is 20 rows,
              // tool results fold into their calls, and the "load earlier" link is
              // hidden while more pages exist — so a short transcript is often not
              // scrollable at all and never emits `scroll`. Wheel and touch are
              // then the only way to reach the top pager or the "load all" overlay.
              onWheel={handleScroll}
              onTouchMove={handleScroll}
              isLoadingSessionMessages={isLoadingSessionMessages}
              isProcessing={isProcessing}
              hasActivityIndicator={hasActivityIndicator}
              chatMessages={chatMessages}
              selectedSession={selectedSession}
              currentSessionId={currentSessionId}
              provider={provider}
              setProvider={setProvider}
              textareaRef={textareaRef}
              providerModels={providerModels}
              setProviderModel={setStoredProviderModel}
              providerEfforts={providerEfforts}
              setProviderEffort={setStoredProviderEffort}
              allowOptionEffort={!usingApiConnection}
              providerModelCatalog={providerModelCatalog}
              providerModelActions={providerModelActions}
              providerModelsLoading={providerModelsLoading}
              tasksEnabled={tasksEnabled}
              isTaskMasterInstalled={isTaskMasterInstalled}
              onShowAllTasks={onShowAllTasks}
              setInput={setInput}
              isLoadingMoreMessages={isLoadingMoreMessages}
              hasMoreMessages={hasMoreMessages}
              totalMessages={totalMessages}
              sessionMessagesCount={chatMessages.length}
              visibleMessageCount={visibleMessageCount}
              visibleMessages={visibleMessages}
              loadEarlierMessages={loadEarlierMessages}
              revealMessage={revealMessage}
              backgroundTasks={sessionActivity?.tasks}
              sendMessage={sendMessage}
              loadAllMessages={loadAllMessages}
              allMessagesLoaded={allMessagesLoaded}
              isLoadingAllMessages={isLoadingAllMessages}
              loadAllJustFinished={loadAllJustFinished}
              showLoadAllOverlay={showLoadAllOverlay}
              createDiff={createDiff}
              onFileOpen={onFileOpen}
              onShowSettings={onShowSettings}
              onGrantToolPermission={handleGrantToolPermission}
              showRawParameters={showRawParameters}
              showThinking={showThinking}
              selectedProject={selectedProject}
              // Editing replaces the turn and everything after it, so it is only
              // offered when the session is idle — a half-truncated transcript with
              // a live stream writing into it is not recoverable.
              onEditMessage={supportsMessageEditing && !isProcessing ? beginEditMessage : undefined}
              onForkFromMessage={supportsSessionForking ? handleForkFromMessage : undefined}
              onRecallMessage={activeSessionId ? handleRequestRecallMessage : undefined}
              onLoadFullTranscript={loadFullTranscript}
            />
          </TranscriptSessionContext.Provider>
        </MarkdownWorkspaceContext.Provider>

        <div className="relative flex-shrink-0">
          {isUserScrolledUp && chatMessages.length > 0 && (
            <div className="pointer-events-none absolute -top-11 left-0 right-0 z-20 flex justify-center">
              <button
                type="button"
                onClick={scrollToBottomAndReset}
                aria-label={t('input.scrollToBottom', { defaultValue: 'Scroll to bottom' })}
                className="pointer-events-auto flex h-8 w-8 items-center justify-center rounded-full border border-border/50 bg-card text-muted-foreground shadow-sm transition-all duration-200 hover:bg-accent hover:text-foreground"
                title={t('input.scrollToBottom', { defaultValue: 'Scroll to bottom' })}
              >
                <ArrowDownIcon className="h-4 w-4" aria-hidden />
              </button>
            </div>
          )}

          <ChatComposer
          pendingPermissionRequests={pendingPermissionRequests}
          handlePermissionDecision={handlePermissionDecision}
          handleGrantToolPermission={handleGrantToolPermission}
          activity={sessionActivity}
          isLoading={isProcessing}
          onAbortSession={handleAbortSession}
          permissionMode={permissionMode}
          availablePermissionModes={availablePermissionModes}
          onSelectPermissionMode={selectPermissionMode}
          providerLabel={selectedProviderLabel}
          supportsFastMode={supportsFastMode}
          fastMode={fastMode === true}
          fastModePending={fastModePending}
          fastModeError={fastModeError}
          onSelectFastMode={selectFastMode}
          effort={currentProviderEffort}
          availableEffortOptions={usingApiConnection ? [] : currentProviderEffortOptions}
          onSelectEffort={handleSelectComposerEffort}
          model={currentProviderModel}
          availableModelOptions={currentProviderModelOptions}
          onSelectModel={handleSelectComposerModel}
          onSelectModelAndEffort={handleSelectComposerModelAndEffort}
          allowOptionEffort={!usingApiConnection}
          modelsLoading={providerModelsLoading}
          tokenBudget={tokenBudget}
          onShowTokenUsage={showCostModal}
          isEditingSentMessage={Boolean(editingAnchorId)}
          onCancelEditMessage={cancelEditMessage}
          scheduledMessages={scheduledMessages}
          onScheduleMessage={handleScheduleMessage}
          onCancelScheduledMessage={cancelScheduledMessage}
          slashCommandsCount={slashCommandsCount}
          onToggleCommandMenu={handleToggleCommandMenu}
          hasInput={Boolean(input.trim())}
          onClearInput={handleClearInput}
          onSubmit={handleSubmit}
          isDragActive={isDragActive}
          queuedDraft={queuedDraft}
          backgroundSendPrompt={backgroundSendPrompt}
          onResolveBackgroundSendPrompt={resolveBackgroundSendPrompt}
          onEditQueuedDraft={editQueuedDraft}
          onDeleteQueuedDraft={deleteQueuedDraft}
          attachedFiles={attachedFiles}
          onRemoveAttachment={(index) =>
            setAttachedFiles((previous) =>
              previous.filter((_, currentIndex) => currentIndex !== index),
            )
          }
          fileErrors={fileErrors}
          showFileDropdown={showFileDropdown}
          filteredFiles={filteredFiles}
          selectedFileIndex={selectedFileIndex}
          onSelectFile={selectFile}
          filteredCommands={filteredCommands}
          selectedCommandIndex={selectedCommandIndex}
          onCommandSelect={handleCommandSelect}
          onCloseCommandMenu={resetCommandMenuState}
          isCommandMenuOpen={showCommandMenu}
          frequentCommands={commandQuery ? [] : frequentCommands}
          getRootProps={getRootProps as (...args: unknown[]) => Record<string, unknown>}
          getInputProps={getInputProps as (...args: unknown[]) => Record<string, unknown>}
          openAttachmentPicker={openAttachmentPicker}
          inputHighlightRef={inputHighlightRef}
          renderInputWithMentions={renderInputWithMentions}
          textareaRef={textareaRef}
          input={input}
          onVoiceTranscript={handleVoiceTranscript}
          onInputChange={handleInputChange}
          onTextareaClick={handleTextareaClick}
          onTextareaKeyDown={handleKeyDown}
          onTextareaPaste={handlePaste}
          onTextareaScrollSync={syncInputOverlayScroll}
          onTextareaInput={handleTextareaInput}
          isInputFocused={isInputFocused}
          onInputFocusChange={handleInputFocusChange}
          placeholder={t('input.placeholder', { provider: selectedProviderLabel })}
          isTextareaExpanded={isTextareaExpanded}
          sendByCtrlEnter={sendByCtrlEnter}
        />
        </div>
      </div>

      <RecallMessageDialog
        target={activeRecallTarget}
        isSubmitting={isRecallingMessage}
        error={activeRecallTarget ? recallError : null}
        onCancel={handleCancelRecallMessage}
        onConfirm={handleConfirmRecallMessage}
      />

      <CommandResultModal
        payload={commandModalPayload}
        onClose={closeCommandModal}
        providerModelCatalog={providerModelCatalog}
        providerModelActions={providerModelActions}
        activeProvider={provider}
        activeProviderModel={currentProviderModel}
        currentSessionId={currentSessionId || selectedSession?.id || null}
        onSelectProviderModel={selectProviderModel}
      />
    </PermissionContext.Provider>
    </TokenMonitorProvider>
  );
}

export default React.memo(ChatInterface);
