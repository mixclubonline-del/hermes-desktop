import { useCallback, useEffect, useRef, useState } from "react";
import { ChatInput, type ChatInputHandle } from "./ChatInput";
import { ChatHeader } from "./ChatHeader";
import { ChatEmptyState } from "./ChatEmptyState";
import { MessageList } from "./MessageList";
import { ModelPicker } from "./ModelPicker";
import { ReasoningEffortPicker } from "./ReasoningEffortPicker";
import { ContextFolderChip } from "./ContextFolderChip";
import { WorktreePanel } from "./WorktreePanel";
import { useChatScroll } from "./hooks/useChatScroll";
import { useChatIPC } from "./hooks/useChatIPC";
import { useChatActions } from "./hooks/useChatActions";
import { useModelConfig } from "./hooks/useModelConfig";
import { useFastMode } from "./hooks/useFastMode";
import { useReasoningEffort } from "./hooks/useReasoningEffort";
import { useLocalCommands } from "./hooks/useLocalCommands";
import { useI18n } from "../../components/useI18n";
import { buildChatTranscript } from "./transcriptUtils";
import { ConfigHealthBanner } from "../../components/ConfigHealthBanner";
import type { Attachment } from "../../../../shared/attachments";
import type { ChatMessage, UsageState } from "./types";
import type { ContextUsage } from "./ContextGauge";
import { contextWindowForModel } from "./contextWindows";
import { QueuedMessages } from "./QueuedMessages";

interface QueuedMessage {
  text: string;
  attachments: Attachment[];
}

export type { ChatMessage } from "./types";

interface ChatProps {
  messages: ChatMessage[];
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  sessionId: string | null;
  profile?: string;
  onSessionStarted?: () => void;
  onNewChat?: () => void;
  /** Optional callback to navigate to Settings → Diagnose section
   *  when the user clicks "Show details" in the config-health banner. */
  onOpenDiagnose?: () => void;
}

function Chat({
  messages,
  setMessages,
  sessionId,
  profile,
  onSessionStarted,
  onNewChat,
  onOpenDiagnose,
}: ChatProps): React.JSX.Element {
  const { t } = useI18n();
  const [isLoading, setIsLoading] = useState(false);
  const [hermesSessionId, setHermesSessionId] = useState<string | null>(null);
  const [toolProgress, setToolProgress] = useState<string | null>(null);
  const [usage, setUsage] = useState<UsageState | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [remoteMode, setRemoteMode] = useState(false);
  // Working folder bound to this conversation (issue #27). Per-conversation,
  // held in memory; reset on session switch / new chat below.
  const [contextFolder, setContextFolder] = useState<string | null>(null);
  // Whether the worktree panel is visible (only applies when contextFolder is set)
  const [worktreeVisible, setWorktreeVisible] = useState<boolean>(true);
  const dragCounter = useRef(0);
  const chatInputRef = useRef<ChatInputHandle>(null);
  const queueRef = useRef<QueuedMessage[]>([]);
  const [queuedMessages, setQueuedMessages] = useState<QueuedMessage[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async (): Promise<void> => {
      const flag = await window.hermesAPI.isRemoteMode();
      if (!cancelled) setRemoteMode(flag);
    })();
    return (): void => {
      cancelled = true;
    };
  }, []);

  const { containerRef, bottomRef } = useChatScroll(messages);
  const modelConfig = useModelConfig(profile);
  const {
    fastMode,
    toggle: toggleFastMode,
    set: setFastTier,
  } = useFastMode(profile);
  const { reasoningEffort, setReasoningEffort } = useReasoningEffort(profile);

  // Pre-send readiness — fail-open check that disables Send + shows
  // an inline banner when the desktop can predict that the gateway
  // will reject the request (e.g. provider configured but its API
  // key is missing from .env). Re-runs on profile/model/baseUrl
  // change so the banner reflects the current state.
  const [readiness, setReadiness] = useState<{
    ok: boolean;
    code?: string;
    message?: string;
    fixLocation?: string;
    expectedEnvKey?: string;
  }>({ ok: true });
  useEffect(() => {
    let cancelled = false;
    (async (): Promise<void> => {
      try {
        const r = await window.hermesAPI.validateChatReadiness(profile);
        if (!cancelled) setReadiness(r);
      } catch {
        // Fail open on IPC error — never block Send on validation failure
        if (!cancelled) setReadiness({ ok: true });
      }
    })();
    return (): void => {
      cancelled = true;
    };
  }, [
    profile,
    modelConfig.currentModel,
    modelConfig.currentProvider,
    modelConfig.currentBaseUrl,
  ]);

  // Authoritative context-window size for the active model, resolved from the
  // provider's /models catalogue (issue #597). Null until/unless the provider
  // advertises it — the gauge then falls back to the static heuristic.
  const [realContextWindow, setRealContextWindow] = useState<number | null>(
    null,
  );
  useEffect(() => {
    let cancelled = false;
    setRealContextWindow(null);
    if (!modelConfig.currentModel) return;
    window.hermesAPI
      .getModelContextWindow(
        modelConfig.currentProvider,
        modelConfig.currentModel,
        modelConfig.currentBaseUrl,
        profile,
      )
      .then((w) => {
        if (!cancelled && typeof w === "number" && w > 0) {
          setRealContextWindow(w);
        }
      })
      .catch(() => {
        /* fall back to heuristic */
      });
    return (): void => {
      cancelled = true;
    };
  }, [
    profile,
    modelConfig.currentModel,
    modelConfig.currentProvider,
    modelConfig.currentBaseUrl,
  ]);

  useChatIPC({
    setMessages,
    setHermesSessionId,
    setToolProgress,
    setIsLoading,
    setUsage,
  });

  // Reset hermes session when the parent clears messages (new chat).
  // Effect-driven sync because `messages` is owned by the parent; a key-based
  // remount would discard unrelated local state (model picker, etc.).
  useEffect(() => {
    if (messages.length === 0) {
      setHermesSessionId(null);
      setContextFolder(null);
      queueRef.current = [];
      setQueuedMessages([]);
    }
  }, [messages]);

  // When the parent swaps to a different session, sync local state to it:
  // the gateway session id (a stale one resumes/deletes the WRONG session —
  // issue #276) and the per-conversation context folder (issue #27). Chat is
  // not remounted on session switch, so this must be done explicitly.
  useEffect(() => {
    setHermesSessionId(sessionId);
    setContextFolder(null);
    queueRef.current = [];
    setQueuedMessages([]);
  }, [sessionId]);

  // Cmd/Ctrl+N → new chat
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if ((e.metaKey || e.ctrlKey) && e.key === "n") {
        e.preventDefault();
        onNewChat?.();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onNewChat]);

  // "Copy entire chat" context-menu items (issue #298) — serialise the whole
  // conversation in the requested format and copy it. A ref keeps the latest
  // messages without re-registering the IPC listener on every chunk.
  const messagesRef = useRef(messages);
  useEffect(() => {
    messagesRef.current = messages;
  });
  useEffect(() => {
    return window.hermesAPI.onContextMenuCopyChat((format) => {
      const msgs = messagesRef.current;
      if (msgs.length === 0) return;
      void window.hermesAPI.copyToClipboard(buildChatTranscript(msgs, format));
    });
  }, []);

  // "Select All" on a message (issue #298): the native selectAll role would
  // select the entire window, so scope it to the .chat-bubble under the
  // cursor — the user can then Copy that message.
  useEffect(() => {
    return window.hermesAPI.onContextMenuSelectBubble(({ x, y }) => {
      const bubble = document.elementFromPoint(x, y)?.closest(".chat-bubble");
      if (!bubble) return;
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.selectAllChildren(bubble);
    });
  }, []);

  // Restrict the native context menu to chat bubbles and editable fields
  // so it doesn't appear on random UI chrome (sessions list, settings, etc.).
  useEffect(() => {
    const onContextMenu = (e: MouseEvent): void => {
      const target = e.target as Element | null;
      const inBubble = target?.closest(".chat-bubble") != null;
      const inEditable =
        target?.closest("input, textarea, [contenteditable='true']") != null;
      if (!inBubble && !inEditable) {
        e.preventDefault();
      }
    };
    document.addEventListener("contextmenu", onContextMenu);
    return () => document.removeEventListener("contextmenu", onContextMenu);
  }, []);

  const addAgentMessage = useCallback(
    (content: string) => {
      setMessages((prev) => [
        ...prev,
        { id: `agent-local-${Date.now()}`, role: "agent", content },
      ]);
    },
    [setMessages],
  );

  // Flip an inline clarify card to its resolved (read-only) state once the user
  // has answered or skipped. The gateway resumes the turn from here, so loading
  // stays active until the next onChatDone.
  const handleClarifyResolved = useCallback(
    (requestId: string, answer: string) => {
      setMessages((prev) =>
        prev.map((m) =>
          m.kind === "clarify" && m.requestId === requestId
            ? { ...m, answer, resolved: true }
            : m,
        ),
      );
    },
    [setMessages],
  );

  const handleClear = useCallback(() => {
    if (isLoading) {
      window.hermesAPI.abortChat();
      setIsLoading(false);
    }
    const idToDelete = hermesSessionId ?? sessionId;
    if (idToDelete) {
      void window.hermesAPI.deleteSession(idToDelete);
      void window.hermesAPI.clearStagedAttachments(idToDelete);
    }
    setMessages([]);
    setHermesSessionId(null);
    setContextFolder(null);
    setUsage(null);
    setToolProgress(null);
    queueRef.current = [];
    setQueuedMessages([]);
  }, [isLoading, hermesSessionId, sessionId, setMessages]);

  const localCommands = useLocalCommands({
    profile,
    usage,
    setFastMode: setFastTier,
    onNewChat,
    onClear: handleClear,
    addAgentMessage,
  });

  const actions = useChatActions({
    profile,
    hermesSessionId,
    messages,
    isLoading,
    setIsLoading,
    setMessages,
    onSessionStarted,
    chatInputRef,
    localCommands,
    contextFolder,
  });

  // Stable ref to handleSend so the drain effect doesn't re-trigger on
  // identity changes (regression #5 from PR #315).
  const handleSendRef = useRef(actions.handleSend);
  useEffect(() => {
    handleSendRef.current = actions.handleSend;
  });

  // Drain queued messages one at a time when the agent finishes.
  useEffect(() => {
    if (isLoading) return;
    const next = queueRef.current.shift();
    if (!next) return;
    setQueuedMessages([...queueRef.current]);
    handleSendRef.current(next.text, next.attachments, true).catch(() => {
      // Put the message back at the front so it isn't silently lost if
      // the send fails (e.g. IPC error before onChatError fires).
      queueRef.current.unshift(next);
      setQueuedMessages([...queueRef.current]);
    });
  }, [isLoading]);

  const handleRemoveQueued = useCallback((index: number) => {
    queueRef.current.splice(index, 1);
    setQueuedMessages([...queueRef.current]);
  }, []);

  const handleSubmitOrQueue = useCallback(
    (text: string, attachments: Attachment[]) => {
      if (isLoading) {
        queueRef.current.push({ text, attachments });
        setQueuedMessages([...queueRef.current]);
        return;
      }
      void handleSendRef.current(text, attachments);
    },
    [isLoading],
  );

  const handleSuggestion = useCallback((text: string) => {
    chatInputRef.current?.setText(text);
  }, []);

  const handlePickFolder = useCallback(async () => {
    const path = await window.hermesAPI.selectFolder();
    if (path) setContextFolder(path);
  }, []);

  const handleClearFolder = useCallback(() => {
    setContextFolder(null);
  }, []);

  // Drag-and-drop: filter for dragenter events carrying files (suppresses
  // text-drag noise from the textarea autocomplete and other in-app drags).
  const eventHasFiles = useCallback((e: React.DragEvent): boolean => {
    const types = e.dataTransfer?.types;
    if (!types) return false;
    for (let i = 0; i < types.length; i++) {
      if (types[i] === "Files") return true;
    }
    return false;
  }, []);

  const handleDragEnter = useCallback(
    (e: React.DragEvent) => {
      if (!eventHasFiles(e)) return;
      e.preventDefault();
      dragCounter.current += 1;
      if (dragCounter.current === 1) setDragActive(true);
    },
    [eventHasFiles],
  );

  const handleDragOver = useCallback(
    (e: React.DragEvent) => {
      if (!eventHasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    },
    [eventHasFiles],
  );

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current = Math.max(0, dragCounter.current - 1);
    if (dragCounter.current === 0) setDragActive(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      if (!eventHasFiles(e)) return;
      e.preventDefault();
      dragCounter.current = 0;
      setDragActive(false);
      const files = Array.from(e.dataTransfer.files);
      if (files.length === 0) return;
      void chatInputRef.current?.addFiles(files);
    },
    [eventHasFiles],
  );

  // Context-gauge data: the latest turn's prompt tokens vs the model's window.
  const contextUsage: ContextUsage | null = usage?.contextTokens
    ? {
        used: usage.contextTokens,
        window:
          realContextWindow ?? contextWindowForModel(modelConfig.currentModel),
        cacheReadTokens: usage.cacheReadTokens,
        cacheWriteTokens: usage.cacheWriteTokens,
      }
    : null;

  return (
    <div
      className="chat-container"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <ChatHeader
        sessionId={sessionId}
        usage={usage}
        fastMode={fastMode}
        hasMessages={messages.length > 0}
        onToggleFast={toggleFastMode}
        onNewChat={onNewChat}
        onClear={handleClear}
      />

      <ConfigHealthBanner profile={profile} onOpenDiagnose={onOpenDiagnose} />

      <div className="chat-body">
        <div className="chat-messages" ref={containerRef}>
          {messages.length === 0 ? (
            <ChatEmptyState onSelectSuggestion={handleSuggestion} />
          ) : (
            <MessageList
              messages={messages}
              isLoading={isLoading}
              toolProgress={toolProgress}
              onApprove={actions.handleApprove}
              onDeny={actions.handleDeny}
              onClarifyResolved={handleClarifyResolved}
            />
          )}
          <div ref={bottomRef} />
        </div>

        {contextFolder && worktreeVisible && (
          <WorktreePanel folderPath={contextFolder} />
        )}
      </div>

      <div className="chat-input-area">
        <QueuedMessages messages={queuedMessages} onRemove={handleRemoveQueued} />
        <ChatInput
          ref={chatInputRef}
          isLoading={isLoading}
          hasSession={!!hermesSessionId}
          sessionId={hermesSessionId}
          remoteMode={remoteMode}
          profile={profile}
          contextUsage={contextUsage}
          readiness={readiness}
          onSubmit={handleSubmitOrQueue}
          onQuickAsk={actions.handleQuickAsk}
          onAbort={actions.handleAbort}
          toolbarExtras={
            <>
              <ModelPicker
                currentModel={modelConfig.currentModel}
                currentProvider={modelConfig.currentProvider}
                currentBaseUrl={modelConfig.currentBaseUrl}
                modelGroups={modelConfig.modelGroups}
                displayModel={modelConfig.displayModel}
                onOpen={modelConfig.reload}
                onSelectModel={modelConfig.selectModel}
              />
              <ReasoningEffortPicker
                value={reasoningEffort}
                onChange={setReasoningEffort}
              />
              <ContextFolderChip
                contextFolder={contextFolder}
                show={!remoteMode}
                worktreeVisible={worktreeVisible}
                onPickFolder={handlePickFolder}
                onClearFolder={handleClearFolder}
                onToggleWorktree={() => setWorktreeVisible((v) => !v)}
              />
            </>
          }
        />
      </div>
      {dragActive && (
        <div className="chat-drop-overlay" aria-hidden>
          <div className="chat-drop-overlay-inner">
            {t("chat.dropToAttach")}
          </div>
        </div>
      )}
    </div>
  );
}

export default Chat;
