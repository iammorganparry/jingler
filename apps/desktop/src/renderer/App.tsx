import { RoutinesSettings } from "./routines-settings.js"
import { sessionArchiveMachine } from "./session-archive-machine.js"
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMachine } from "@xstate/react";
import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type {
  AgentEndpointCatalog,
  Attachment,
  ContextConfig,
  VsCodeTheme,
  CreateSessionFromIssueInput,
  CreateSessionFromPrInput,
  CreateSessionInput,
  ExecutionMode,
  GitConfig,
  IssueIdentity,
  GithubConfig,
  JinglerSubagentName,
  ProviderCatalog,
  ProviderCatalogModel,
  ProviderId,
  ProviderModelId,
  UsageReport,
  WorkspaceConfig,
  NotificationsConfig,
  OffloadComputeSettings,
  PublishCheckpoint,
  PrSummary,
  Session,
  SessionActivity,
  User,
} from "@jingler/core";
import type { SessionCreationPhase } from "@jingler/contracts";
import {
  clampFontScale,
  DEFAULT_THEME_ID,
  workspaceModeOf,
} from "@jingler/core";
import {
  ConfirmDialog,
  ExplanationView,
  LoadingScreen,
  SignInDialog,
  SetupScreen,
  JinglerApp,
  PullRequestInbox,
  ThemeProvider,
  useSplashHold,
  useThemeCatalog,
  closeSurfaceEverywhere,
  forgetEditorLayout,
  openTab,
  SESSION_SURFACE_COMMAND_EVENT,
  updateEditorLayout,
} from "@jingler/ui";
import { appMachine } from "./app-machine.js";
import { authMachine } from "./auth-machine.js";
import { ConversationPane } from "./conversation-pane.js";
import {
  useExplanationDocument,
  useExplanationSessions,
} from "./use-explanation-document.js";
import { setFirstMessage } from "./first-message-store.js";
import { SessionSubagentTabs } from "./session-chat-tabs.js";
import { selectSubagentTab } from "./subagent-tab-store.js";
import { queueSessionChatMutation } from "./session-chat-mutations.js";
import { PullRequestPane } from "./pull-request-pane.js";
import {
  pullRequestSessionTarget,
  usePullRequestInbox,
} from "./use-pull-request-inbox.js";
import { ReviewTrayDock, revealSessionChanges } from "./changes-review.js";
import { setReviewFocused, useReviewFocused } from "./review-store.js";
import { FileBrowserExplorer, FileBrowserQuickOpen, FileBrowserView } from "./file-browser-view.js";
import { TerminalDockView } from "./terminal-dock-view.js";
import { PreviewDockView } from "./preview-dock-view.js";
import { usePreviewDock } from "./use-preview-dock.js";
import { useSessionActivities } from "./session-activity.js";
import { setSessionDiff, useSessionDiffs, useSessionFileDiffs } from "./diff-presence.js";
import { clearPlanAutoPresentation, usePlanSessions } from "./plan-presence.js";
import {
  disposeChatActor,
  disposeConversationActor,
  getConversationActor,
  isChatUntouched,
  useAllChatActivities,
} from "./conversation-registry.js";
import { addDraftCodeReference, clearDraft, getDraft } from "./draft-store.js";
import { serializeCodeReferences } from "./code-reference.js";
import { clearViewedPaths } from "./viewed-store.js";
import {
  closeSessionFile,
  disposeFileBrowserActor,
  trackSessionFile,
  requestCloseFileSurface,
} from "./use-file-browser.js";
import { onSessionUpdate, publishSessionUpdate } from "./session-updates.js";
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
import { useMcpSettings } from "./use-mcp-settings.js";
import { McpImportPrompt } from "./mcp-import-prompt.js";
import { useProviderCatalog } from "./use-provider-catalog.js";
import { useAgentsSettings } from "./use-agents-settings.js";
import { useRuntimeInspector } from "./use-runtime-inspector.js";
import { useEnvironments } from "./use-environments.js";
import { createOffloadSettingsMachine } from "./offload-settings-machine.js";
import { useProjects } from "./use-projects.js";
import { WorkspaceWorkflowBar } from "./workspace-workflow-bar.js";
import { useAutoUpdate } from "./use-auto-update.js";
import { useReleaseNotes } from "./use-release-notes.js";
import {
  PluginProvider,
  usePluginCatalog,
  usePluginCommands,
  useIssueProviders,
  usePluginPanes,
  usePluginTabs,
} from "./plugin-registry.js";
import { usePlugins } from "./use-plugins.js";
import { useDebugSessions } from "./debug-session.js";
import { repositoryAccess } from "./github-connection-machine.js";
import { useGitHubConnection } from "./use-github-connection.js";
import { GitHubFeedbackRouter } from "./github-feedback.js";
import { applyRelayHealthUpdate } from "./github-relay-health.js";

/** How often the archive sweep re-checks each linked PR's merged/closed state. */
const ARCHIVE_POLL_MS = 60_000;

/** How long a fetched PR state stays fresh before the sweep will re-fetch it. */
const PR_STATE_STALE_MS = 5 * 60_000;

const subagentModelsFor = (
  catalog: ProviderCatalog | null,
  endpoints: AgentEndpointCatalog | null,
): ReadonlyArray<ProviderCatalogModel> => [
  ...new Map([
    ...(catalog?.connections ?? [])
      .filter(({ connection }) => connection.status === "authenticated")
      .flatMap(({ models }) => models.filter(({ selectable }) => selectable)),
    ...(endpoints?.endpoints ?? [])
      .filter(({ endpoint }) => endpoint.runtimeId !== "pi" && endpoint.status === "ready")
      .flatMap(({ endpoint, models }) => models.filter(({ selectable }) => selectable).map((model) => ({
        ...model,
        label: `${model.label} · ${endpoint.label}`
      })))
  ].map((model) => [model.id, model] as const)).values(),
];

/**
 * How long a relay connection must stay troubled before the "reconnecting"
 * banner appears. Routine reconnects recover well within this, so they never
 * surface; a genuine outage outlasts it and does.
 */
const RELAY_UNHEALTHY_GRACE_MS = 4_000;
const delegationEnabled = (configured: boolean | undefined): boolean => configured !== false;
const subagentAssignments = (config: WorkspaceConfig | null | undefined) =>
  config?.subagentModelsByProvider ?? {};
/**
 * Thin view over `appMachine` (which drives the first-run/loading/session flow).
 * Everything else the shell needs is read through machines/react-query — the
 * GitHub App connection, persisted preferences, and usage — so there are no ad-hoc
 * `useEffect` + `useState` fetches here; a mutation just updates the cache.
 *
 * Always mounted — sign-in is optional. Receives the signed-in `user` and
 * `onSignOut` (or, signed out, `onSignIn`) to drive the sidebar footer.
 */
function ExplanationPane({ sessionId }: { readonly sessionId: string }) {
  const explanation = useExplanationDocument(sessionId)
  return (
    <ExplanationView
      document={explanation.document}
      loading={explanation.loading}
      error={explanation.error}
      onRetry={explanation.retry}
    />
  )
}

function AuthedApp({
  user,
  onSignOut,
  onSignIn,
}: {
  user?: User;
  onSignOut?: () => void;
  onSignIn?: () => void;
}) {
  const [state, send] = useMachine(appMachine);
  const reviewFocused = useReviewFocused();
  const update = useAutoUpdate();
  // The build-time version: Changesets keys the CHANGELOG on it, and unlike
  // Electron's runtime version it is right in unpackaged builds too.
  const releaseNotes = useReleaseNotes(__APP_VERSION__);
  const github = useGitHubConnection();
  const pullRequestInbox = usePullRequestInbox(
    github.connection.connected || github.connection.cliAvailable === true,
  );
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
  const { repos, reposDir, sessions } = state.context;
  // Merged with the built-ins inside `SessionPane`, through the same registry —
  // a plugin tab is not a separate region of the tab bar.
  const pluginTabs = usePluginTabs();
  const pluginPanes = usePluginPanes();
  const pluginCommands = usePluginCommands();
  const issueProviders = useIssueProviders();
  const plugins = usePlugins();
  const pluginCatalog = usePluginCatalog();
  const liveActivity = useSessionActivities();
  const debugEnabled = hasEnabledDebugPlugin(pluginCatalog);
  const [visibleDebugSessionIds, setVisibleDebugSessionIds] = useState<ReadonlySet<string>>(new Set());
  const debugSessionIds = sessions.map((session) => session.id);
  const visibleDebugIds = debugSessionIds.filter((id) => visibleDebugSessionIds.has(id));
  const signalledDebugIds = debugSessionIds.filter((id) => liveActivity[id] !== undefined);
  const debugWakeKey = signalledDebugIds.map((id) => {
    const activity = liveActivity[id];
    return `${id}\0${activity?.verb ?? ""}\0${activity?.target ?? ""}\0${activity?.startedAt ?? ""}`;
  }).join("\0");
  const debugSessions = useDebugSessions(
    visibleDebugIds,
    signalledDebugIds,
    debugEnabled,
    debugWakeKey,
  );
  const debugStopSequences = useMemo(() => Object.fromEntries(
    Object.entries(debugSessions).flatMap(([sessionId, snapshot]) =>
      snapshot.session?.status === "stopped" && snapshot.session.stopSequence
        ? [[sessionId, snapshot.session.stopSequence]]
        : []
    )
  ), [debugSessions]);
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
    tabId?: string;
    nonce: number;
  } | null>(null);
  const [newSessionRequest, setNewSessionRequest] = useState<{
    projectId: string;
    pr: PrSummary;
    tabId?: string;
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
    (ids: ReadonlySet<string>) => {
      setVisibleSessionIds(ids);
      setVisibleDebugSessionIds(ids);
    },
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
  const liveDiff = useSessionDiffs();
  const fileDiffs = useSessionFileDiffs();
  const chatActivities = useAllChatActivities();
  const planSessions = usePlanSessions();
  const explanationSessions = useExplanationSessions(sessions);
  const browserDock = usePreviewDock();
  const sessionsLoaded = state.matches("ready");
  useEffect(() => {
    if (!sessionsLoaded) return;
    browserDock.reconcileSessions(sessions.map((session) => session.id));
  }, [browserDock.reconcileSessions, sessions, sessionsLoaded]);
  const qc = useQueryClient();
  const offloadSettingsMachine = useMemo(
    () => createOffloadSettingsMachine({
      save: (settings) => rpc.configSetOffloadCompute(settings).then((saved) => {
        qc.setQueryData(["config"], saved);
        return saved.offloadCompute ?? settings;
      })
    }),
    [qc]
  );
  const [offloadSettingsState, sendOffloadSettings] = useMachine(
    offloadSettingsMachine
  );
  const { activeId: activeThemeId, catalog: themeCatalog } = useThemeCatalog();
  const mcp = useMcpSettings();
  const environmentController = useEnvironments();
  const providerCatalog = useProviderCatalog(environmentController.environments);
  const agentsSettings = useAgentsSettings();
  const runtimeInspector = useRuntimeInspector();
  const agentEndpointCatalog = useMemo<AgentEndpointCatalog | null>(() => {
    const catalogs = [
      ...(providerCatalog.endpointCatalog ? [providerCatalog.endpointCatalog] : []),
      ...environmentController.environments.flatMap((environment) => {
        const catalog = providerCatalog.remoteCatalogs.find(({ deviceId }) => deviceId === environment.id)?.catalog
          ?? environment.capabilities?.endpointCatalog
        if (!catalog) return []
        if (environment.state === "online") return [catalog]
        return [{
          ...catalog,
          stale: true,
          endpoints: catalog.endpoints.map(({ endpoint, models }) => ({
            endpoint: { ...endpoint, status: "stale-agent" as const },
            models: models.map((model) => ({
              ...model,
              status: "unavailable" as const,
              selectable: false
            }))
          }))
        }]
      })
    ]
    if (catalogs.length === 0) return null
    return {
      endpoints: catalogs.flatMap(({ endpoints }) => endpoints),
      refreshedAt: new Date().toISOString(),
      stale: catalogs.some(({ stale }) => stale)
    }
  }, [environmentController.environments, providerCatalog.endpointCatalog, providerCatalog.remoteCatalogs])
  const projectController = useProjects();
  const [environmentDialogOpen, setEnvironmentDialogOpen] = useState(false);

  // Provider capabilities are versioned by the auth Durable Object. Refresh the
  // unified inventory after every GitHub auth refresh so managed provider choices
  // change without restarting the desktop; active turns are fenced server-side.
  useEffect(() => {
    environmentController.send({ type: "REFRESH" });
  }, [environmentController.send, github.connection.lastRefreshedAt]);

  // Renderer-side rpc reads, via react-query.
  const configQuery = useQuery({
    queryKey: ["config"],
    queryFn: () => rpc.configGet(),
  });
  const webSearchQuery = useQuery({
    queryKey: ["web-search-settings"],
    queryFn: () => rpc.webSearchGet(),
  });
  const webSearchSet = useMutation({
    mutationFn: ({ provider, apiKey }: { provider: "exa" | "firecrawl"; apiKey: string }) =>
      rpc.webSearchSetCredential(provider, apiKey),
    onSuccess: (status) => {
      qc.setQueryData(["web-search-settings"], status);
      void configQuery.refetch();
    },
  });
  const webSearchClear = useMutation({
    mutationFn: (provider: "exa" | "firecrawl") =>
      rpc.webSearchClearCredential(provider),
    onSuccess: (status) => {
      qc.setQueryData(["web-search-settings"], status);
      void configQuery.refetch();
    },
  });
  const webSearchSkip = useMutation({
    mutationFn: () => rpc.webSearchSkip(),
    onSuccess: (status) => {
      qc.setQueryData(["web-search-settings"], status);
      void configQuery.refetch();
    },
  });
  const usageQuery = useQuery({
    queryKey: ["usage"],
    queryFn: () => rpc.usageGet(),
    enabled: false,
  });
  const usageReportQuery = useQuery<UsageReport>({
    queryKey: ["usage-report"],
    queryFn: () => rpc.usageReport(),
    enabled: false,
  });

  const { githubConfig, gitConfig, notificationsConfig, persistedOffloadCompute, defaultConnectionId, defaultModelId } = appStoredPreferences(configQuery.data);
  useEffect(() => {
    if (persistedOffloadCompute !== null) {
      sendOffloadSettings({ type: "SYNC", settings: persistedOffloadCompute });
    }
  }, [persistedOffloadCompute, sendOffloadSettings]);
  const offloadCompute = offloadSettingsState.context.settings;
  // Absent means Auto for configs written before this preference existed.
  const { starredRepos, collapsedRepos, lastRepoPath, defaultMode, planAutoRun, adhdMode, fontScale, contextConfig } = appDisplayPreferences(configQuery);
  const usage = usageQuery.data ?? null;

  const contextTargets = sessions.flatMap((session) => {
    const chat =
      session.chats.find(
        (candidate) => candidate.id === session.activeChatId,
      ) ?? session.chats[0];
    return chat === undefined ? [] : [{ session, chat }];
  });
  const contextQueries = useQueries({
    queries: contextTargets.map(({ session, chat }) => ({
      queryKey: [
        "context",
        session.id,
        chat.id,
        chat.connectionId,
        chat.modelId,
      ] as const,
      queryFn: () => rpc.contextState(session.id, chat.id),
      enabled: sessionsLoaded,
    })),
  });
  const contextSessions = contextTargets.flatMap(({ session }, index) => {
    const snapshot = contextQueries[index]?.data;
    return snapshot === undefined
      ? []
      : [{ id: session.id, title: session.title, snapshot }];
  });

  // The usage modal loads on open; GitHub refreshes live through its machine.
  const loadUsage = () => Promise.all([usageQuery.refetch(), usageReportQuery.refetch()]).then(() => undefined);
  const exportUsage = () => {
    if (!usageReportQuery.data) return;
    const blob = new Blob([JSON.stringify(usageReportQuery.data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "jingler-usage-report.json";
    anchor.click();
    URL.revokeObjectURL(url);
  };
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
  const saveOffloadCompute = (settings: OffloadComputeSettings) => {
    sendOffloadSettings({ type: "SET", settings });
  };
  const saveDefaultMode = (value: ExecutionMode) =>
    rpc.configSetDefaultMode(value).then((saved) => {
      qc.setQueryData(["config"], saved);
    });
  const saveSubagentDelegationEnabled = (enabled: boolean) =>
    rpc.configSetSubagentDelegationEnabled(enabled).then((saved) => {
      qc.setQueryData(["config"], saved);
    });
  const saveSubagentModel = (
    providerId: ProviderId,
    agent: JinglerSubagentName,
    modelId: ProviderModelId | null,
  ) =>
    rpc.configSetSubagentModel(providerId, agent, modelId).then((saved) => {
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
  const themeSettings = themeSettingsModel(themeCatalog, activeThemeId, qc, refreshThemes, loadTheme);
  const saveContextConfig = (config: ContextConfig) =>
    rpc.configSetContext(config).then((saved) => {
      qc.setQueryData(["config"], saved);
      // Every session's trigger point moves with the budget, so drop the cached
      // snapshots rather than leaving meters reading against the old one.
      void qc.invalidateQueries({ queryKey: ["context"] });
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

  const createSession = async (
    input: CreateSessionInput,
    images: ReadonlyArray<Attachment> = [],
    onProgress?: (phase: SessionCreationPhase) => void,
  ) => {
    const session = await rpc.sessionsCreate(input, onProgress);
    void rememberLastRepo(input.repoPath);
    // A first message (typed text and/or attachments) means the operator wants
    // the agent working now, not a pre-filled draft. Flag the session for
    // first-turn auto-send BEFORE it becomes active, so the ConversationPane
    // that mounts on SESSION_CREATED finds the handoff. "Create without a first
    // message" leaves both empty, so no flag and no auto-send.
    if (input.initialPrompt || images.length > 0) {
      setFirstMessage(session.id, images);
    }
    send({ type: "SESSION_CREATED", session });
    return session;
  };
  const createSessionFromPr = async (
    input: CreateSessionFromPrInput,
    images: ReadonlyArray<Attachment> = [],
    onProgress?: (phase: SessionCreationPhase) => void,
  ) => {
    const session = await rpc.sessionsCreateFromPr(input, onProgress);
    void rememberLastRepo(input.repoPath);
    if (input.initialPrompt || images.length > 0)
      setFirstMessage(session.id, images);
    send({ type: "SESSION_CREATED", session });
    return session;
  };
  const createSessionFromIssue = async (
    input: CreateSessionFromIssueInput,
    images: ReadonlyArray<Attachment> = [],
    onProgress?: (phase: SessionCreationPhase) => void,
  ) => {
    const session = await rpc.sessionsCreateFromIssue(input, onProgress);
    void rememberLastRepo(input.repoPath);
    if (input.task.trim() || images.length > 0)
      setFirstMessage(session.id, images);
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
  const selectIssue = useCallback((sessionId: string, issue: IssueIdentity) => {
    void rpc.sessionsSelectIssue(sessionId, issue).then(publishSessionUpdate);
  }, []);

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
  const [archiveState, sendArchive] = useMachine(sessionArchiveMachine, { input: {
    load: rpc.sessionsGet,
    archive: (id, acknowledged) => rpc.sessionsArchive(id, "closed", false, acknowledged),
    onSession: session => send({ type: "SESSION_UPDATED", session })
  } });
  const archiveSession = async (sessionId: string) => {
    const session = sessions.find(item => item.id === sessionId);
    if (session) sendArchive({ type: "ARCHIVE", session });
  };
  const renameSession = (sessionId: string, title: string) => {
    void rpc
      .sessionsRename(sessionId, title)
      .then((session) => send({ type: "SESSION_UPDATED", session }));
  };
  const deleteSession = async (sessionId: string) => {
    const chatIds =
      sessions
        .find((session) => session.id === sessionId)
        ?.chats.map((chat) => chat.id) ?? [];
    await rpc.sessionsDelete(sessionId);
    browserDock.removeSession(sessionId);
    // Stop the persistent conversation actor for a deleted session (it's kept
    // running across session switches, so it won't be torn down by unmount).
    disposeConversationActor(sessionId);
    disposeFileBrowserActor(sessionId);
    for (const chatId of chatIds) clearPlanAutoPresentation(chatId);
    // Same reasoning for the composer draft — it outlives the pane by design, so
    // nothing else would ever collect it (and it's persisted).
    for (const chatId of chatIds) clearDraft(chatId);
    clearViewedPaths(sessionId);
    forgetEditorLayout(sessionId);
    send({ type: "SESSION_DELETED", sessionId });
  };

  const closeChat = (sessionId: string, chatId: string, discard = false) =>
    queueSessionChatMutation(
      sessionId,
      () => rpc.sessionsCloseChat(sessionId, chatId, discard),
      (updated) => {
        clearDraft(chatId);
        disposeChatActor(sessionId, chatId);
        publishSessionUpdate(updated);
        updateEditorLayout(sessionId, (layout) =>
          openTab(closeSurfaceEverywhere(layout, { kind: "chat", id: chatId }), {
            kind: "chat",
            id: updated.activeChatId,
          }),
        );
      },
    );
  const closeUntouchedChat = (sessionId: string, chatId: string) => {
    const draft = getDraft(chatId);
    if (
      !isChatUntouched(sessionId, chatId) ||
      draft.text !== "" ||
      draft.attachments.length > 0 ||
      draft.references.length > 0
    ) {
      return;
    }
    closeChat(sessionId, chatId, true);
  };

  const accessForSession = useCallback(
    (session: Session) => {
      const repo = repos.find(
        (candidate) =>
          candidate.path === session.repoPath ||
          (session.repoPath === undefined && candidate.name === session.repo),
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
    (session: Session) => {
      const repo = repos.find(
        (candidate) =>
          candidate.path === session.repoPath ||
          (session.repoPath === undefined && candidate.name === session.repo),
      );
      return (
        (github.connection.cliAvailable === true &&
          (session.worktreePath != null || repo?.githubSlug != null)) ||
        accessForSession(session).status === "accessible"
      );
    },
    [accessForSession, github.connection.cliAvailable, repos],
  );
  const appConnected =
    github.connection.connected &&
    github.connection.installations.some(
      (installation) => installation.status === "active",
    );
  const connected = github.connection.cliAvailable === true || appConnected;
  // A manual GitHub refresh can revoke one repository while leaving the overall
  // account connected. Restart the main-process relay stream whenever that
  // authorization topology changes so its supervisor immediately closes routes
  // that are no longer permitted instead of waiting for its low-frequency
  // background reconciliation.
  const githubRelayAuthorizationVersion = useMemo(
    () =>
      github.connection.installations
        .map((installation) =>
          [
            installation.id,
            installation.status,
            installation.repositorySelection,
            ...(installation.repositories ?? [])
              .map((repository) => repository.id)
              .sort(),
          ].join(":"),
        )
        .sort()
        .join("|"),
    [github.connection.installations],
  );
  const autoDetect = shouldAutoDetectPr(connected, githubConfig);
  const autoCreate =
    shouldAutoCreatePr(connected, githubConfig);
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
          if (alreadyDurable) return { accepted: Promise.resolve() };
          // SEND is the same visible conversation intent used by the composer.
          // While an agent is running, the conversation machine owns steering
          // or FIFO queueing; this never starts a hidden parallel run.
          let accept = () => {};
          const accepted = new Promise<void>((resolve) => {
            accept = resolve;
          });
          conversation.send({
            type: "SEND",
            text,
            externalInstruction,
            onExternalAccepted: accept,
          });
          return { accepted };
        },
      }),
    [qc],
  );

  useEffect(() => {
    if (!appConnected) return;
    const cancelEvents = rpc.githubEvents(
      (delivery) => {
        const resolveTarget = () => {
          const session = sessionsRef.current.find(
            (candidate) => candidate.id === delivery.sessionId,
          );
          return session?.githubInstallationId &&
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
        };
        const routeDelivery = (target: NonNullable<ReturnType<typeof resolveTarget>>) => {
          void feedbackRouter
            .route(delivery.event, target)
            // Main selected this exact session from its opaque relay connection;
            // renderer never searches by repository or pull-request payload.
            .then((result) => {
              if (result.status === "routed") {
                void result.completion.catch((cause: unknown) => {
                  console.error(
                    "GitHub feedback stayed pending after UI admission; the outbox will replay it:",
                    cause,
                  );
                });
              }
              return rpc.githubAckEvent(delivery.clientId, delivery.cursor);
            })
            .catch((cause: unknown) => {
              // A routing failure must not hold the cursor hostage: every later
              // event for this session queues behind an acknowledgement that
              // will never come, and only an app restart would recover. Reject
              // instead, so main fails the connection and replays with backoff.
              console.error(
                "GitHub feedback delivery failed; asking main to replay it:",
                cause,
              );
              void rpc.githubAckEvent(delivery.clientId, delivery.cursor, "retry");
            });
        };
        const target = resolveTarget();
        if (target) {
          routeDelivery(target);
          return;
        }
        // A freshly linked PR can reach main's on-disk session before React's
        // `sessions` state reflects it, so give the state a moment to catch up
        // before giving up. Withholding forever is never an option — a delivery
        // that is neither acknowledged nor rejected wedges the whole stream.
        let waited = 0;
        const timer = window.setInterval(() => {
          const late = resolveTarget();
          if (late) {
            window.clearInterval(timer);
            routeDelivery(late);
            return;
          }
          waited += 1_000;
          if (waited >= 15_000) {
            window.clearInterval(timer);
            console.error(
              `GitHub feedback relay route ${delivery.relaySessionId} does not match an active local session; asking main to replay it.`,
            );
            void rpc.githubAckEvent(delivery.clientId, delivery.cursor, "retry");
          }
        }, 1_000);
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
  }, [appConnected, feedbackRouter, githubRelayAuthorizationVersion]);

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
    refreshCompletedSessions(completed, sessions, send, startAutoPublish);
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
    shouldAutoReviewPr(connected, githubConfig);
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
  const gate = renderAuthedAppGate(splashHeld, state, github, repos, reposDir, send);
  if (gate !== null) return gate;

  const selectedPullRequest = pullRequestInbox.selected;
  const selectedPullRequestTarget = selectedPullRequest
    ? pullRequestSessionTarget(
        selectedPullRequest,
        repos,
        projectController.projects,
        sessions,
      )
    : null;
  const openSelectedPullRequestTarget = (tabId?: string) => {
    if (!(selectedPullRequest && selectedPullRequestTarget)) return;
    const existingSession = selectedPullRequestTarget.session;
    if (existingSession) {
      setSelectRequest((previous) => ({
        sessionId: existingSession.id,
        ...(tabId ? { tabId } : {}),
        nonce: (previous?.nonce ?? 0) + 1,
      }));
      return;
    }
    const project = selectedPullRequestTarget.project;
    if (project) {
      setNewSessionRequest((previous) => ({
        projectId: project.id,
        pr: selectedPullRequest,
        ...(tabId ? { tabId } : {}),
        nonce: (previous?.nonce ?? 0) + 1,
      }));
    }
  };
  const openSelectedPullRequestSession = () => openSelectedPullRequestTarget();
  const openSelectedPullRequestFiles = () => openSelectedPullRequestTarget("review");

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
        tabContributions={pluginTabs}
        onSelectIssue={selectIssue}
        paneContributions={pluginPanes}
        pluginCommands={pluginCommands}
        onRunPluginCommand={runPluginCommand}
        selectSessionRequest={selectRequest}
        newSessionRequest={newSessionRequest}
        onVisibleSessionsChange={onVisibleSessionsChange}
        sessions={sessions}
        user={user}
        update={update}
        releaseNotes={releaseNotes}
        pullRequestsView={
          renderPullRequestInbox(pullRequestInbox, github, selectedPullRequestTarget, openSelectedPullRequestFiles, openSelectedPullRequestSession)
        }
        onSignOut={onSignOut}
        onSignIn={onSignIn}
        repos={repos}
        projects={projectController.projects}
        projectsLoading={projectController.loading}
        onBrowseProject={projectController.browse}
        onBrowseCloneDestination={projectController.browseCloneDestination}
        onListProjectDirectories={projectController.listDirectories}
        onListGitHubRepositories={projectController.listGitHubRepositories}
        onRegisterProject={projectController.register}
        onCreateProjectDirectory={projectController.createDirectory}
        onCloneProject={projectController.clone}
        onCloneProjectFromGitHub={projectController.cloneFromGitHub}
        onEnsureProjectOnEnvironment={rpc.projectsEnsureOnEnvironment}
        routines={<RoutinesSettings projects={projectController.projects} catalog={providerCatalog.catalog} onSession={id => rpc.sessionsGet(id).then(session => { send({ type: "SESSION_UPDATED", session }); setSelectRequest({ sessionId: id, nonce: Date.now() }); })} />}
        onSaveProjectWorkflow={async (input) => { await projectController.setWorkflow(input) }}
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
        chatActivities={chatActivities}
        prStates={prStates}
        liveDiff={liveDiff}
        fileDiffs={fileDiffs}
        usage={usage}
        usageReport={usageReportQuery.data ?? null}
        onLoadUsage={loadUsage}
        onExportUsage={exportUsage}
        githubConfig={githubConfig}
        onSaveGithubConfig={saveGithubConfig}
        gitConfig={gitConfig}
        onSaveGitConfig={saveGitConfig}
        notificationsConfig={notificationsConfig}
        onSaveNotificationsConfig={saveNotificationsConfig}
        offloadCompute={offloadCompute}
        onSaveOffloadCompute={saveOffloadCompute}
        offloadStatus={offloadSettingsStatus(offloadSettingsState, offloadCompute.enabled)}
        webSearch={{
          status: webSearchQuery.data ?? null,
          loading: webSearchQuery.isLoading,
          busy:
            webSearchSet.isPending ||
            webSearchClear.isPending ||
            webSearchSkip.isPending,
          error:
            firstSettingsError(webSearchQuery.error, webSearchSet.error, webSearchClear.error, webSearchSkip.error),
          onSave: async (provider, apiKey) => {
            await webSearchSet.mutateAsync({ provider, apiKey });
          },
          onClear: async (provider) => {
            await webSearchClear.mutateAsync(provider);
          },
          onSkip: async () => {
            await webSearchSkip.mutateAsync();
          },
        }}
        defaultMode={defaultMode}
        onSaveDefaultMode={saveDefaultMode}
        planAutoRun={planAutoRun}
        onSavePlanAutoRun={savePlanAutoRun}
        adhdMode={adhdMode}
        onSaveAdhdMode={saveAdhdMode}
        fontScale={fontScale}
        onSaveFontScale={saveFontScale}
        themes={themeSettings}
        plugins={plugins}
        devices={{
          environments: environmentController.environments,
          loading: environmentController.loading,
          error: environmentController.error,
          onOpen: () => {
            environmentController.send({ type: "RESET" });
            setEnvironmentDialogOpen(true);
          },
          onRefresh: environmentController.refresh,
          onRename: environmentController.rename,
          onRevoke: environmentController.revoke,
          dialog: {
            open: environmentDialogOpen,
            state: String(environmentController.snapshot.value) as
              | "discovering"
              | "configuring"
              | "enrolling"
              | "connected"
              | "failed",
            values: {
              host: environmentController.snapshot.context.host,
            },
            hosts: environmentController.snapshot.context.hosts,
            environment: environmentController.snapshot.context.environment,
            error: environmentController.snapshot.context.error,
            onClose: () => {
              environmentController.send({ type: "CANCEL" });
              setEnvironmentDialogOpen(false);
            },
            onEdit: (field, value) =>
              environmentController.send({ type: "EDIT", field, value }),
            onSelectHost: (host) =>
              environmentController.send({ type: "SELECT_HOST", host }),
            onSubmit: () => environmentController.send({ type: "SUBMIT" }),
            onRetry: () => environmentController.send({ type: "RETRY" }),
          },
        }}
        agentEndpointCatalog={agentEndpointCatalog}
        providerConnections={{
          catalog: providerCatalog.catalog,
          endpointCatalog: agentEndpointCatalog,
          nativeEndpointLogin: providerCatalog.nativeEndpointLogin,
          defaultConnectionId,
          defaultModelId,
          busy: providerCatalog.busy,
          pendingAuthKind: providerCatalog.pendingAuthKind,
          error: providerCatalog.error,
          onReload: providerCatalog.reload,
          onRefresh: providerCatalog.refresh,
          onVerify: providerCatalog.verify,
          onMakeDefault: providerCatalog.makeDefault,
          onLogout: providerCatalog.logout,
          onRemove: providerCatalog.remove,
          onConnectClaude: providerCatalog.connectClaude,
          onStartCodex: providerCatalog.startCodex,
          onSetApiKey: providerCatalog.setApiKey,
        }}
        agents={{
          resources: agentsSettings.snapshot.context.resources,
          models: subagentModelsFor(providerCatalog.catalog, agentEndpointCatalog),
          modelAssignments: subagentAssignments(configQuery.data),
          delegationEnabled: delegationEnabled(configQuery.data?.subagentDelegationEnabled),
          detection: agentsSettings.snapshot.context.detection,
          selectedCandidateIds:
            agentsSettings.snapshot.context.selectedCandidateIds,
          loading:
            agentsSettings.snapshot.matches("loading") ||
            agentsSettings.snapshot.matches("detecting") ||
            agentsSettings.snapshot.matches("importing") ||
            agentsSettings.snapshot.matches("mutating"),
          reviewing: agentsSettings.snapshot.matches("reviewing"),
          error: agentsSettings.snapshot.context.error,
          onDetect: () => agentsSettings.send({ type: "DETECT" }),
          onSetDelegationEnabled: saveSubagentDelegationEnabled,
          onSetModel: saveSubagentModel,
          onToggleCandidate: (id) =>
            agentsSettings.send({ type: "TOGGLE_CANDIDATE", id }),
          onImportSelected: () =>
            agentsSettings.send({ type: "IMPORT_SELECTED" }),
          onCancelDetection: () =>
            agentsSettings.send({ type: "CANCEL_DETECTION" }),
          onSetEnabled: (selector, enabled) =>
            agentsSettings.send({ type: "SET_ENABLED", selector, enabled }),
          onReveal: (selector) => agentsSettings.send({ type: "REVEAL", selector }),
          onRemove: (selector) => agentsSettings.send({ type: "REMOVE", selector }),
          onRetry: () => agentsSettings.send({ type: "RETRY" }),
        }}
        runtimeInspector={{
          snapshot: runtimeInspector.snapshot.context.snapshot,
          loading:
            runtimeInspector.snapshot.matches("loading") ||
            runtimeInspector.snapshot.matches("exporting"),
          exported: runtimeInspector.snapshot.context.exported !== null,
          error: runtimeInspector.snapshot.context.error,
          onRefresh: () => runtimeInspector.send({ type: "REFRESH" }),
          onExport: () => runtimeInspector.send({ type: "EXPORT" }),
        }}
        contextConfig={contextConfig}
        onSaveContextConfig={saveContextConfig}
        contextSessions={contextSessions}
        mcp={mcp}
        environments={environmentController.environments}
        loadEnvironmentDiscovery={rpc.environmentsDiscovery}
        loadBranches={async (repoPath, environmentId) => {
          return rpc.workspaceBranches(repoPath, environmentId);
        }}
        issueProviders={issueProviders}
        loadPullRequests={(project, search, mine) => {
          const githubSlug =
            repos.find((repo) => repo.path === project.path)?.githubSlug ??
            undefined;
          return rpc.githubListPrs(project.path, {
            search,
            mine,
            ...(githubSlug ? { githubSlug } : {}),
          });
        }}
        loadGithubIssues={(project, search, mine) => {
          const githubSlug =
            repos.find((repo) => repo.path === project.path)?.githubSlug ??
            undefined;
          return rpc.githubListIssues(project.path, {
            search,
            mine,
            ...(githubSlug ? { githubSlug } : {}),
          });
        }}
        loadProviderIssues={(providerId, project, search, mine) =>
          rpc.pluginsIssueProviderList({
            providerId,
            repository: { name: project.name, path: project.path },
            search,
            mine,
          })
        }
        onCreateSession={createSession}
        onCreateSessionFromPr={createSessionFromPr}
        onCreateSessionFromIssue={createSessionFromIssue}
        onRenameSession={renameSession}
        chatActions={{
          onSelectChat: (sessionId, chatId) =>
            queueSessionChatMutation(sessionId, () => rpc.sessionsSelectChat(sessionId, chatId)),
          onRenameChat: (sessionId, chatId, title) => {
            void rpc.sessionsRenameChat(sessionId, chatId, title).then(publishSessionUpdate);
          },
          onCloseChat: closeChat,
          onCloseUntouchedChat: closeUntouchedChat,
          onReopenChat: (sessionId, chatId) =>
            queueSessionChatMutation(
              sessionId,
              () => rpc.sessionsReopenChat(sessionId, chatId),
              (updated) => {
                publishSessionUpdate(updated);
                updateEditorLayout(sessionId, (layout) => openTab(layout, { kind: "chat", id: chatId }));
              },
            ),
        }}
        onCloseUntouchedChat={closeUntouchedChat}
        onCreateChat={(sessionId) =>
          queueSessionChatMutation(
            sessionId,
            () => rpc.sessionsCreateChat(sessionId),
            (updated) => {
              publishSessionUpdate(updated);
              updateEditorLayout(sessionId, (layout) =>
                openTab(layout, { kind: "chat", id: updated.activeChatId }),
              );
            },
          )
        }
        onArchiveSession={archiveSession}
        onRestoreSession={restoreSession}
        onDeleteSession={(id) =>
          setPendingDelete(sessions.find((s) => s.id === id) ?? null)
        }
        planSessions={planSessions}
        explanationSessions={explanationSessions}
        debugStopSequences={debugStopSequences}
        renderExplanation={(session: Session) => (
          <ExplanationPane sessionId={session.id} />
        )}
        renderConversation={(session: Session, view, ctx) => (
          <div className="flex min-h-0 flex-1 flex-col">
            <WorkspaceWorkflowBar
              session={session}
              project={projectController.projects.find((project) => project.id === session.projectId)}
              onSession={publishSessionUpdate}
              onPreview={(url) => { const browser = browserDock.forAgent(session.id, session.activeChatId); browser.navigate(url); ctx.onSelectBrowser?.(); }}
            />
          {/* The registry keeps each actor alive, but React state must remount per
              chat or useSelector can display the previous actor until the new
              transcript load emits its first transition. */}
          <ConversationPane
            key={`${session.id}:${session.activeChatId}`}
            session={session}
            environments={environmentController.environments}
            providerCatalog={providerCatalog.catalog}
            agentEndpointCatalog={agentEndpointCatalog}
            view={view}
            onOpenPlanReview={ctx.onOpenPlanReview}
            onPlanDraftAvailable={ctx.onPlanDraftAvailable}
            onPlanDraftUnavailable={ctx.onPlanDraftUnavailable}
            onRestore={restoreSession}
            onDelete={deleteSession}
            onInitialPromptConsumed={consumeInitialPrompt}
            onOpenFile={(_sessionId, path) => ctx.onOpenFile(path)}
            onSelectFiles={ctx.onSelectFiles}
            onSelectChanges={ctx.onSelectChanges}
            onOpenProviderSettings={ctx.onOpenProviderSettings}
            onAddMcp={mcp.add}
            mcpServers={mcp.servers}
            onSetMcpApiKey={mcp.setApiKey}
            onSetMcpAuth={mcp.setAuth}
            onAuthorizeMcp={mcp.startAuthorization}
            paneFocused={ctx.paneFocused ?? true}
          />
          </div>
        )}
        renderExplorer={(session, onOpenPath) => (
          <FileBrowserExplorer
            session={session}
            connected={canUseGitHubForSession(session)}
            onOpenPath={onOpenPath}
          />
        )}
        renderFiles={(session, ctx) => (
          <FileBrowserView
            session={session}
            connected={canUseGitHubForSession(session)}
            path={ctx.path}
            onOpenPath={ctx.onOpenPath}
            onClosed={() => {
              if (ctx.path) closeSessionFile(session.id, ctx.path);
              ctx.onClosed?.();
            }}
            debugSnapshot={debugSessions[session.id]}
            onSendReference={(reference) => {
              addDraftCodeReference(session.activeChatId, reference);
              ctx.onSelectConversation();
            }}
            onSendComment={(body, reference) => {
              getConversationActor(session, session.activeChatId).send({
                type: "SEND",
                text: body,
                agentContext: serializeCodeReferences([reference]),
              });
            }}
          />
        )}
        onTrackFile={trackSessionFile}
        onRequestCloseFile={requestCloseFileSurface}
        renderFileQuickOpen={(session, ctx) => (
          <FileBrowserQuickOpen
            session={session}
            open={ctx.open}
            onOpenChange={ctx.onOpenChange}
            onOpenPath={ctx.onOpenPath}
          />
        )}
        renderSubagentTabs={(session: Session, ctx) => (
          <SessionSubagentTabs
            session={session}
            filesActive={ctx.activeTabId === "files"}
            onSelectConversation={ctx.onSelectConversation}
          />
        )}
        renderPullRequest={(session, ctx) => {
          const access = accessForSession(session);
          const sessionConnected = canUseGitHubForSession(session);
          return (
            <PullRequestPane
              session={session}
              connected={sessionConnected}
              autoDetect={autoDetect}
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
              onOpenFiles={ctx.onSelectReview}
            />
          );
        }}
        onRevealChanges={(sessionId) => {
          const session = sessions.find((candidate) => candidate.id === sessionId);
          setReviewFocused(false);
          if (session) revealSessionChanges(session);
        }}
        sidebarCollapsed={reviewFocused}
        renderReviewTray={(session, ctx) => {
          const access = accessForSession(session);
          return (
            <ReviewTrayDock
              session={session}
              connected={canUseGitHubForSession(session)}
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
        renderTerminalDock={(session, visible) => (
          <TerminalDockView session={session} visible={visible} embedded />
        )}
        onFocusChat={(sessionId, chatId) => {
          selectSubagentTab(sessionId, chatId, "main");
          const session = sessions.find((candidate) => candidate.id === sessionId);
          if (!session || session.activeChatId === chatId) return;
          queueSessionChatMutation(sessionId, () => rpc.sessionsSelectChat(sessionId, chatId));
        }}
        isBrowserActive={(sessionId, chatId) =>
          browserDock.forAgent(sessionId, chatId).visible
        }
        onToggleBrowser={(sessionId, chatId) => {
          const browser = browserDock.forAgent(sessionId, chatId);
          if (browser.visible) void rpc.browserPreviewClose(sessionId, chatId);
          browser.toggle();
        }}
        renderBrowser={(session, active) => (
          <PreviewDockView session={session} dock={browserDock} active={active} />
        )}
        version={window.jingler.appVersion}
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
      <McpImportPrompt
        ready={!mcp.loading && mcp.parseError === null}
        servers={mcp.servers}
        load={mcp.importCandidates}
        apply={mcp.applyImport}
      />
      <ArchiveConfirmation state={archiveState} send={sendArchive} />
      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
        title="Delete session?"
        description={deleteSessionDescription(pendingDelete)}
        confirmLabel="Delete"
        tone="danger"
        onConfirm={async () => {
          if (!pendingDelete) return;
          setSessionMutationError(null);
          try {
            await deleteSession(pendingDelete.id);
          } catch (error) {
            setSessionMutationError(
              error instanceof Error
                ? error.message
                : "Could not delete the session.",
            );
            throw error;
          }
        }}
      />
    </>
  );
}

function refreshCompletedSessions(completed: readonly string[], sessions: ReadonlyArray<Session>, send: import("xstate").ActorRefFrom<typeof appMachine>["send"], startAutoPublish: (session: Session) => void) {
  for (const id of completed) {
    const current = sessions.find((session) => session.id === id);
    if (!current) continue;
    // Settle the composer's dirty badge: the per-ToolEnd refresh misses an
    // agent committing via the shell (a Bash ToolEnd carries no file diff),
    // so re-read the worktree diff once the run is over.
    void rpc
      .sessionsDiffStat(id)
      .then((diffStat) => setSessionDiff(id, diffStat))
      .catch(() => { });
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
    void ready.then(startAutoPublish).catch(() => { });
  }
}

function themeSettingsModel(themeCatalog: ReturnType<typeof useThemeCatalog>["catalog"], activeThemeId: string, qc: ReturnType<typeof useQueryClient>, refreshThemes: () => Promise<void>, loadTheme: (id: string) => Promise<{ readonly [x: string]: unknown; readonly name: string; readonly type: "dark" | "light" | "hc" | "hcDark" | "hcLight"; readonly colors?: { readonly [x: string]: string; } | undefined; readonly tokenColors?: readonly { readonly name?: string | undefined; readonly scope?: string | readonly string[] | undefined; readonly settings: { readonly background?: string | undefined; readonly foreground?: string | undefined; readonly fontStyle?: string | undefined; }; }[] | undefined; readonly semanticHighlighting?: boolean | undefined; readonly semanticTokenColors?: { readonly [x: string]: unknown; } | undefined; } | null>) {
  return {
    themes: themeCatalog?.themes ?? [],
    skipped: themeCatalog?.skipped ?? [],
    activeId: activeThemeId,
    onSelect: (id: string) => rpc.themeSetActive(id).then((saved) => {
      qc.setQueryData(["config"], saved);
    }),
    onDuplicate: (id: string, name?: string) => rpc.themeDuplicate(id, name).then(async (copy) => {
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
    onImport: (json: string) => rpc.themeImport(json).then(async (imported) => {
      await refreshThemes();
      return imported;
    }),
    loadTheme,
    onSave: (id: string, theme: VsCodeTheme) => rpc.themeSave(id, theme).then(async (saved) => {
      // The editor debounces, so this fires per settled drag rather than per
      // frame. Refetching keeps the swatch preview in step with the picker.
      await refreshThemes();
      await qc.invalidateQueries({ queryKey: ["theme-source", id] });
      return saved;
    }),
    onReveal: (path: string) => void rpc.themeReveal(path),
  };
}

function shouldAutoReviewPr(connected: boolean, githubConfig: GithubConfig | null) {
  return connected &&
    (githubConfig?.enabled ?? false) &&
    (githubConfig?.autoAdversarialReview ?? false);
}

function shouldAutoCreatePr(connected: boolean, githubConfig: GithubConfig | null) {
  return connected &&
    (githubConfig?.enabled ?? false) &&
    (githubConfig?.autoCreatePr ?? false);
}

function appDisplayPreferences(configQuery: { data: Awaited<ReturnType<typeof rpc.configGet>> | undefined }) {
  const defaultMode = configQuery.data?.defaultMode ?? "auto";
  // Absent means on — plan mode's commands are read-only.
  const planAutoRun = configQuery.data?.planAutoRun ?? true;
  // Absent means off — ADHD mode shapes completion summaries, so it remains an
  // opt-in preference rather than a default the operator has to undo.
  const adhdMode = configQuery.data?.adhdMode ?? false;
  // Absent or malformed collapses to 1× (FONT_SCALE_DEFAULT). This value only
  // feeds the Settings control's active preset — the transcript reads the var
  // set in conversation-pane.tsx, so scaling stays scoped there.
  const fontScale = clampFontScale(configQuery.data?.fontScale);
  const contextConfig = configQuery.data?.context ?? null;
  const starredRepos = configQuery.data?.starredRepos ?? [];
  const collapsedRepos = configQuery.data?.collapsedRepos ?? [];
  const lastRepoPath = configQuery.data?.lastRepoPath ?? null;
  return { starredRepos, collapsedRepos, lastRepoPath, defaultMode, planAutoRun, adhdMode, fontScale, contextConfig };
}

function renderPullRequestInbox(
  pullRequestInbox: ReturnType<typeof usePullRequestInbox>,
  github: ReturnType<typeof useGitHubConnection>,
  selectedPullRequestTarget: ReturnType<typeof pullRequestSessionTarget> | null,
  openSelectedPullRequestFiles: () => void,
  openSelectedPullRequestSession: () => void
) {
  return <PullRequestInbox
    prs={pullRequestInbox.prs}
    viewerLogin={github.connection.user?.login ?? ""}
    selected={pullRequestInbox.selected ? {
      repository: pullRequestInbox.selected.repository,
      number: pullRequestInbox.selected.number,
    } : null}
    detail={pullRequestInbox.detail}
    onSelect={pullRequestInbox.select}
    onOpenOnGithub={(url) => void window.jingler.openExternal(url)}
    onOpenFiles={selectedPullRequestTarget?.session || selectedPullRequestTarget?.project
      ? openSelectedPullRequestFiles
      : undefined}
    onComment={pullRequestInbox.comment}
    onClosePr={pullRequestInbox.close}
    onMerge={pullRequestInbox.merge}
    closing={pullRequestInbox.closing}
    closeError={pullRequestInbox.closeError}
    merging={pullRequestInbox.merging}
    mergeError={pullRequestInbox.mergeError}
    sessionAction={selectedPullRequestTarget ? {
      label: selectedPullRequestTarget.session ? "Open session" : "Create session",
      onSelect: openSelectedPullRequestSession,
      ...(selectedPullRequestTarget.session || selectedPullRequestTarget.project
        ? {}
        : { disabledReason: "Add this repository as a local project to create a session." }),
    } : undefined}
    loading={pullRequestInbox.loading}
    detailLoading={pullRequestInbox.detailLoading}
    detailError={pullRequestInbox.detailError}
    error={pullRequestInbox.error} />;
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
 * The app root. Drives the dedicated `authMachine`; sign-in is optional, so the
 * app (`AuthedApp`) mounts regardless and sign-in happens from the sidebar.
 * The `jingler://` deep-link callback arrives from the main process via the
 * preload bridge and re-validates the freshly-stored token.
 */
export function App() {
  const [authState, authSend] = useMachine(authMachine);

  /**
   * The theme is applied ABOVE the auth flow, not inside it.
   *
   * The loading splash is the first thing an operator sees, at the moment the
   * app has the least state. Theming below it would mean launching into a dark
   * splash and having it turn light the instant the app mounted — exactly the
   * flash `boot-theme.ts` exists to prevent, just moved later.
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

  useEffect(() => window.jingler.onPreviewCloseTab(({ sessionId, chatId }) => {
    window.dispatchEvent(new CustomEvent(SESSION_SURFACE_COMMAND_EVENT, {
      detail: { type: "close-surface", sessionId, surface: { kind: "view", id: "browser", chatId } }
    }));
  }), []);

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
        theme tokens from its first frame. The plugin catalog is read from disk
        and has nothing to do with who is signed in.
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
  const [signInOpen, setSignInOpen] = useState(false);
  const signedIn = authState.matches("signedIn");
  const signedOut = authState.matches("signedOut");

  // The dialog is a view of the auth flow, not a second state: once the
  // browser or magic-link callback lands, it has nothing left to show.
  useEffect(() => {
    if (signedIn) setSignInOpen(false);
  }, [signedIn]);

  if (splashHeld) return <LoadingScreen />;

  // Sign-in is optional: the app always mounts. Auth only decides whether the
  // sidebar shows the account menu or a Sign in button — and neither while the
  // stored token is still being checked, so a signed-in boot never flashes one.
  return (
    <>
      <AuthedApp
        user={signedIn ? authState.context.session?.user : undefined}
        onSignOut={signedIn ? () => authSend({ type: "SIGN_OUT" }) : undefined}
        onSignIn={signedOut ? () => setSignInOpen(true) : undefined}
      />
      <SignInDialog
        open={signInOpen && signedOut}
        onOpenChange={(open) => {
          setSignInOpen(open);
          if (!open) authSend({ type: "RESET" });
        }}
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
    </>
  );
}

function renderAuthedAppGate(
  splashHeld: boolean,
  state: import("xstate").SnapshotFrom<typeof appMachine>,
  github: ReturnType<typeof useGitHubConnection>,
  repos: import("xstate").SnapshotFrom<typeof appMachine>["context"]["repos"],
  reposDir: string | null,
  send: import("xstate").ActorRefFrom<typeof appMachine>["send"]
) {
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
  return state.matches("setup")
    ? renderAppSetup(state, github, repos, reposDir, send)
    : null;
}

function renderAppSetup(
  state: import("xstate").SnapshotFrom<typeof appMachine>,
  github: ReturnType<typeof useGitHubConnection>,
  repos: import("xstate").SnapshotFrom<typeof appMachine>["context"]["repos"],
  reposDir: string | null,
  send: import("xstate").ActorRefFrom<typeof appMachine>["send"]
) {
  const setupStep = state.matches({ setup: "github" })
    ? "github"
    : state.matches({ setup: "provider" })
      ? "provider"
      : state.matches({ setup: "resources" })
        ? "resources"
        : "workspace";
  const providerBusy =
    state.matches({ setup: { provider: "refreshing" } }) ||
    state.matches({ setup: { provider: "authenticating" } }) ||
    state.matches({ setup: { provider: "completing" } });
  const resourcesBusy =
    state.matches({ setup: { resources: "detecting" } }) ||
    state.matches({ setup: { resources: "importing" } });
  return (
    <SetupScreen
      step={setupStep}
      github={github.connection}
      providerCatalog={state.context.providerCatalog}
      agentEndpointCatalog={state.context.agentEndpointCatalog}
      nativeEndpointLogin={{
        start: rpc.agentEndpointStartLogin,
        cancel: rpc.agentEndpointCancelLogin,
        refresh: async (endpointId) => {
          const catalog = await rpc.agentEndpointRefresh()
          send({ type: "ENDPOINT_CATALOG", catalog })
          return catalog.endpoints.some(({ endpoint }) => endpoint.id === endpointId && endpoint.status === "ready")
        }
      }}
      providerLoginEvent={state.context.providerLoginEvent}
      providerPendingAuthKind={state.context.providerPendingAuthKind}
      resourceDetection={state.context.resourceDetection}
      error={state.context.error}
      repos={repos}
      reposDir={reposDir}
      busy={
        state.matches({ setup: { workspace: "choosing" } }) ||
        github.busy ||
        providerBusy ||
        resourcesBusy
      }
      onChooseDir={() => send({ type: "CHOOSE" })}
      onContinue={() => send({ type: "CONTINUE" })}
      onConnectGithub={
        github.connection.connected ? github.manage : github.connect
      }
      onSkipGithub={() => {
        github.cancel();
        send({ type: "SKIP_GITHUB" });
      }}
      onConnectClaude={(token) =>
        send({
          type: "CONNECT_CLAUDE",
          kind: "claude-setup-token",
          id: crypto.randomUUID(),
          token,
          targetId: "desktop",
        })
      }
      onStartCodex={(method) =>
        send({
          type: "START_CODEX",
          kind: "openai-codex-oauth",
          id: crypto.randomUUID(),
          method,
          targetId: "desktop",
        })
      }
      onConnectApi={(providerId, apiKey) =>
        send({
          type: "CONNECT_API",
          kind: "api-key",
          id: crypto.randomUUID(),
          providerId,
          apiKey,
          targetId: "desktop",
        })
      }
      onContinueProvider={() => send({ type: "CONTINUE_PROVIDER" })}
      onSkipProvider={() => send({ type: "SKIP_PROVIDER" })}
      onCancelAuth={() => send({ type: "CANCEL_AUTH" })}
      onRetryProvider={() => {
        if (state.matches({ setup: { provider: "authFailed" } })) {
          send({ type: "RETRY_AUTH" });
        } else {
          send({ type: "RETRY_PROVIDER" });
        }
      }}
      onImportResources={(candidates) =>
        send({ type: "IMPORT_RESOURCES", candidates })
      }
      onSkipResources={() => send({ type: "SKIP_RESOURCES" })}
      onCancelResourceImport={() => send({ type: "CANCEL_RESOURCE_IMPORT" })}
      onRetryResources={() => send({ type: "RETRY_RESOURCES" })}
    />
  );
}

function firstSettingsError(...errors: ReadonlyArray<{ message?: string } | null>): string | null {
  for (const error of errors) {
    if (error?.message != null) return error.message;
  }
  return null;
}

function offloadSettingsStatus(state: import("xstate").SnapshotFrom<ReturnType<typeof createOffloadSettingsMachine>>, enabled: boolean) {
  if (state.matches("saving")) return "priming";
  if (state.matches("failed")) return "failed";
  return enabled ? "ready" : "disabled";
}

function deleteSessionDescription(pendingDelete: Session | null) {
  return pendingDelete
    ? workspaceModeOf(pendingDelete) === "direct"
      ? `“${pendingDelete.title}” session data will be permanently removed. The repository checkout will be left untouched. This can't be undone.`
      : `“${pendingDelete.title}” and its isolated worktree will be permanently removed. This can't be undone.`
    : undefined
}

function appStoredPreferences(config: Awaited<ReturnType<typeof rpc.configGet>> | undefined) {
  const githubConfig = config?.github ?? null;
  const gitConfig = config?.git ?? null;
  const notificationsConfig = config?.notifications ?? null;
  const persistedOffloadCompute = config?.offloadCompute ?? null;
  return { githubConfig, gitConfig, notificationsConfig, persistedOffloadCompute, defaultConnectionId: config?.defaultConnectionId ?? null, defaultModelId: config?.defaultModelId ?? null };
}

function hasEnabledDebugPlugin(catalog: ReturnType<typeof usePluginCatalog>): boolean {
  return catalog?.plugins.some((plugin) => plugin.enabled && plugin.manifest.id === "debug") ?? false;
}

function shouldAutoDetectPr(connected: boolean, config: GithubConfig | null): boolean {
  return connected && (config?.autoDetectPr ?? true);
}

function ArchiveConfirmation({ state, send }: { state: import("xstate").SnapshotFrom<typeof sessionArchiveMachine>; send: import("xstate").ActorRefFrom<typeof sessionArchiveMachine>["send"] }) {
  return <ConfirmDialog
    closeOnConfirm={false}
    open={state.matches("confirming") || (Boolean(state.context.session?.checkpointPtyHistory) && state.matches("archiving")) || state.matches("failed")}
    onOpenChange={open => { if (!open) send({ type: "CANCEL" }); }}
    title={state.matches("failed") ? "Archive failed" : "Archive without cleanup?"}
    description={state.context.error ?? "Interactive terminal jobs cannot be proven stopped. This only hides the workspace in the archive: files and running jobs are preserved, and cleanup will not run. Destructive deletion remains blocked."}
    confirmLabel={state.matches("failed") ? "Retry" : "Archive without cleanup"}
    onConfirm={() => { send({ type: "CONFIRM" }); }}
  />
}
