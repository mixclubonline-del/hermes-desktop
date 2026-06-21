import {
  useCallback,
  useEffect,
  useRef,
  useState,
  memo,
  type RefObject,
} from "react";
import { useI18n } from "../../components/useI18n";
import {
  ChevronDown,
  ChevronRight,
  Circle,
  Folder,
  Loader,
} from "../../assets/icons";

interface RecentSession {
  id: string;
  title: string;
  contextFolder?: string | null;
}

// ChatGPT-style paged conversation list under the pinned app navigation.
export const RECENT_SESSIONS_PAGE_SIZE = 30;

// Re-sync cadence while the list is visible. Deliberately slower than the
// Sessions screen (30s) — the sidebar is always on screen, so this interval
// runs for the whole app lifetime when the section is expanded.
const RECENT_REFRESH_MS = 60_000;

// Minimum gap between event-driven refreshes (focus, session switch) so a
// burst of focus/blur events doesn't hammer state.db.
const REFRESH_THROTTLE_MS = 5_000;
const INFINITE_SCROLL_THRESHOLD_PX = 180;
const PROJECTS_OPEN_KEY = "hermes.sidebar.projectsOpen";
const CHATS_OPEN_KEY = "hermes.sidebar.chatsOpen";
const FOLDERS_CLOSED_KEY = "hermes.sidebar.closedProjectFolders";

function readStoredOpen(key: string): boolean {
  try {
    return localStorage.getItem(key) !== "false";
  } catch {
    return true;
  }
}

function readStoredClosedFolders(): Set<string> {
  try {
    const raw = localStorage.getItem(FOLDERS_CLOSED_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter(String) : []);
  } catch {
    return new Set();
  }
}

function storeClosedFolders(paths: Set<string>): void {
  try {
    localStorage.setItem(FOLDERS_CLOSED_KEY, JSON.stringify(Array.from(paths)));
  } catch {
    /* ignore persistence failures */
  }
}

function sameSessions(a: RecentSession[], b: RecentSession[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (
      a[i].id !== b[i].id ||
      a[i].title !== b[i].title ||
      (a[i].contextFolder ?? null) !== (b[i].contextFolder ?? null)
    ) {
      return false;
    }
  }
  return true;
}

function folderName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) || path;
}

function groupSessionsByWorkspace(sessions: RecentSession[]): {
  projectGroups: Array<{
    path: string;
    name: string;
    sessions: RecentSession[];
  }>;
  chats: RecentSession[];
} {
  const projects = new Map<string, RecentSession[]>();
  const chats: RecentSession[] = [];

  for (const session of sessions) {
    const contextFolder = session.contextFolder?.trim();
    if (!contextFolder) {
      chats.push(session);
      continue;
    }
    const existing = projects.get(contextFolder);
    if (existing) existing.push(session);
    else projects.set(contextFolder, [session]);
  }

  return {
    projectGroups: Array.from(projects.entries()).map(([path, list]) => ({
      path,
      name: folderName(path),
      sessions: list,
    })),
    chats,
  };
}

/**
 * Recent-sessions list rendered under the "Sessions" nav item in the sidebar
 * (like ChatGPT's sidebar chat list). Owns its own data so Layout re-renders
 * (view switches, update banners, …) never trigger fetches, and `memo` keeps
 * it off the render hot path entirely.
 *
 * Fetch strategy, cheapest first:
 *  - on open: instant read from the sessions.json cache (no DB), then one
 *    sync against state.db to pick up sessions created since the last sync
 *  - while open: refresh on window focus and on a slow interval, throttled
 *  - closed (collapsed section or icon-only sidebar): zero work, renders null
 */
const SidebarRecentSessions = memo(function SidebarRecentSessions({
  open,
  activeProfile,
  currentSessionId,
  loadingSessionIds,
  resumingSessionId,
  onSelect,
  scrollRootRef,
}: {
  open: boolean;
  /** Active profile — the list is per-profile, so switching forces a reload. */
  activeProfile: string;
  currentSessionId: string | null;
  /** Session ids of every run currently generating (multiple run at once). */
  loadingSessionIds: Set<string>;
  /** A session whose history is being fetched for resume (transient spinner). */
  resumingSessionId: string | null;
  onSelect: (sessionId: string) => void;
  /** Scroll container owned by Layout; nearing its bottom loads the next page. */
  scrollRootRef: RefObject<HTMLDivElement | null>;
}): React.JSX.Element | null {
  const { t } = useI18n();
  const [sessions, setSessions] = useState<RecentSession[]>([]);
  // True when the profile has more cache rows than the sidebar has loaded.
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [projectsOpen, setProjectsOpen] = useState(() =>
    readStoredOpen(PROJECTS_OPEN_KEY),
  );
  const [chatsOpen, setChatsOpen] = useState(() =>
    readStoredOpen(CHATS_OPEN_KEY),
  );
  const [closedProjectFolders, setClosedProjectFolders] = useState<Set<string>>(
    () => readStoredClosedFolders(),
  );
  const lastRefreshRef = useRef(0);
  const sessionsRef = useRef<RecentSession[]>([]);
  const hasMoreRef = useRef(false);
  const loadingMoreRef = useRef(false);

  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  useEffect(() => {
    hasMoreRef.current = hasMore;
  }, [hasMore]);

  const normalizeRows = useCallback(
    (
      list: Array<{
        id: string;
        title: string;
        contextFolder?: string | null;
      }>,
      limit = RECENT_SESSIONS_PAGE_SIZE,
    ): RecentSession[] =>
      list
        .slice(0, limit)
        .map(({ id, title, contextFolder }) => ({
          id,
          title,
          contextFolder: contextFolder ?? null,
        })),
    [],
  );

  const applyFirstPage = useCallback(
    (
      list: Array<{
        id: string;
        title: string;
        contextFolder?: string | null;
      }>,
    ): void => {
      setHasMore(list.length > RECENT_SESSIONS_PAGE_SIZE);
      const next = normalizeRows(list);
      // Skip the state update (and re-render) when nothing changed — the
      // common case for periodic refreshes.
      setSessions((prev) => (sameSessions(prev, next) ? prev : next));
    },
    [normalizeRows],
  );

  const applyLoadedWindow = useCallback(
    (
      list: Array<{
        id: string;
        title: string;
        contextFolder?: string | null;
      }>,
    ): void => {
      const loadedLimit = Math.max(
        RECENT_SESSIONS_PAGE_SIZE,
        sessionsRef.current.length,
      );
      setHasMore(list.length > loadedLimit);
      const next = normalizeRows(list, loadedLimit);
      setSessions((prev) => (sameSessions(prev, next) ? prev : next));
    },
    [normalizeRows],
  );

  const appendPage = useCallback(
    (
      list: Array<{
        id: string;
        title: string;
        contextFolder?: string | null;
      }>,
    ): void => {
      setHasMore(list.length > RECENT_SESSIONS_PAGE_SIZE);
      const page = normalizeRows(list);
      if (page.length === 0) return;
      setSessions((prev) => {
        const seen = new Set(prev.map((s) => s.id));
        const next = [...prev];
        for (const session of page) {
          if (!seen.has(session.id)) next.push(session);
        }
        return sameSessions(prev, next) ? prev : next;
      });
    },
    [normalizeRows],
  );

  const refresh = useCallback(
    async (force = false): Promise<void> => {
      const now = Date.now();
      if (!force && now - lastRefreshRef.current < REFRESH_THROTTLE_MS) return;
      lastRefreshRef.current = now;
      try {
        const synced = await window.hermesAPI.syncSessionCache();
        applyLoadedWindow(synced);
      } catch {
        // keep whatever we had — the list is best-effort UI sugar
      }
    },
    [applyLoadedWindow],
  );

  const loadNextPage = useCallback(async (): Promise<void> => {
    if (!open || !hasMoreRef.current || loadingMoreRef.current) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      const nextPage = await window.hermesAPI.listCachedSessions(
        RECENT_SESSIONS_PAGE_SIZE + 1,
        sessionsRef.current.length,
      );
      appendPage(nextPage);
    } catch {
      // keep the current list; scrolling can retry on the next event
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, [appendPage, open]);

  const maybeLoadNextPage = useCallback((): void => {
    const root = scrollRootRef.current;
    if (!projectsOpen && !chatsOpen) return;
    if (!root || !hasMoreRef.current || loadingMoreRef.current) return;
    const remaining = root.scrollHeight - root.scrollTop - root.clientHeight;
    if (remaining <= INFINITE_SCROLL_THRESHOLD_PX) void loadNextPage();
  }, [chatsOpen, loadNextPage, projectsOpen, scrollRootRef]);

  // Initial load when the section opens: paint from the JSON cache
  // immediately (no DB access), then sync once for anything new.
  // Sequenced so sync always wins over cache (avoids race where stale
  // cache overwrites fresh sync if sync resolves first).
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      try {
        const cached = await window.hermesAPI.listCachedSessions(
          // One over the page size so the cache read alone can decide whether
          // another page exists without a separate count query.
          RECENT_SESSIONS_PAGE_SIZE + 1,
        );
        if (!cancelled) applyFirstPage(cached);
      } catch {
        /* ignore cache read errors */
      }
      lastRefreshRef.current = Date.now();
      try {
        const synced = await window.hermesAPI.syncSessionCache();
        if (!cancelled) applyFirstPage(synced);
      } catch {
        // cache read above already painted something
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, activeProfile, applyFirstPage]);

  // While open: pick up background sessions (gateway, cron, other devices)
  // on focus and on a slow timer. No listeners or timers at all when closed.
  useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => void refresh(), RECENT_REFRESH_MS);
    const onFocus = (): void => {
      void refresh();
    };
    const onContextFolderChanged = (): void => {
      void refresh(true);
    };
    window.addEventListener("focus", onFocus);
    window.addEventListener(
      "hermes-session-context-folder-changed",
      onContextFolderChanged,
    );
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener(
        "hermes-session-context-folder-changed",
        onContextFolderChanged,
      );
    };
  }, [open, refresh]);

  useEffect(() => {
    if (!open) return;
    const root = scrollRootRef.current;
    if (!root) return;
    const onScroll = (): void => {
      maybeLoadNextPage();
    };
    root.addEventListener("scroll", onScroll, { passive: true });
    maybeLoadNextPage();
    return () => {
      root.removeEventListener("scroll", onScroll);
    };
  }, [maybeLoadNextPage, open, scrollRootRef]);

  // If the first page does not fill the sidebar, keep paging until the scroll
  // container has real overflow or the cache runs out.
  useEffect(() => {
    if (open) maybeLoadNextPage();
  }, [hasMore, maybeLoadNextPage, open, sessions.length]);

  // Resuming/switching sessions reorders recency — refresh (throttled).
  // Also refreshes when going to "New Chat" (currentSessionId becomes null)
  // so the just-left session appears in the list immediately.
  useEffect(() => {
    if (open) void refresh();
  }, [open, currentSessionId, refresh]);

  // Switching agent points the list at a different profile's DB. Force a
  // reload immediately (bypassing the throttle) so the list isn't stale.
  const prevProfileRef = useRef(activeProfile);
  useEffect(() => {
    if (prevProfileRef.current === activeProfile) return;
    prevProfileRef.current = activeProfile;
    void refresh(true);
  }, [activeProfile, refresh]);

  // Keep the wrapper mounted so the collapse/expand animates with CSS grid
  // tracks. Effects above are still gated on `open`, so a collapsed sidebar
  // does no fetching while keeping the last-loaded list ready to animate.
  const expanded = open;
  const { projectGroups, chats } = groupSessionsByWorkspace(sessions);

  const toggleProjects = () => {
    setProjectsOpen((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(PROJECTS_OPEN_KEY, String(next));
      } catch {
        /* ignore persistence failures */
      }
      return next;
    });
  };

  const toggleChats = () => {
    setChatsOpen((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(CHATS_OPEN_KEY, String(next));
      } catch {
        /* ignore persistence failures */
      }
      return next;
    });
  };

  const toggleProjectFolder = (path: string) => {
    setClosedProjectFolders((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      storeClosedFolders(next);
      return next;
    });
  };

  const renderSessionButton = (
    s: RecentSession,
    project = false,
    visible = expanded,
  ) => {
    const title = s.title || t("sessions.newConversation");
    const loading = resumingSessionId === s.id || loadingSessionIds.has(s.id);
    const active = !loading && currentSessionId === s.id;
    return (
      <button
        key={s.id}
        type="button"
        className={`sidebar-recent-session ${project ? "project-child" : ""} ${
          active ? "active" : ""
        }`}
        onClick={() => onSelect(s.id)}
        title={title}
        tabIndex={visible ? 0 : -1}
      >
        {loading ? (
          <Loader
            className="sidebar-recent-session-dot sidebar-recent-session-dot--loading"
            size={11}
          />
        ) : (
          <Circle
            className={`sidebar-recent-session-dot ${
              active ? "sidebar-recent-session-dot--active" : ""
            }`}
            size={7}
            fill={active ? "currentColor" : "none"}
          />
        )}
        <span className="sidebar-recent-session-title">{title}</span>
      </button>
    );
  };

  return (
    <div
      className={`sidebar-recent-sessions-wrap ${expanded ? "expanded" : ""}`}
      aria-hidden={!expanded}
    >
      <div className="sidebar-recent-sessions">
        {projectGroups.length > 0 && (
          <div className="sidebar-recent-section">
            <button
              type="button"
              className="sidebar-recent-section-toggle"
              onClick={toggleProjects}
              aria-expanded={projectsOpen}
              tabIndex={expanded ? 0 : -1}
            >
              <span>{t("navigation.projects")}</span>
              {projectsOpen ? (
                <ChevronDown
                  className="sidebar-recent-disclosure-icon"
                  size={13}
                />
              ) : (
                <ChevronRight
                  className="sidebar-recent-disclosure-icon"
                  size={13}
                />
              )}
            </button>
            <div
              className={`sidebar-recent-collapse ${
                projectsOpen ? "expanded" : ""
              }`}
            >
              <div className="sidebar-recent-collapse-inner">
                {projectGroups.map((group) => {
                  const projectOpen = !closedProjectFolders.has(group.path);
                  const visible = expanded && projectsOpen && projectOpen;
                  return (
                    <div className="sidebar-recent-project" key={group.path}>
                      <button
                        type="button"
                        className="sidebar-recent-project-heading"
                        title={group.path}
                        onClick={() => toggleProjectFolder(group.path)}
                        aria-expanded={projectOpen}
                        tabIndex={expanded && projectsOpen ? 0 : -1}
                      >
                        <Folder size={13} />
                        <span>{group.name}</span>
                        {projectOpen ? (
                          <ChevronDown
                            className="sidebar-recent-disclosure-icon"
                            size={12}
                          />
                        ) : (
                          <ChevronRight
                            className="sidebar-recent-disclosure-icon"
                            size={12}
                          />
                        )}
                      </button>
                      <div
                        className={`sidebar-recent-collapse ${
                          projectOpen ? "expanded" : ""
                        }`}
                      >
                        <div className="sidebar-recent-collapse-inner">
                          {group.sessions.map((s) =>
                            renderSessionButton(s, true, visible),
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}
        <div className="sidebar-recent-section">
          <button
            type="button"
            className="sidebar-recent-section-toggle"
            onClick={toggleChats}
            aria-expanded={chatsOpen}
            tabIndex={expanded ? 0 : -1}
          >
            <span>{t("navigation.chats")}</span>
            {chatsOpen ? (
              <ChevronDown
                className="sidebar-recent-disclosure-icon"
                size={13}
              />
            ) : (
              <ChevronRight
                className="sidebar-recent-disclosure-icon"
                size={13}
              />
            )}
          </button>
          <div
            className={`sidebar-recent-collapse ${
              chatsOpen ? "expanded" : ""
            }`}
          >
            <div className="sidebar-recent-collapse-inner">
              {chats.length > 0 ? (
                chats.map((s) =>
                  renderSessionButton(s, false, expanded && chatsOpen),
                )
              ) : (
                <div className="sidebar-recent-empty">
                  {t("navigation.noChats")}
                </div>
              )}
            </div>
          </div>
        </div>
        {loadingMore && (
          <div className="sidebar-recent-loading" aria-live="polite">
            <Loader
              className="sidebar-recent-session-dot sidebar-recent-session-dot--loading"
              size={11}
            />
            <span>{t("common.loadingShort")}</span>
          </div>
        )}
      </div>
    </div>
  );
});

export default SidebarRecentSessions;
