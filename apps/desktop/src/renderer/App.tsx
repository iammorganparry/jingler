import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMachine } from "@xstate/react";
import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type {
  ContextConfig,
  VsCodeTheme,
  CliKind,
  CreateSessionFromIssueInput,
  CreateSessionFromPrInput,
  CreateSessionInput,
  GitConfig,
  GithubConfig,
  NotificationsConfig,
  OrchestratorPreference,
  WorkerRoutingConfig,
  ProviderConfig,
  PublishCheckpoint,
  Session,
  SessionActivity,
  User,
} from "@jingler/core";
import {
  clampFontScale,
  DEFAULT_THEME_ID,
  workspaceModeOf,
} from "@jingler/core";
import {
  ConfirmDialog,
  MemoryAnalytics,
  MemoryBrowser,
  MemoryDashboard,
  MemoryInspector,
  MemoryMap,
  LoadingScreen,
  LoginScreen,
  SetupScreen,
  JinglerApp,
  ThemeProvider,
  useSplashHold,
  useThemeCatalog,
} from "@jingler/ui";
import type { MemorySubview } from "@jingler/ui";
import {
  BarChart3,
  BookOpen,
  Download,
  LayoutDashboard,
  Map as MapIcon,
  RotateCcw,
  Search,
} from "lucide-react";
import { appMachine } from "./app-machine.js";
import { authMachine } from "./auth-machine.js";
import { ConversationPane } from "./conversation-pane.js";
import { SessionChatTabs } from "./session-chat-tabs.js";
import { PullRequestPane } from "./pull-request-pane.js";
import { ReviewPane } from "./review-pane.js";
import { FileBrowserQuickOpen, FileBrowserView } from "./file-browser-view.js";
import { TerminalDockView } from "./terminal-dock-view.js";
import { useTerminalDock } from "./use-terminal-dock.js";
import { PreviewDockView } from "./preview-dock-view.js";
import { usePreviewDock } from "./use-preview-dock.js";
import { useSessionActivities } from "./session-activity.js";
import { useSidebarWorkerActivity } from "./use-sidebar-worker-activity.js";
import { useSessionDiffs } from "./diff-presence.js";
import { clearPlanAutoPresentation, usePlanSessions } from "./plan-presence.js";
import {
  disposeConversationActor,
  getConversationActor,
} from "./conversation-registry.js";
import {
  flushPlanDocument,
  stopPlanDocument,
} from "./plan-document-registry.js";
import { addDraftCodeReference, clearDraft } from "./draft-store.js";
import { clearViewedPaths } from "./viewed-store.js";
import { disposeFileBrowserActor, openSessionFile } from "./use-file-browser.js";
import { onSessionUpdate } from "./session-updates.js";
import { setVisibleSessionIds } from "./active-session.js";
import { prNotification } from "./notifier.js";
import { completedSessionIds } from "./pr-refresh.js";
import { issuesToCloseOnMerge, prsToNotify } from "./pr-sweep.js";
import { routeReviewToAgent } from "./auto-route.js";
import { reviewQueryKey } from "./review-routing.js";
import {
  needsSessionRetitle,
  newlyPlannedSessionIds,
} from "./retitle-triggers.js";
import { rpc } from "./rpc-client.js";
import { themeCatalogKey, useTheme } from "./use-theme.js";
import { useConnectorCenter } from "./use-connector-center.js";
import { useOpenConnector } from "./use-open-connector.js";
import { useInjectionTargets } from "./use-injection-targets.js";
import {
  PluginProvider,
  usePluginCommands,
  usePluginPanes,
  usePluginTabs,
} from "./plugin-registry.js";
import { usePlugins } from "./use-plugins.js";
import { useMemory } from "./use-memory.js";
import { repositoryAccess } from "./github-connection-machine.js";
import { useGitHubConnection } from "./use-github-connection.js";
import { GitHubFeedbackRouter } from "./github-feedback.js";
import { applyRelayHealthUpdate } from "./github-relay-health.js";

/** How often the archive sweep re-checks each linked PR's merged/closed state. */
const ARCHIVE_POLL_MS = 60_000;

/** How long a fetched PR state stays fresh before the sweep will re-fetch it. */
const PR_STATE_STALE_MS = 5 * 60_000;

/**
 * How long a relay connection must stay troubled before the "reconnecting"
 * banner appears. Routine reconnects recover well within this, so they never
 * surface; a genuine outage outlasts it and does.
 */
const RELAY_UNHEALTHY_GRACE_MS = 4_000;

const MEMORY_TABS: ReadonlyArray<{
  readonly id: MemorySubview;
  readonly label: string;
  readonly icon: typeof LayoutDashboard;
}> = [
  { id: "dashboard", label: "Dashboard", icon: LayoutDashboard },
  { id: "map", label: "Map", icon: MapIcon },
  { id: "wiki", label: "Wiki", icon: BookOpen },
  { id: "analytics", label: "Analytics", icon: BarChart3 },
];

function MemoryWorkspace({ memory }: { memory: ReturnType<typeof useMemory> }) {
  const { context } = memory;
  return (
    <div
      className="relative flex min-h-0 flex-1 flex-col bg-editor"
      data-testid="memory-workspace"
    >
      <header className="flex flex-none flex-wrap items-center gap-2 border-b border-hairline bg-panel px-3 py-2">
        <strong className="mr-2 text-[12px] text-text-bright">Memory</strong>
        <select
          aria-label="Memory organization"
          value={context.organizationId ?? ""}
          onChange={(event) =>
            memory.changeOrganization(event.currentTarget.value)
          }
          className="max-w-48 rounded-md border border-line bg-sunken px-2 py-1.5 text-[10.5px] text-text outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {context.organizationId === null && (
            <option value="">Choose a paid team…</option>
          )}
          {context.access?.organizations.map((organization) => (
            <option key={organization.id} value={organization.id}>
              {organization.name}
            </option>
          ))}
        </select>
        <label className="flex min-w-40 flex-1 items-center gap-2 rounded-md border border-line bg-sunken px-2.5 py-1.5 focus-within:ring-2 focus-within:ring-ring">
          <Search size={13} className="text-muted-foreground" />
          <span className="sr-only">Search all memory</span>
          <input
            disabled={context.organizationId === null}
            value={context.searchQuery}
            onChange={(event) => {
              memory.setQuery(event.currentTarget.value);
              if (context.view !== "wiki") memory.navigate({ view: "wiki" });
            }}
            placeholder="Search memory"
            className="min-w-0 flex-1 bg-transparent text-[10.5px] text-text outline-none placeholder:text-dim"
          />
        </label>
        <select
          disabled={context.organizationId === null}
          aria-label="Memory time range"
          value={context.range}
          onChange={(event) => memory.changeRange(event.currentTarget.value)}
          className="rounded-md border border-line bg-sunken px-2 py-1.5 text-[10.5px] text-text outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <option value="7d">7 days</option>
          <option value="30d">30 days</option>
          <option value="90d">90 days</option>
          <option value="all">All time</option>
        </select>
        <button
          type="button"
          disabled={context.organizationId === null || memory.exporting}
          onClick={memory.requestExport}
          className="flex items-center gap-1.5 rounded-md border border-line bg-sunken px-2.5 py-1.5 text-[10.5px] text-text outline-none hover:bg-surface focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        >
          <Download size={12} />{" "}
          {context.exported?.saved
            ? "Exported"
            : memory.exporting
              ? "Preparing…"
              : "Export"}
        </button>
      </header>
      {context.organizationId === null ? (
        <main className="grid min-h-0 flex-1 place-items-center p-6">
          <div className="max-w-md rounded-xl border border-line bg-panel p-5 text-center">
            <h2 className="text-sm font-semibold text-text-bright">
              Choose a team memory vault
            </h2>
            <p className="mt-2 text-xs leading-5 text-muted-foreground">
              Select one of your paid teams above. Jingler will remember the
              choice and attach its shared memory to future agent sessions.
            </p>
          </div>
        </main>
      ) : (
        <>
          <nav
            className="flex flex-none items-center gap-1 border-b border-hairline bg-panel px-3 py-1.5"
            aria-label="Memory views"
          >
            {MEMORY_TABS.map(({ id, label, icon: Icon }) => (
              <button
                type="button"
                key={id}
                aria-current={context.view === id ? "page" : undefined}
                onClick={() => memory.navigate({ view: id })}
                className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[10.5px] text-muted-foreground outline-none hover:bg-surface hover:text-text focus-visible:ring-2 focus-visible:ring-ring aria-[current=page]:bg-surface aria-[current=page]:text-text-bright"
              >
                <Icon size={12} /> {label}
              </button>
            ))}
          </nav>
          {(context.error !== null || context.recovery !== null) && (
            <div
              role="alert"
              className="flex flex-none items-center justify-between gap-3 border-b border-line bg-surface px-3 py-2"
            >
              <p className="min-w-0 text-[10.5px] text-text">
                {context.error !== null
                  ? context.error
                  : context.recovery?.retained
                    ? `${context.recovery.retained} memory capture${context.recovery.retained === 1 ? "" : "s"} remain safely queued.`
                    : `${context.recovery?.delivered ?? 0} queued memory capture${context.recovery?.delivered === 1 ? "" : "s"} recovered.`}
              </p>
              {context.error !== null && (
                <button
                  type="button"
                  disabled={memory.recovering}
                  onClick={memory.recover}
                  className="flex flex-none items-center gap-1.5 rounded-md border border-line bg-sunken px-2.5 py-1.5 text-[10.5px] text-text-bright outline-none hover:bg-panel focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                >
                  <RotateCcw size={12} className={memory.recovering ? "animate-spin" : undefined} />
                  {memory.recovering ? "Recovering…" : "Recover memory"}
                </button>
              )}
            </div>
          )}
          {context.view === "dashboard" && (
            <MemoryDashboard
              summary={context.summary}
              loading={memory.loading}
              error={null}
              onNavigate={memory.navigate}
              onRetry={memory.retry}
            />
          )}
          {context.view === "map" && (
            <MemoryMap
              graph={context.graph}
              positions={memory.positions}
              filters={context.filters}
              viewport={context.viewport}
              selectedNodeId={context.selectedNodeId}
              selectedEdgeId={context.selectedEdgeId}
              loading={memory.loading}
              onSelectNode={memory.selectNode}
              onSelectEdge={memory.selectEdge}
              onExpandNode={memory.expandNode}
              onViewportChange={memory.setViewport}
              onFiltersChange={memory.setFilters}
            />
          )}
          {context.view === "wiki" && (
            <MemoryBrowser
              query={context.searchQuery}
              results={context.searchResults}
              page={context.page}
              loading={memory.loading}
              filter={
                context.filters.healthOnly
                  ? "health findings"
                  : context.filters.freshness
              }
              onQueryChange={memory.setQuery}
              onOpenPage={memory.openPage}
              onBack={memory.backFromPage}
            />
          )}
          {context.view === "analytics" && (
            <MemoryAnalytics summary={context.summary} />
          )}
          {(context.selectedNodeId || context.selectedEdgeId) && (
            <MemoryInspector
              node={memory.selectedNode}
              evidence={context.evidence}
              page={context.page}
              loading={memory.loading}
              suggestions={context.suggestions?.suggestions ?? []}
              suggestionsSource={context.suggestions?.vectorSource ?? "lexical"}
              onBack={memory.closeInspector}
              onOpenPage={memory.openPage}
              onExpandNeighborhood={memory.expandNode}
              onPromoteSuggestion={(fromPageId) => memory.openPage(fromPageId)}
            />
          )}
        </>
      )}
    </div>
  );
}

/**
 * Thin view over `appMachine` (which drives the first-run/loading/session flow).
 * Everything else the shell needs is read through machines/react-query — the
 * GitHub App connection, persisted preferences, and usage — so there are no ad-hoc
 * `useEffect` + `useState` fetches here; a mutation just updates the cache.
 *
 * Only mounted once signed in (see the `App` auth gate below), so none of its
 * queries/effects run behind the sign-in wall. Receives the signed-in `user` and
 * `onSignOut` to drive the sidebar account menu.
 */
function AuthedApp({
  user,
  onSignOut,
}: {
  user?: User;
  onSignOut?: () => void;
}) {
  const [state, send] = useMachine(appMachine);
  const github = useGitHubConnection();
  const [relayError, setRelayError] = useState<string | null>(null);
  const relayStatuses = useRef(
    new Map<string, { mode: string; error: string | null }>(),
  );
  // A relay socket reconnects routinely — grant refresh, hibernation wake, a
  // momentary blip — and recovers in well under a second. Surfacing the banner
  // on the first "reconnecting" cried wolf constantly; only show it once trouble
  // has persisted past this window, and clear it the instant a session recovers.
  const relayGraceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const relayBannerVisible = useRef(false);
  const { clis, repos, reposDir, sessions } = state.context;
  // Merged with the built-ins inside `SessionPane`, through the same registry —
  // a plugin tab is not a separate region of the tab bar.
  const pluginTabs = usePluginTabs();
  const pluginPanes = usePluginPanes();
  const pluginCommands = usePluginCommands();
  const plugins = usePlugins();
  const memory = useMemory();

  // The conversation machine persists a session's settled status by itself, with
  // no route back here. Fold those records into the list, or the sidebar keeps
  // rendering the pre-write status (its fallback when a session has no live
  // activity) until the next restart.
  useEffect(
    () =>
      onSessionUpdate((session) => send({ type: "SESSION_UPDATED", session })),
    [send],
  );

  // Clicking an OS notification focuses the window (main does that) and lands on
  // the session it was about. The nonce makes a repeat click on the SAME session
  // a fresh request — see `selectSessionRequest`.
  const [selectRequest, setSelectRequest] = useState<{
    sessionId: string;
    nonce: number;
  } | null>(null);
  useEffect(
    () =>
      window.jingler.onNotificationActivated(({ sessionId }) =>
        setSelectRequest((prev) => ({
          sessionId,
          nonce: (prev?.nonce ?? 0) + 1,
        })),
      ),
    [],
  );
  // Keep the module-level cell the conversation registry reads in sync. It can't
  // use a hook: it outlives every component. See `active-session.ts`.
  const onVisibleSessionsChange = useCallback(
    (ids: ReadonlySet<string>) => setVisibleSessionIds(ids),
    [],
  );

  /**
   * Dispatch a palette row to the plugin's host half.
   *
   * Fire-and-forget by design: `Plugins.invoke` returns whatever the handler
   * returned, and the palette has already closed by the time this runs, so there
   * is nowhere on screen left to put a result. A REJECTION is still logged with
   * the plugin's id in the same shape `plugin-activate-on-mount.tsx` uses —
   * a command that silently does nothing is the exact failure the plugin loader
   * refuses manifests to prevent, and it would be perverse to reintroduce it at
   * the dispatch end.
   */
  const runPluginCommand = useCallback(
    (pluginId: string, commandId: string) => {
      void rpc.pluginsInvoke(pluginId, commandId).catch((cause: unknown) => {
        console.error(
          `[plugin:${pluginId}] command "${commandId}" failed:`,
          cause,
        );
      });
    },
    [],
  );

  useSidebarWorkerActivity(sessions.map((session) => session.id));
  const liveActivity = useSessionActivities();
  const liveDiff = useSessionDiffs();
  const planSessions = usePlanSessions();
  const termDock = useTerminalDock();
  const browserDock = usePreviewDock();
  const sessionsLoaded = state.matches("ready");
  useEffect(() => {
    if (!sessionsLoaded) return;
    browserDock.reconcileSessions(sessions.map((session) => session.id));
  }, [browserDock.reconcileSessions, sessions, sessionsLoaded]);
  const qc = useQueryClient();
  const { activeId: activeThemeId, catalog: themeCatalog } = useThemeCatalog();
  const connector = useConnectorCenter();
  const unifiedMcp = useOpenConnector();
  const injectionTargets = useInjectionTargets(unifiedMcp.config);

  // Renderer-side rpc reads, via react-query.
  const configQuery = useQuery({
    queryKey: ["config"],
    queryFn: () => rpc.configGet(),
  });
  const usageQuery = useQuery({
    queryKey: ["usage"],
    queryFn: () => rpc.usageGet(),
    enabled: false,
  });

  const githubConfig = configQuery.data?.github ?? null;
  const gitConfig = configQuery.data?.git ?? null;
  const notificationsConfig = configQuery.data?.notifications ?? null;
  // Absent means on — plan mode's commands are read-only.
  const planAutoRun = configQuery.data?.planAutoRun ?? true;
  // Absent means off — ADHD mode shapes completion summaries, so it remains an
  // opt-in preference rather than a default the operator has to undo.
  const adhdMode = configQuery.data?.adhdMode ?? false;
  // Absent or malformed collapses to 1× (FONT_SCALE_DEFAULT). This value only
  // feeds the Settings control's active preset — the transcript reads the var
  // set in conversation-pane.tsx, so scaling stays scoped there.
  const fontScale = clampFontScale(configQuery.data?.fontScale);
  const providersConfig = configQuery.data?.providers ?? null;
  // Absent means "the first installed harness" — resolved downstream by
  // `newSessionCli`, so a fresh install creates sessions without a visit to
  // Settings.
  const defaultCli = configQuery.data?.defaultCli ?? null;
  const orchestrator = configQuery.data?.orchestrator ?? null;
  const workerRouting = configQuery.data?.workerRouting ?? null;
  const contextConfig = configQuery.data?.context ?? null;
  const starredRepos = configQuery.data?.starredRepos ?? [];
  const collapsedRepos = configQuery.data?.collapsedRepos ?? [];
  const lastRepoPath = configQuery.data?.lastRepoPath ?? null;
  const usage = usageQuery.data ?? null;

  // The usage modal loads on open; GitHub refreshes live through its machine.
  const loadUsage = () => usageQuery.refetch().then(() => undefined);
  const saveGithubConfig = (config: GithubConfig) =>
    rpc.configSetGithub(config).then((saved) => {
      qc.setQueryData(["config"], saved);
    });
  const saveGitConfig = (config: GitConfig) =>
    rpc.configSetGit(config).then((saved) => {
      qc.setQueryData(["config"], saved);
    });
  const saveNotificationsConfig = (config: NotificationsConfig) =>
    rpc.configSetNotifications(config).then((saved) => {
      qc.setQueryData(["config"], saved);
    });
  const savePlanAutoRun = (value: boolean) =>
    rpc.configSetPlanAutoRun(value).then((saved) => {
      qc.setQueryData(["config"], saved);
    });
  const saveAdhdMode = (value: boolean) =>
    rpc.configSetAdhdMode(value).then((saved) => {
      qc.setQueryData(["config"], saved);
    });
  const saveFontScale = (value: number) =>
    rpc.configSetFontScale(value).then((saved) => {
      qc.setQueryData(["config"], saved);
    });

  /**
   * Settings › Themes.
   *
   * The catalog comes from the SAME query key `useTheme` subscribes to, so a
   * write here — select, duplicate, delete, import — repaints the app through
   * the provider without this component knowing anything about CSS. Writes seed
   * the cache directly rather than invalidating: `Theme.save`/`duplicate` return
   * the affected summary, but only `Theme.list` knows the whole ordering, so the
   * catalog is refetched and the config patched in place.
   */
  const refreshThemes = useCallback(
    () => qc.invalidateQueries({ queryKey: themeCatalogKey }),
    [qc],
  );
  const loadTheme = useCallback((id: string) => rpc.themeGet(id), []);
  const themeSettings = {
    themes: themeCatalog?.themes ?? [],
    skipped: themeCatalog?.skipped ?? [],
    activeId: activeThemeId,
    onSelect: (id: string) =>
      rpc.themeSetActive(id).then((saved) => {
        qc.setQueryData(["config"], saved);
      }),
    onDuplicate: (id: string, name?: string) =>
      rpc.themeDuplicate(id, name).then(async (copy) => {
        await refreshThemes();
        return copy;
      }),
    onDelete: async (id: string) => {
      await rpc.themeDelete(id);
      if (id === activeThemeId) {
        const saved = await rpc.themeSetActive(DEFAULT_THEME_ID);
        qc.setQueryData(["config"], saved);
      }
      await refreshThemes();
    },
    onImport: (json: string) =>
      rpc.themeImport(json).then(async (imported) => {
        await refreshThemes();
        return imported;
      }),
    loadTheme,
    onSave: (id: string, theme: VsCodeTheme) =>
      rpc.themeSave(id, theme).then(async (saved) => {
        // The editor debounces, so this fires per settled drag rather than per
        // frame. Refetching keeps the swatch preview in step with the picker.
        await refreshThemes();
        await qc.invalidateQueries({ queryKey: ["theme-source", id] });
        return saved;
      }),
    onReveal: (path: string) => void rpc.themeReveal(path),
  };
  const saveDefaultCli = (cli: CliKind) =>
    rpc.configSetDefaultCli(cli).then((saved) => {
      qc.setQueryData(["config"], saved);
    });
  const saveOrchestrator = (preference: OrchestratorPreference) =>
    rpc.configSetOrchestrator(preference).then((saved) => {
      qc.setQueryData(["config"], saved);
    });
  const saveWorkerRouting = (routing: WorkerRoutingConfig) =>
    rpc.configSetWorkerRouting(routing).then((saved) => {
      qc.setQueryData(["config"], saved);
    });
  const saveProvider = (cli: CliKind, config: ProviderConfig) =>
    rpc.configSetProvider(cli, config).then((saved) => {
      qc.setQueryData(["config"], saved);
    });
  const saveContextConfig = (config: ContextConfig) =>
    rpc.configSetContext(config).then((saved) => {
      qc.setQueryData(["config"], saved);
      // Every session's trigger point moves with the budget, so drop the cached
      // snapshots rather than leaving meters reading against the old one.
      void qc.invalidateQueries({ queryKey: ["context"] });
    });
  const savePlanTemplate = (template: { readonly source: string }) =>
    rpc.configSetPlanTemplate(template).then((saved) => {
      qc.setQueryData(["config"], saved);
    });

  // Toggle a repo's starred state, persist the whole list, and update the cache.
  const toggleStar = (repoPath: string) => {
    const next = starredRepos.includes(repoPath)
      ? starredRepos.filter((p) => p !== repoPath)
      : [...starredRepos, repoPath];
    return rpc.configSetStarredRepos(next).then((saved) => {
      qc.setQueryData(["config"], saved);
    });
  };
  // Toggle a repo's collapsed state (path-keyed; "__archived__" collapses the
  // Archived group), persist the whole list, and update the cache.
  const toggleCollapsed = (repoPath: string) => {
    const next = collapsedRepos.includes(repoPath)
      ? collapsedRepos.filter((p) => p !== repoPath)
      : [...collapsedRepos, repoPath];
    return rpc.configSetCollapsedRepos(next).then((saved) => {
      qc.setQueryData(["config"], saved);
    });
  };
  // Remember the repo a session was created from so the dialog can preselect it.
  const rememberLastRepo = (repoPath: string) =>
    rpc.configSetLastRepoPath(repoPath).then((saved) => {
      qc.setQueryData(["config"], saved);
    });

  const createSession = async (input: CreateSessionInput) => {
    const session = await rpc.sessionsCreate(input);
    void rememberLastRepo(input.repoPath);
    send({ type: "SESSION_CREATED", session });
    return session;
  };
  const createSessionFromPr = async (input: CreateSessionFromPrInput) => {
    const session = await rpc.sessionsCreateFromPr(input);
    void rememberLastRepo(input.repoPath);
    send({ type: "SESSION_CREATED", session });
    return session;
  };
  const createSessionFromIssue = async (input: CreateSessionFromIssueInput) => {
    const session = await rpc.sessionsCreateFromIssue(input);
    void rememberLastRepo(input.repoPath);
    send({ type: "SESSION_CREATED", session });
    return session;
  };
  const onPrLinked = useCallback(
    (sessionId: string, prNumber: number) =>
      send({ type: "SESSION_PR_LINKED", sessionId, prNumber }),
    [send],
  );
  const onPublishCheckpoint = useCallback(
    (sessionId: string, checkpoint: PublishCheckpoint) =>
      send({ type: "SESSION_PUBLISH_UPDATED", sessionId, checkpoint }),
    [send],
  );

  // Unlinking an issue used to live here, wired to the built-in Issue tab's
  // `onUnlink`. That tab retired in favour of the github-issues plugin and this
  // callback was left declared and unreferenced — the capability simply vanished
  // from the UI. It now belongs to the plugin, through
  // `useSessionActions().unlinkIssue`, which routes the same RPC and republishes
  // the updated record via `session-updates.ts` so this machine still sees it.

  // The composer consumed the one-shot prompt: clear it (backend returns the
  // updated session) so re-opening the session never re-seeds the draft.
  const consumeInitialPrompt = (sessionId: string) =>
    void rpc
      .sessionsClearInitialPrompt(sessionId)
      .then((session) => send({ type: "SESSION_UPDATED", session }));

  const restoreSession = async (sessionId: string) => {
    const session = await rpc.sessionsRestore(sessionId);
    send({ type: "SESSION_UPDATED", session });
  };
  // Delete is destructive (removes the worktree) — confirm first. Holds the
  // session pending confirmation; the ConfirmDialog fires `deleteSession`.
  const [pendingDelete, setPendingDelete] = useState<Session | null>(null);
  const [sessionMutationError, setSessionMutationError] = useState<
    string | null
  >(null);
  // Manual archive from the sidebar quick-actions. The store only models a
  // merged/closed reason, so a hand-archived session records "closed".
  const archiveSession = async (sessionId: string) => {
    setSessionMutationError(null);
    try {
      const session = await rpc.sessionsArchive(sessionId, "closed");
      send({ type: "SESSION_UPDATED", session });
    } catch (error) {
      setSessionMutationError(
        error instanceof Error ? error.message : "Could not archive the session.",
      );
      throw error;
    }
  };
  const renameSession = (sessionId: string, title: string) => {
    void rpc
      .sessionsRename(sessionId, title)
      .then((session) => send({ type: "SESSION_UPDATED", session }));
  };
  const setSessionPersistent = async (
    sessionId: string,
    persistent: boolean,
  ): Promise<void> => {
    setSessionMutationError(null);
    try {
      const session = await rpc.sessionsSetPersistent(sessionId, persistent);
      send({ type: "SESSION_UPDATED", session });
    } catch (error) {
      setSessionMutationError(
        error instanceof Error
          ? error.message
          : "Could not update the persistent session.",
      );
    }
  };
  const deleteSession = async (sessionId: string) => {
    const chatIds =
      sessions
        .find((session) => session.id === sessionId)
        ?.chats.map((chat) => chat.id) ?? [];
    await flushPlanDocument(sessionId).catch(() => {});
    await rpc.sessionsDelete(sessionId);
    browserDock.removeSession(sessionId);
    // Stop the persistent conversation actor for a deleted session (it's kept
    // running across session switches, so it won't be torn down by unmount).
    disposeConversationActor(sessionId);
    disposeFileBrowserActor(sessionId);
    clearPlanAutoPresentation(sessionId);
    stopPlanDocument(sessionId);
    // Same reasoning for the composer draft — it outlives the pane by design, so
    // nothing else would ever collect it (and it's persisted).
    for (const chatId of chatIds) clearDraft(chatId);
    clearViewedPaths(sessionId);
    send({ type: "SESSION_DELETED", sessionId });
  };

  const accessForSession = useCallback(
    (session: Session) => {
      const repo = repos.find(
        (candidate) =>
          candidate.path === session.repoPath ||
          candidate.name === session.repo,
      );
      return repositoryAccess(
        github.connection,
        repo?.githubSlug ?? null,
        session.githubRepositoryId ?? null,
      );
    },
    [github.connection, repos],
  );
  const canUseGitHubForSession = useCallback(
    (session: Session) => accessForSession(session).status === "accessible",
    [accessForSession],
  );
  const connected =
    github.connection.connected &&
    github.connection.installations.some(
      (installation) => installation.status === "active",
    );
  const autoDetect = connected && (githubConfig?.autoDetectPr ?? true);
  const autoCreate =
    connected &&
    (githubConfig?.enabled ?? false) &&
    (githubConfig?.autoCreatePr ?? false);
  const autoPublishCancels = useRef(new Map<string, () => void>());
  const startAutoPublish = useCallback(
    (session: Session) => {
      if (
        !(autoCreate && canUseGitHubForSession(session)) ||
        session.archived ||
        session.prNumber !== null ||
        workspaceModeOf(session) !== "worktree" ||
        session.semanticBranchPending === true ||
        session.publish?.step === "complete" ||
        autoPublishCancels.current.has(session.id)
      )
        return;

      const cancel = rpc.githubPublish(session.id, (checkpoint) => {
        onPublishCheckpoint(session.id, checkpoint);
        if (
          checkpoint.step === "complete" &&
          checkpoint.prNumber !== undefined
        ) {
          onPrLinked(session.id, checkpoint.prNumber);
        }
        if (["complete", "failed", "no-changes"].includes(checkpoint.step)) {
          autoPublishCancels.current.delete(session.id);
        }
      });
      autoPublishCancels.current.set(session.id, cancel);
    },
    [autoCreate, canUseGitHubForSession, onPrLinked, onPublishCheckpoint],
  );
  useEffect(
    () => () => {
      for (const cancel of autoPublishCancels.current.values()) cancel();
      autoPublishCancels.current.clear();
    },
    [],
  );
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;

  const feedbackRouter = useMemo(
    () =>
      new GitHubFeedbackRouter({
        claim: (target, event) =>
          rpc.githubClaimFeedback({
            operation: "claim",
            sessionId: target.sessionId,
            installationId: target.installationId,
            repositoryId: target.repositoryId,
            prNumber: target.prNumber,
            deliveryId: event.deliveryId,
            semanticKey: event.semanticKey,
            event,
          }),
        markDispatched: async (target, event) =>
          (await rpc.githubClaimFeedback({
            operation: "mark-dispatched",
            sessionId: target.sessionId,
            installationId: target.installationId,
            repositoryId: target.repositoryId,
            prNumber: target.prNumber,
            deliveryId: event.deliveryId,
            semanticKey: event.semanticKey,
            event,
          })) === "dispatched",
        invalidate: () => {
          void qc.invalidateQueries({ queryKey: ["github"] });
          void qc.invalidateQueries({ queryKey: ["pr-state"] });
        },
        dispatch: async ({ sessionId, chatId, text, externalInstruction }) => {
          const session = sessionsRef.current.find(
            (candidate) => candidate.id === sessionId,
          );
          if (!session || session.archived) {
            throw new Error(
              `GitHub feedback session ${sessionId} is no longer active`,
            );
          }
          const conversation = getConversationActor(session, chatId);
          if (!conversation.getSnapshot().context.loaded) {
            await new Promise<void>((resolve) => {
              const subscription = conversation.subscribe((snapshot) => {
                if (!snapshot.context.loaded) return;
                subscription.unsubscribe();
                resolve();
              });
            });
          }
          const alreadyDurable = conversation
            .getSnapshot()
            .context.messages.some(
              (message) =>
                message.externalInstruction?.deliveryId ===
                  externalInstruction.deliveryId ||
                message.externalInstruction?.semanticKey ===
                  externalInstruction.semanticKey,
            );
          if (alreadyDurable) return;
          // SEND is the same visible conversation intent used by the composer.
          // While an agent is running, the conversation machine owns steering
          // or FIFO queueing; this never starts a hidden parallel run.
          await new Promise<void>((resolve) => {
            conversation.send({
              type: "SEND",
              text,
              externalInstruction,
              onExternalAccepted: resolve,
            });
          });
        },
      }),
    [qc],
  );

  useEffect(() => {
    if (!connected) return;
    const cancelEvents = rpc.githubEvents(
      (delivery) => {
        const session = sessionsRef.current.find(
          (candidate) => candidate.id === delivery.sessionId,
        );
        const target =
          session?.githubInstallationId &&
          session.githubRepositoryId &&
          session.prNumber !== null
            ? {
                sessionId: delivery.sessionId,
                chatId: delivery.chatId,
                installationId: session.githubInstallationId,
                repositoryId: session.githubRepositoryId,
                prNumber: session.prNumber,
                archived: Boolean(session.archived),
              }
            : undefined;

        if (!target) {
          console.error(
            `GitHub feedback relay route ${delivery.relaySessionId} does not match an active local session; withholding acknowledgement.`,
          );
          return;
        }
        void feedbackRouter
          .route(delivery.event, target)
          // Main selected this exact session from its opaque relay connection;
          // renderer never searches by repository or pull-request payload.
          .then(() => rpc.githubAckEvent(delivery.clientId, delivery.cursor))
          .catch((cause: unknown) => {
            console.error(
              "GitHub feedback delivery failed; withholding acknowledgement:",
              cause,
            );
          });
      },
      (status) => {
        const key = status.relaySessionId ?? "relay-supervisor";
        applyRelayHealthUpdate(relayStatuses.current, key, status);
        const unhealthy = [...relayStatuses.current.values()].find(
          (candidate) =>
            candidate.mode === "error" || candidate.mode === "reconnecting",
        );
        if (!unhealthy) {
          // Recovered (or never troubled): drop any pending grace timer and hide.
          if (relayGraceTimer.current !== null) {
            clearTimeout(relayGraceTimer.current);
            relayGraceTimer.current = null;
          }
          relayBannerVisible.current = false;
          setRelayError(null);
          return;
        }
        // Trouble: arm the grace window once (do NOT restart it on every
        // subsequent "reconnecting", or a genuine loop would keep resetting it
        // and never surface). Show only if still unhealthy when it elapses.
        if (!relayBannerVisible.current && relayGraceTimer.current === null) {
          relayGraceTimer.current = setTimeout(() => {
            relayGraceTimer.current = null;
            const stillUnhealthy = [...relayStatuses.current.values()].find(
              (candidate) =>
                candidate.mode === "error" || candidate.mode === "reconnecting",
            );
            if (stillUnhealthy) {
              relayBannerVisible.current = true;
              setRelayError(
                stillUnhealthy.error ?? "GitHub feedback relay is unavailable",
              );
            }
          }, RELAY_UNHEALTHY_GRACE_MS);
        }
      },
    );
    return () => {
      if (relayGraceTimer.current !== null) {
        clearTimeout(relayGraceTimer.current);
        relayGraceTimer.current = null;
      }
      cancelEvents();
    };
  }, [connected, feedbackRouter]);

  // Continuously resolve the OPEN PR on every live worktree branch. Sessions can
  // outlive a merged PR and open a replacement, so linked sessions stay in the
  // sweep. Read the latest sessions through a ref so ordinary session updates do
  // not restart the interval and immediately re-scan every worktree.
  useEffect(() => {
    if (!autoDetect) return;
    const detect = () => {
      for (const session of sessionsRef.current) {
        if (
          !session.worktreePath ||
          session.archived ||
          !canUseGitHubForSession(session)
        ) {
          continue;
        }
        void rpc
          .githubDetectPr(session.id)
          .then((prNumber) => {
            if (prNumber !== null && prNumber !== session.prNumber) {
              send({
                type: "SESSION_PR_LINKED",
                sessionId: session.id,
                prNumber,
              });
            }
          })
          .catch(() => {});
      }
    };
    detect();
    const timer = window.setInterval(detect, ARCHIVE_POLL_MS);
    return () => window.clearInterval(timer);
  }, [autoDetect, canUseGitHubForSession, send]);

  // When a session's live run COMPLETES (its live status goes present → absent),
  // do two independent things:
  //  1. Auto-retitle it (the agent may have started/shifted the work this turn) —
  //     runs regardless of GitHub; the RPC folds to a heuristic if there's no LLM.
  //  2. Re-check GitHub (the agent may have opened AND merged its own PR this run):
  //     the once-per-session detectedRef guard can't catch a mid-run PR, and the
  //     60s poll would lag — so re-detect the link + invalidate the cached pr-state.
  const prevLiveRef = useRef<Record<string, SessionActivity>>({});
  useEffect(() => {
    const prev = prevLiveRef.current;
    prevLiveRef.current = liveActivity;
    const completed = completedSessionIds(prev, liveActivity, sessions);
    for (const id of completed) {
      const current = sessions.find((session) => session.id === id);
      if (!current) continue;
      // Only auto-named sessions retitle; skip pinned/legacy ones (autoTitle not
      // explicitly true) to avoid a needless RPC. The handler guards too.
      const ready = needsSessionRetitle(current)
        ? rpc.sessionsRetitle(id).then((session) => {
            // SESSION_UPDATED replaces the whole record; it re-reads the store at
            // the end so it converges with concurrent PR/publish checkpoints.
            send({ type: "SESSION_UPDATED", session });
            return session;
          })
        : Promise.resolve(current);
      // Manual and preference-driven publication enter the same main-process
      // single-flight state machine. Retitling resolves first so a fresh task is
      // never asked to publish while it is still detached.
      void ready.then(startAutoPublish).catch(() => {});
    }
    if (!autoDetect) return;
    for (const id of completed) {
      const session = sessions.find((candidate) => candidate.id === id);
      if (!(session && canUseGitHubForSession(session))) continue;
      void rpc.githubDetectPr(id).then((n) => {
        if (n != null) {
          send({ type: "SESSION_PR_LINKED", sessionId: id, prNumber: n });
        }
      });
      // Partial key (id only) — matches regardless of the linked PR number.
      void qc.invalidateQueries({ queryKey: ["pr-state", id] });
    }
  }, [
    liveActivity,
    sessions,
    autoDetect,
    canUseGitHubForSession,
    send,
    qc,
    startAutoPublish,
  ]);

  // Retitle a session as soon as it has a PLAN — a run that plans then executes
  // stays "present" (thinking/needs-input) throughout, so the on-completion
  // retitle above wouldn't fire until the whole thing finishes, leaving the
  // sidebar stuck on "Untitled" through a long build. A proposed plan is already
  // strong signal, so we retitle on the absent → present edge of plan presence.
  const prevPlanRef = useRef<ReadonlySet<string>>(new Set());
  useEffect(() => {
    const prev = prevPlanRef.current;
    prevPlanRef.current = planSessions;
    for (const id of newlyPlannedSessionIds(prev, planSessions, sessions)) {
      void rpc
        .sessionsRetitle(id)
        .then((session) => send({ type: "SESSION_UPDATED", session }))
        .catch(() => {});
    }
  }, [planSessions, sessions, send]);

  // PR-state sweep: track each linked PR's merged/closed state and BADGE the row.
  //
  // This used to auto-archive the session the moment its PR merged. That was
  // wrong: a session holds a single `prNumber`, but one session routinely
  // outlives several PRs (open one, merge it, keep working off the same worktree
  // and open the next). Merging PR #204 therefore said nothing about whether the
  // WORK was done, and a live multi-PR session would silently vanish from the
  // sidebar mid-flight. Retiring a session is now always the operator's call —
  // the badge reports, it doesn't act.
  const sweepTargets = useMemo(
    () =>
      sessions.filter(
        (session) =>
          session.prNumber != null &&
          Boolean(session.worktreePath) &&
          !session.archived &&
          canUseGitHubForSession(session),
      ),
    [canUseGitHubForSession, sessions],
  );
  const prStates = useQueries({
    queries: sweepTargets.map((s) => ({
      queryKey: ["pr-state", s.id, s.prNumber] as const,
      queryFn: () => rpc.githubPrState(s.id),
      enabled: connected,
      staleTime: PR_STATE_STALE_MS,
      // Poll so a PR merged/closed on GitHub badges its session live instead of
      // only on a cold app relaunch (the query would otherwise never re-fetch).
      refetchInterval: ARCHIVE_POLL_MS,
      refetchIntervalInBackground: true,
      refetchOnWindowFocus: true,
    })),
    combine: (results) =>
      Object.fromEntries(
        sweepTargets.flatMap((s, i) => {
          const state = results[i]?.data;
          return state ? [[s.id, state] as const] : [];
        }),
      ),
  });
  // The lifecycle half of the same poll, for the pure sweep functions below.
  //
  // Those two ask exactly one question — "has this PR resolved?" — and the CI
  // rollup would be noise in their signature and in their tests. Derived here
  // rather than fetched twice: one poll, two shapes.
  const prLifecycle = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(prStates).map(([id, pr]) => [id, pr.state] as const),
      ),
    [prStates],
  );

  // Auto adversarial review (opt-in). Polls `Review.run` on the same cadence as
  // the archive sweep, which sounds expensive but isn't: the main process
  // short-circuits on an unchanged PR head, so a tick with no new commits costs
  // one GitHub API read and spawns nothing. That server-side de-dupe is why this
  // needs no client-side "already reviewed this SHA" guard of its own — the
  // renderer can fire naively and stay correct.
  // Gated on `enabled` as well as the toggle itself: turning PR features off must
  // stop reviews too, and a config can carry autoAdversarialReview:true from
  // before the master switch was flipped off. A review costs real tokens, so it
  // fails closed.
  const autoReview =
    connected &&
    (githubConfig?.enabled ?? false) &&
    (githubConfig?.autoAdversarialReview ?? false);
  const reviewTargets = useMemo(
    () => (autoReview ? sweepTargets : []),
    [autoReview, sweepTargets],
  );
  const autoReviews = useQueries({
    queries: reviewTargets.map((s) => ({
      queryKey: ["auto-review", s.id, s.prNumber] as const,
      queryFn: () => rpc.reviewRun(s.id, false),
      staleTime: PR_STATE_STALE_MS,
      refetchInterval: ARCHIVE_POLL_MS,
      refetchIntervalInBackground: true,
      refetchOnWindowFocus: true,
      // A reviewer that can't run (API failure, harness missing) must never retry
      // in a loop or surface anywhere — the manual button remains the recourse.
      retry: false,
    })),
    /**
     * Keyed off the review's OWN `sessionId`, never the query's position.
     *
     * This used to zip `reviewTargets[i]` with `results[i]`. That pairing is only
     * sound while both arrays stay the same length in the same order, and
     * `reviewTargets` derives from `sweepTargets`, which filters `!s.archived` —
     * so archiving ANY session shifts every later index by one and welds one
     * session's id onto another session's review. The observed damage: a session
     * was handed the findings from a different session's PR, which it published
     * into its cache AND routed to its agent, spending a real turn arguing about
     * a file that does not exist on its branch.
     *
     * The review carries the id it belongs to. Use it, and let a result with no
     * data drop out rather than shift everything behind it.
     */
    combine: (results) =>
      results.flatMap((r) => {
        const review = r?.data;
        return review ? [{ id: review.sessionId, review }] : [];
      }),
  });
  // Publish auto-review results into the cache the PR tab reads, so findings
  // appear without the user having to click Review.
  useEffect(() => {
    for (const { id, review } of autoReviews) {
      qc.setQueryData(reviewQueryKey(id, review.prNumber), review);
    }
  }, [autoReviews, qc]);

  // Hand each new review's critical/major findings to that session's agent.
  //
  // Here rather than in `useAdversarialReview` because that hook only exists for
  // the session you're LOOKING at, and the whole point of the auto-review is that
  // it runs across every session on a timer — a background session's reviewer
  // finding a data-loss bug should reach its agent whether or not the tab is
  // open. `routeReviewToAgent` no-ops on an already-routed review (a stamp
  // persisted in main), so firing it on every tick is safe.
  useEffect(() => {
    for (const { id, review } of autoReviews) {
      const session = sessions.find((s) => s.id === id);
      if (session) void routeReviewToAgent(session, review, qc);
    }
  }, [autoReviews, sessions, qc]);

  // Close-on-merge automation. Decoupled from archiving (which no longer happens
  // automatically): closing the linked ISSUE when its PR merges is a statement
  // about the issue, not about whether the session is finished, so it still fires
  // on merge. Once per session — the ref guards against the poll re-firing it on
  // every tick, since a merged PR stays merged forever.
  const closedIssuesRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const id of issuesToCloseOnMerge(
      prLifecycle,
      sessions,
      closedIssuesRef.current,
    )) {
      closedIssuesRef.current.add(id);
      void rpc.githubCloseIssue(id).catch(() => {});
    }
  }, [prLifecycle, sessions]);

  // Tell the operator when a session's PR resolves on GitHub. Guarded by its own
  // ref for the same reason as the issue-closing sweep above: the poll re-runs
  // every minute and a merged PR stays merged, so without this it would announce
  // the same merge forever.
  const notifiedPrsRef = useRef<Set<string>>(new Set());
  // Whether the first poll of this launch has been absorbed. Everything it
  // reports is PRE-EXISTING — merged is permanent, but this ref is memory-only,
  // so without a baseline every launch would re-announce every already-merged
  // session in the sidebar. The first poll is recorded silently; only later
  // transitions are news. Same rule the transcript notifier applies to a
  // restored session.
  const prBaselineRef = useRef(false);
  useEffect(() => {
    // An empty first result is the "still loading" state, not a real baseline —
    // taking it would let the genuine first result through as an edge.
    const seeding =
      !prBaselineRef.current && Object.keys(prLifecycle).length > 0;
    for (const { session, state: prState } of prsToNotify(
      prLifecycle,
      sweepTargets,
      notifiedPrsRef.current,
    )) {
      notifiedPrsRef.current.add(session.id);
      if (seeding) continue;
      const plan = prNotification(session.title, prState);
      void rpc
        .notifyShow({
          sessionId: session.id,
          kind: plan.kind,
          title: plan.title,
          body: plan.body,
          // A resolved PR is worth surfacing even while its session is open —
          // the merge happened on GitHub, not here, so there is nothing on
          // screen that already told them.
          isActiveSession: false,
        })
        .catch(() => {});
    }
    if (seeding) prBaselineRef.current = true;
  }, [prLifecycle, sweepTargets]);

  useEffect(() => {
    if (!state.matches({ setup: "github" })) return;
    if (!github.connection.connected) return;
    if (
      !github.connection.installations.some(
        (installation) => installation.status === "active",
      )
    )
      return;
    send({ type: "GITHUB_CONNECTED" });
  }, [state, github.connection, send]);

  const splashHeld = useSplashHold();

  // The splash outstays the boot when the boot is quicker than the brand
  // animation — see `useSplashHold`. Without it the shader's source image is
  // still decoding when the machine leaves `starting`, so the mark never draws
  // and the whole splash reads as a black flash.
  if (splashHeld || state.matches("loading") || state.matches("starting")) {
    return <LoadingScreen />;
  }

  if (state.matches("failure")) {
    return (
      <div className="flex h-screen items-center justify-center bg-canvas p-8">
        <div className="max-w-md rounded-lg border border-red/50 bg-sunken px-4 py-3 font-mono text-[13px] text-red">
          Failed to load: {state.context.error}
        </div>
      </div>
    );
  }

  if (state.matches("setup")) {
    return (
      <SetupScreen
        step={state.matches({ setup: "github" }) ? "github" : "workspace"}
        clis={clis}
        github={github.connection}
        repos={repos}
        reposDir={reposDir}
        busy={
          state.matches({ setup: { workspace: "choosing" } }) || github.busy
        }
        onChooseDir={() => send({ type: "CHOOSE" })}
        onContinue={() => send({ type: "CONTINUE" })}
        onConnectGithub={
          github.connection.connected ? github.manage : github.connect
        }
        onSkipGithub={() => send({ type: "SKIP_GITHUB" })}
      />
    );
  }

  return (
    <>
      {relayError && (
        <div
          role="status"
          className="fixed left-1/2 top-2 z-50 -translate-x-1/2 rounded-md border border-line bg-sunken px-3 py-2 text-xs text-text shadow-lg"
        >
          GitHub feedback is reconnecting. {relayError}
        </div>
      )}
      <JinglerApp
        clis={clis}
        tabContributions={pluginTabs}
        paneContributions={pluginPanes}
        pluginCommands={pluginCommands}
        onRunPluginCommand={runPluginCommand}
        selectSessionRequest={selectRequest}
        onVisibleSessionsChange={onVisibleSessionsChange}
        sessions={sessions}
        user={user}
        memory={{
          eligible: memory.eligible,
          active: memory.active,
          content: <MemoryWorkspace memory={memory} />,
          onOpen: memory.open,
          onClose: memory.close,
        }}
        onSignOut={onSignOut}
        repos={repos}
        starredRepos={starredRepos}
        onToggleStar={toggleStar}
        collapsedRepos={collapsedRepos}
        onToggleCollapsed={toggleCollapsed}
        defaultRepoPath={lastRepoPath}
        githubConnection={github.connection}
        githubBusy={github.busy}
        onGithubConnect={github.connect}
        onGithubManage={github.manage}
        onGithubRefresh={github.refresh}
        onGithubDisconnect={github.disconnect}
        liveActivity={liveActivity}
        prStates={prStates}
        liveDiff={liveDiff}
        usage={usage}
        onLoadUsage={loadUsage}
        githubConfig={githubConfig}
        onSaveGithubConfig={saveGithubConfig}
        gitConfig={gitConfig}
        onSaveGitConfig={saveGitConfig}
        notificationsConfig={notificationsConfig}
        onSaveNotificationsConfig={saveNotificationsConfig}
        planAutoRun={planAutoRun}
        onSavePlanAutoRun={savePlanAutoRun}
        adhdMode={adhdMode}
        onSaveAdhdMode={saveAdhdMode}
        fontScale={fontScale}
        onSaveFontScale={saveFontScale}
        themes={themeSettings}
        plugins={plugins}
        providersConfig={providersConfig}
        onSaveProvider={saveProvider}
        defaultCli={defaultCli}
        onSaveDefaultCli={saveDefaultCli}
        orchestrator={orchestrator}
        onSaveOrchestrator={saveOrchestrator}
        workerRouting={workerRouting}
        onSaveWorkerRouting={saveWorkerRouting}
        contextConfig={contextConfig}
        onSaveContextConfig={saveContextConfig}
        planTemplate={configQuery.data?.planTemplate ?? null}
        onSavePlanTemplate={savePlanTemplate}
        loadModels={rpc.modelsList}
        loadOpencodeProviders={rpc.opencodeListProviders}
        onSetOpencodeAuth={rpc.opencodeSetAuth}
        unifiedMcp={unifiedMcp}
        injection={{
          targets: injectionTargets.targets,
          loading: injectionTargets.loading,
          onToggle: injectionTargets.setEnabled,
        }}
        connector={connector}
        loadBranches={rpc.workspaceBranches}
        onCreateSession={createSession}
        onRenameSession={renameSession}
        onSetSessionPersistent={setSessionPersistent}
        onArchiveSession={archiveSession}
        onRestoreSession={restoreSession}
        onDeleteSession={(id) =>
          setPendingDelete(sessions.find((s) => s.id === id) ?? null)
        }
        loadPrs={connected ? rpc.githubListPrs : undefined}
        onCreateSessionFromPr={connected ? createSessionFromPr : undefined}
        loadIssues={connected ? rpc.githubListIssues : undefined}
        onCreateSessionFromIssue={
          connected ? createSessionFromIssue : undefined
        }
        planSessions={planSessions}
        renderConversation={(session: Session, view, ctx) => (
          <ConversationPane
            session={session}
            view={view}
            onOpenPlanReview={ctx.onOpenPlanReview}
            onPlanDraftAvailable={ctx.onPlanDraftAvailable}
            planStepId={ctx.planStepId}
            onPlanStepSelected={ctx.onPlanStepSelected}
            onRestore={restoreSession}
            onDelete={deleteSession}
            onInitialPromptConsumed={consumeInitialPrompt}
            onOpenFile={(_sessionId, path) => ctx.onOpenFile(path)}
            paneFocused={ctx.paneFocused ?? true}
          />
        )}
        renderFiles={(session, ctx) => (
          <FileBrowserView
            session={session}
            onSendReference={(reference) => {
              addDraftCodeReference(session.activeChatId, reference);
              ctx.onSelectConversation();
            }}
          />
        )}
        onOpenFile={openSessionFile}
        renderFileQuickOpen={(session, ctx) => (
          <FileBrowserQuickOpen
            session={session}
            open={ctx.open}
            onOpenChange={ctx.onOpenChange}
            onOpenPath={ctx.onOpenPath}
          />
        )}
        renderChatTabs={(session: Session, ctx) => (
          <SessionChatTabs
            session={session}
            filesActive={ctx.activeTabId === "files"}
            onSelectConversation={ctx.onSelectConversation}
            onSelectFiles={ctx.onSelectFiles}
          />
        )}
        renderPullRequest={(session, ctx) => {
          const access = accessForSession(session);
          const sessionConnected =
            github.connection.connected && access.status === "accessible";
          return (
            <PullRequestPane
              session={session}
              connected={sessionConnected}
              autoDetect={sessionConnected && autoDetect}
              viewerLogin={github.connection.user?.login}
              connectionMessage={
                github.connection.connected
                  ? access.reason
                  : "Connect the GitHub App to create and review pull requests."
              }
              connectionActionLabel={
                access.status === "suspended"
                  ? "Repair GitHub access"
                  : github.connection.connected
                    ? "Manage repositories"
                    : "Connect GitHub"
              }
              onConnectGithub={ctx.onConnectGithub}
              onPrLinked={onPrLinked}
              onPublishCheckpoint={onPublishCheckpoint}
            />
          );
        }}
        renderReview={(session, ctx) => {
          const access = accessForSession(session);
          const sessionConnected =
            github.connection.connected && access.status === "accessible";
          return (
            <ReviewPane
              key={`${session.id}:${session.prNumber ?? "none"}`}
              session={session}
              connected={sessionConnected}
              connectionMessage={
                github.connection.connected ? access.reason : undefined
              }
              connectionActionLabel={
                github.connection.connected
                  ? "Manage repositories"
                  : "Connect GitHub"
              }
              onConnectGithub={ctx.onConnectGithub}
            />
          );
        }}
        renderCode={(session, ctx) => {
          const access = accessForSession(session);
          const sessionConnected =
            github.connection.connected && access.status === "accessible";
          return (
            <ReviewPane
              key={`${session.id}:${session.prNumber ?? "none"}`}
              session={session}
              connected={sessionConnected}
              connectionMessage={
                github.connection.connected ? access.reason : undefined
              }
              connectionActionLabel={
                github.connection.connected
                  ? "Manage repositories"
                  : "Connect GitHub"
              }
              onConnectGithub={ctx.onConnectGithub}
            />
          );
        }}
        terminalDockSide={termDock.side}
        // The palette's route to the same toggle ⌃` drives. The dock's visibility
        // is this file's state, so without these two props the shell can lay the
        // dock out but cannot ask for it.
        onToggleTerminal={termDock.toggle}
        terminalActive={termDock.visible}
        renderTerminalDock={(session) => (
          <TerminalDockView
            session={session}
            visible={termDock.visible}
            onToggle={termDock.toggle}
            side={termDock.side}
            onSideChange={termDock.setSide}
          />
        )}
        browserDockSide={browserDock.side}
        browserActive={browserDock.visible}
        onToggleBrowser={browserDock.toggle}
        renderBrowserDock={(session) => (
          <PreviewDockView session={session} dock={browserDock} />
        )}
        version={__APP_VERSION__}
      />
      {sessionMutationError !== null && (
        <div
          role="alert"
          className="fixed bottom-4 right-4 z-[100] flex max-w-sm items-start gap-3 rounded-lg border border-red/50 bg-sunken px-4 py-3 text-[12px] text-red shadow-2xl"
        >
          <span className="min-w-0 flex-1">{sessionMutationError}</span>
          <button
            type="button"
            aria-label="Dismiss persistence error"
            onClick={() => setSessionMutationError(null)}
            className="flex-none rounded px-1 text-red outline-none hover:bg-surface focus-visible:ring-2 focus-visible:ring-ring"
          >
            ×
          </button>
        </div>
      )}
      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
        title="Delete session?"
        description={
          pendingDelete
            ? workspaceModeOf(pendingDelete) === "direct"
              ? `“${pendingDelete.title}” session data will be permanently removed. The repository checkout will be left untouched. This can't be undone.`
              : `“${pendingDelete.title}” and its isolated worktree will be permanently removed. This can't be undone.`
            : undefined
        }
        confirmLabel="Delete"
        tone="danger"
        onConfirm={async () => {
          if (!pendingDelete) return;
          setSessionMutationError(null);
          try {
            await deleteSession(pendingDelete.id);
          } catch (error) {
            setSessionMutationError(
              error instanceof Error ? error.message : "Could not delete the session.",
            );
            throw error;
          }
        }}
      />
    </>
  );
}

/** Map the auth machine's signed-out substate to the LoginScreen's visual state. */
function loginStateOf(
  matches: (value: object) => boolean,
): "default" | "loading" | "sent" | "error" {
  if (
    matches({ signedOut: "sending" }) ||
    matches({ signedOut: "oauthPending" })
  )
    return "loading";
  if (matches({ signedOut: "magicLinkSent" })) return "sent";
  if (matches({ signedOut: "error" })) return "error";
  return "default";
}

/**
 * The auth gate. Drives the dedicated `authMachine` and renders the sign-in wall
 * until it reaches `signedIn`, at which point the real app (`AuthedApp`) mounts.
 * The `jingler://` deep-link callback arrives from the main process via the
 * preload bridge and re-validates the freshly-stored token.
 */
export function App() {
  const [authState, authSend] = useMachine(authMachine);

  /**
   * The theme is applied ABOVE the sign-in wall, not inside it.
   *
   * The loading splash and the login screen are the first things an operator
   * sees, and they are on screen for the longest at the moment the app has the
   * least state. Theming only the signed-in app would mean launching into a
   * dark login screen and having it turn light the instant auth resolved —
   * exactly the flash `boot-theme.ts` exists to prevent, just moved later.
   *
   * Sharing the `["config"]` query key with `AuthedApp` means React Query
   * dedupes this: it is the same in-flight request, not a second read.
   */
  const configQuery = useQuery({
    queryKey: ["config"],
    queryFn: () => rpc.configGet(),
  });
  const theme = useTheme(configQuery.data);

  useEffect(() => {
    const unsubscribe = window.jingler.onAuthComplete((payload) => {
      if (payload.ok) authSend({ type: "CALLBACK" });
    });
    return unsubscribe;
  }, [authSend]);

  return (
    <ThemeProvider
      tokens={theme.tokens}
      applyToDocument={theme.ready}
      activeId={theme.activeId}
      catalog={theme.catalog}
      theme={theme.theme}
    >
      {/*
        Inside ThemeProvider so a plugin's tab renders against the operator's
        theme tokens from its first frame, and OUTSIDE the sign-in wall for the
        same reason the theme is: the plugin catalog is read from disk and has
        nothing to do with who is signed in, so loading it here means the tabs
        are ready the instant auth resolves rather than a beat afterwards.
      */}
      <PluginProvider>
        <AppContent authState={authState} authSend={authSend} />
      </PluginProvider>
    </ThemeProvider>
  );
}

function AppContent({
  authState,
  authSend,
}: {
  authState: ReturnType<typeof useMachine<typeof authMachine>>[0];
  authSend: ReturnType<typeof useMachine<typeof authMachine>>[1];
}) {
  // Both splash mounts consult the same floor, and the floor is measured from
  // app start rather than from mount — so the auth check and the boot machine
  // share one hold between them instead of queueing two.
  const splashHeld = useSplashHold();

  if (
    splashHeld ||
    authState.matches("checking") ||
    authState.matches("signingOut")
  ) {
    return <LoadingScreen />;
  }

  if (!authState.matches("signedIn")) {
    return (
      <LoginScreen
        state={loginStateOf((value) => authState.matches(value as never))}
        sentEmail={authState.context.sentEmail ?? undefined}
        errorMessage={authState.context.error ?? undefined}
        onGithub={() => authSend({ type: "OAUTH", provider: "github" })}
        onGoogle={() => authSend({ type: "OAUTH", provider: "google" })}
        onSendMagicLink={(email, name) =>
          authSend({ type: "MAGIC_LINK", email, name })
        }
        onReset={() => authSend({ type: "RESET" })}
      />
    );
  }

  return (
    <AuthedApp
      user={authState.context.session?.user}
      onSignOut={() => authSend({ type: "SIGN_OUT" })}
    />
  );
}
