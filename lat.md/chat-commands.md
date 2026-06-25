# Slash command execution

Typed slash commands (`/compact`, `/compress`, `/reset`, `/web`, …) are run through the gateway's command pipeline, not submitted to the model as plain prompt text. This is what makes them _do_ something instead of being echoed back as prose.

The desktop talks to the hermes-agent gateway over JSON-RPC. A normal message goes via `prompt.submit`, which the gateway treats as a user turn — so a literal `/compact` reaches the model and comes back as text. Real commands must instead go through `slash.exec` (registry-backed worker) with a `command.dispatch` fallback for commands that resolve to an alias, plugin, skill, or an agent prompt.

## Routing pipeline

The pure routing logic lives in [[src/renderer/src/screens/Chat/slashExec.ts#executeSlash]]: try `slash.exec`, accept either rendered output or a structured dispatch result, and on rejection fall back to `command.dispatch`, returning `done`, `send`, or `error`.

It mirrors hermes-agent's reference client (`web/src/lib/slashExec.ts`) so every front-end implements the same contract. Pending-input commands such as `/learn` can return `{type: "send"}` directly from `slash.exec`; that prompt still passes through the central model-submission path.

## Local vs gateway commands

Every typed slash command is resolved through the merged catalog before execution. Ownership is explicit (`target: "desktop" | "agent" | "model"`); display categories such as `info` do not determine routing.

Desktop-only commands delegate to local renderer handlers, Agent commands use the gateway command pipeline, and model commands build a prompt through the shared model-submission formatter. The legacy transport reports Agent commands as unavailable instead of sending raw `/…` text to the model.

## Commands never queue

Slash commands run on the gateway's **persistent slash-worker subprocess**, concurrent with any in-flight turn — so they respond instantly and must NOT sit in the busy queue behind a running turn (only plain prompts queue).

`handleSubmitOrQueue` in [[src/renderer/src/screens/Chat/Chat.tsx]] dispatches every `/…` input immediately to the central router. Desktop and slash-worker commands can complete concurrently; model commands and Agent `send`/skill directives are formatted once and queued when the main model turn is busy.

Because no global loading state is set, the slash branch shows its own feedback: it inserts an in-place `⏳ Running …` agent bubble, buffers the pipeline output, and replaces that bubble with the result (or `error: …`) when the command resolves — otherwise a slow or unreachable gateway would leave the user staring at nothing.

## Transport connection lifecycle

Every dashboard turn first connects a JSON-RPC WebSocket to the gateway; that handshake must be time-bounded or a stalled socket wedges the whole transport with no error and no fallback (issue #718).

[[src/renderer/src/screens/Chat/dashboardGatewayClient.ts#DashboardGatewayClient#connect]] resolves on `open`, rejects on `error` or an early `close`, **and** rejects on a connect-timeout (default 10s). A WebSocket stuck in `CONNECTING` — TCP accepted but the upgrade never completing, e.g. when a busy renderer starves the handshake — fires none of those events on its own, so without the timer the connect promise never settles. When it never settles, `ensureClient` in [[src/renderer/src/screens/Chat/hooks/useDashboardChatTransport.ts#useDashboardChatTransport]] never resolves, its cached `connectingRef` promise poisons every later send, `setIsLoading(false)` never runs, and the user sees a permanent loading spinner. The timeout makes the promise reject so auto mode falls back to the legacy HTTP transport (and explicit-dashboard mode surfaces a real error) instead of hanging. Per-request calls are separately bounded by their own 30s timeout.

## Completion text reconciliation

On `message.complete` the desktop reconciles the text streamed via `message.delta` with the turn's `final_response`, because a last-turn-only final would otherwise clobber text streamed before a tool call (#746).

[[src/renderer/src/screens/Chat/dashboardEventAdapter.ts#completeAssistantWithFinalText]] rewrites the last assistant bubble through [[src/renderer/src/screens/Chat/dashboardEventAdapter.ts#mergeStreamedWithFinal]], which compares whitespace-insensitively and: uses the final text when it already contains the streamed text; keeps the streamed text when it contains the final (preserving pre-tool-call content); stitches a re-streamed boundary by dropping the duplicated word-aligned seam (rejecting coincidental mid-word overlaps); replaces a garbled re-stream with the final text when the two converge on a substantial common suffix (a corrupted-prefix delta — e.g. a mangled CJK stream — that ends the same sentence as the clean final, rather than the disjoint pre-tool-call + answer pair); and otherwise concatenates the two with a blank-line separator so segments never run together. On the remote/SSH path deltas are not rendered (`renderAssistantDeltas: false`), so the bubble starts empty and the final text is used verbatim.

## Reasoning & tool activity rows

Streamed reasoning and tool calls are folded into compact, collapsible transcript rows rather than stacked bubbles, so a turn with heavy thinking or many tool calls stays scannable.

[[src/renderer/src/screens/Chat/HistoryRow.tsx#ReasoningRow]] renders the `Thought` / `Thinking…` row and [[src/renderer/src/screens/Chat/HistoryRow.tsx#ToolActivityGroup]] folds a contiguous run of tool calls/results into one row titled by [[src/renderer/src/screens/Chat/HistoryRow.tsx#toolActivityGroupTitle]]. Each row is collapsed by default and borderless (Codex-style): dim at rest, it brightens and reveals an expand chevron beside the title on hover/focus, and clicking toggles the body open. While the turn is still streaming the leading icon is a `Grid` loader (purple for reasoning, blue for tools); once finished it shows the brain/tool glyph.

## Bubble hover timestamp

Each user/assistant bubble reveals a relative "time ago" label on row hover, so the transcript stays uncluttered at rest but is still scrutable when a user wants to know _when_ something was said.

The canonical time comes from state.db: [[src/renderer/src/screens/Chat/sessionHistory.ts#dbItemsToChatMessages]] copies each row's `timestamp` onto the `ChatBubbleMessage`, and [[src/renderer/src/screens/Chat/sessionHistory.ts#reconcileAfterDbRefresh|the end-of-stream reconcile]] adopts it onto the matching streamed bubble (via `mergeDbMetadataIntoStreamed`) so a live turn picks up its real time after refresh without remounting. state.db stores times in **seconds**, so `toEpochMs` in MessageRow scales any sub-`1e12` value up to milliseconds before use (otherwise it renders as ~Jan 1970). [[src/renderer/src/screens/Chat/MessageRow.tsx#formatBubbleTime]] builds the label with date-fns `formatDistanceToNowStrict` (e.g. "5 minutes ago", "just now" under 10s), with `formatBubbleTimeAbsolute` supplying the exact date/time as the `<time>` element's `title`/`dateTime`. The `.chat-message:hover .chat-bubble-time` CSS fades it in below the bubble, anchored to `.chat-message` because `.chat-bubble`'s own `overflow` would clip it.

## Renderer-native commands

A few non-local commands have dedicated desktop handling and must NOT be diverted to the gateway slash pipeline, or they'd lose their behaviour.

The approval responses `/approve` and `/deny` (the `RENDERER_NATIVE_SLASH` set) are excluded from the pipeline and sent as prompt-level input, matching their dedicated button handlers — `slash.exec` rejects pending-input commands anyway.

## Side questions (`/btw`)

`/btw` (with aliases `/bg` and `/background`) is a side question that runs on a **concurrent background agent**, so it must never block or queue behind the main turn — that is the point of "ask without affecting context".

It maps to the gateway's `prompt.background` RPC, which spawns a separate agent and reports back later via a `background.complete` event (a normal `prompt.submit` mid-turn is rejected with "session busy"). [[src/renderer/src/screens/Chat/hooks/useChatActions.ts#parseBackgroundCommand|parseBackgroundCommand]] detects these commands; `handleSubmitOrQueue` in [[src/renderer/src/screens/Chat/Chat.tsx]] fires them immediately — bypassing the busy queue — via the shared background flow (also used by the 💭 quick-ask button). The transport's `runBackground` ([[src/renderer/src/screens/Chat/hooks/useDashboardChatTransport.ts#useDashboardChatTransport]]) calls the RPC, and its gateway-event handler renders the `background.complete` answer as a standalone `[bg …]` message. The legacy (non-dashboard) transport has no background RPC and falls back to the blocking quick-ask.

## Central command router

The central slash command architecture in [[src/renderer/src/screens/Chat/slash/handleSlashCommand.ts#handleSlashCommand]] classifies every slash command into a discriminated union (`target: "desktop" | "agent" | "model"`). Unrecognized commands return an error instead of reaching the model as prose.

The command palette and executor share a catalog built by [[src/renderer/src/screens/Chat/slash/commandCatalog.ts#createSlashCatalog]]. Hermes Agent metadata comes from `commands.catalog`; Desktop commands are merged after collision validation, and upstream names/aliases are normalized from `/name` to the router's canonical `name`.

### Desktop commands

Desktop commands in [[src/renderer/src/screens/Chat/slash/desktopCommands.ts#DESKTOP_SLASH_COMMANDS]] handle local Electron/renderer UI operations such as opening settings, triggering the active chat's model picker, and switching navigation views without sending prompts.

Asynchronous Agent commands render a temporary slash-loader bubble without transcript actions such as Copy; the bubble is replaced by the command output or error when execution finishes.

### Agent commands

Agent commands forward upstream via [[src/renderer/src/screens/Chat/slash/executeAgentCommand.ts#executeAgentCommand]] using gateway JSON-RPC.

### Model commands

Model commands and Agent `send`/skill directives pass through [[src/renderer/src/screens/Chat/slash/prepareModelSubmission.ts#prepareModelSubmission]] before entering the standard chat transport. This is the only slash route allowed to submit model content.

### Command icons

Visual presentation in the autocomplete popup is handled by [[src/renderer/src/screens/Chat/slash/SlashCommandIcon.tsx#SlashCommandIcon]], mapping command names to Lucide icons with fallback defaults and a custom SVG registry.

Typing `/` opens a centered command palette in [[src/renderer/src/screens/Chat/ChatInput.tsx#ChatInput]] while the composer retains keyboard focus. Results filter by name or description, stay grouped by category, and support arrows, Enter or Tab, and Escape.

Escape is captured at the document level while the palette is open, so it closes even if focus has moved from the composer into a command row. Dismissal preserves the slash draft and returns focus to the composer.

The palette pre-normalizes searchable command metadata and virtualizes its grouped rows through [[src/renderer/src/screens/Chat/slash/virtualSlashCommands.ts#createSlashCommandVirtualLayout]]. Only visible rows plus a small overscan are mounted, while keyboard selection uses calculated offsets.
