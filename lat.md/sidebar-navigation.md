# Sidebar recent sessions

The sidebar starts with New Chat, keeps app destinations pinned, then gives conversations and projects their own scroll area.

[[src/renderer/src/screens/Layout/Layout.tsx#Layout]] renders a New Chat action before Discover, Office, Kanban, and Schedules from `PINNED_NAV_ITEMS`, then renders [[src/renderer/src/screens/Layout/SidebarRecentSessions.tsx]] inside a flexible `.sidebar-chat-section`. New Chat is active when the visible Chat view has no session id yet. The standalone `sessions` view is still absent from the `View` union; the full list opens from the Cmd/Ctrl+K menu action.

## Infinite sidebar list

The inline list lazily loads cached sessions in pages as the user scrolls, so the sidebar can expose the full chat history without a fixed inline cap.

[[src/renderer/src/screens/Layout/SidebarRecentSessions.tsx]] fetches `RECENT_SESSIONS_PAGE_SIZE + 1` rows from the `sessions.json` cache to detect whether another page exists. [[src/renderer/src/screens/Layout/Layout.tsx#Layout]] passes the chat scroll container ref down, and the sidebar loads the next page when that container nears the bottom. The initial sync still refreshes `state.db`, then paints the first page.

Session titles in the inline list are constrained to the sidebar width and truncate with ellipses, while the chat section only scrolls vertically. This keeps long generated titles from creating a horizontal scrollbar.

The native sidebar scrollbar is hidden to avoid layout shifts. [[src/renderer/src/screens/Layout/Layout.tsx#Layout]] measures the chat scroll container and renders an absolutely positioned overlay thumb only while the user is scrolling, so showing or hiding the scrollbar never changes row width.

## Project grouping

Workspace-linked conversations are grouped under project rows so repository chats stay together without hiding ordinary chats.

[[src/main/session-cache.ts#syncSessionCache]] attaches each row's context folder in one batched [[src/main/session-context-folder-store.ts#getSessionContextFolders]] read and persists `contextFolder` into the `sessions.json` cache. [[src/main/session-cache.ts#listCachedSessions]] stays a DB-free cache read — it returns the persisted `contextFolder` without re-querying the store. The sidebar groups rows with a `contextFolder` under a Projects section by folder basename, while rows without one remain under Chats.

When [[src/renderer/src/screens/Chat/Chat.tsx#Chat]] saves a session context folder, it emits a renderer event that [[src/renderer/src/screens/Layout/SidebarRecentSessions.tsx]] uses to force-refresh the cache. This keeps project grouping visible immediately after a workspace is linked.

Projects and Chats are top-level collapsible sections, and each project folder can also be expanded or collapsed. [[src/renderer/src/screens/Layout/SidebarRecentSessions.tsx]] persists those disclosure states in `localStorage`; the sidebar CSS keeps section and folder rows on the same left rail, keeps disclosure arrows right-aligned, animates each disclosure with grid-row transitions, and removes hidden rows from keyboard tab order.

## Full-list modal

The Cmd/Ctrl+K menu action opens an 80%×80% modal that reuses the existing Sessions screen rather than a separate route.

The modal in [[src/renderer/src/screens/Layout/Layout.tsx#Layout]] renders [[src/renderer/src/screens/Sessions/Sessions.tsx]] inside a `.sessions-modal` over the shared `.models-modal-overlay` backdrop. Resuming a session or starting a new chat from the modal closes it; Esc and a backdrop click also close it. Because the Sessions screen owns its own fetching gated on `visible`, it loads only while the modal is open.

## Profile switch and active chat

The footer profile switcher keeps the selected shell profile aligned with the visible chat run, while preserving older conversations under their original profiles.

[[src/renderer/src/screens/Layout/ProfileSwitcher.tsx#ProfileSwitcher]] persists the selected profile through main-process profile switching, then [[src/renderer/src/screens/Layout/Layout.tsx#Layout]] applies [[src/renderer/src/screens/Layout/chatRuns.ts#selectProfileRunTransition]] before rendering Chat. If the active chat is blank, it is re-homed to the selected profile; if it already belongs to another profile, the shell activates an existing blank run for the selected profile or creates a fresh one. This prevents the footer, Settings, recent sessions, and chat transport from disagreeing about which agent is active.

Opening a sidebar session after switching profiles consumes that blank selected-profile run instead of appending beside it. [[src/renderer/src/screens/Layout/chatRuns.ts#openSessionRunTransition]] replaces the active scratch run when it belongs to the same profile as the resumed session, so the tab strip shows the previous session without an extra "New conversation" tab.

## Footer action row

Administrative destinations sit beside the profile switcher so the conversation nav stays short.

[[src/renderer/src/screens/Layout/Layout.tsx#Layout]] keeps Providers, Settings, Gateway, Capabilities, and Memory out of the main sidebar list and renders them as icon-only footer actions immediately above [[src/renderer/src/screens/Layout/ProfileSwitcher.tsx#ProfileSwitcher]]. Each button exposes a styled hover/focus tooltip and accessible label, preserving discoverability while freeing vertical room for recent conversations.

## Provisional fresh sessions

Fresh chat session ids are provisional until a turn produces output or completes successfully, so provider errors do not create visible recent-session rows.

The main-process transports still send a generated `X-Hermes-Session-Id` on fresh requests to avoid gateway fingerprint collisions, but [[src/main/hermes.ts#sendMessageViaApi]] and the runs transport announce that id to the renderer only after visible output, tool/reasoning activity, or successful completion. Resumed sessions are announced immediately because the renderer already knows they are existing conversations. This keeps [[src/renderer/src/screens/Chat/hooks/useChatIPC.ts#useChatIPC]] from binding a failed first turn to a new sidebar entry.
