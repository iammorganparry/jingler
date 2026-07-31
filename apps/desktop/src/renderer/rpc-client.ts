/**
 * Renderer-side RPC client. Mirror image of `src/main/rpc.ts`: a custom
 * `RpcClient.Protocol` that shuttles encoded frames over the preload bridge
 * (`window.jingler`), driving a real `RpcClient` built from the shared
 * `JinglerRpcs` group. Callers get plain, typed Promises back.
 */
import type {
  AssetPayload,
  BackgroundTask,
  AdversarialReview,
  ArchiveReason,
  Attachment,
  AuthProvider,
  AuthSession,
  AuthSessionInfo,
  BrowserBounds,
  LoadedPlugin,
  PluginCatalog,
  CliInfo,
  CliKind,
  CreateSessionFromIssueInput,
  CreateSessionFromPrInput,
  CreateSessionInput,
  ExecutionMode,
  GateDecision,
  GhStatus,
  GitConfig,
  NotificationKind,
  NotificationsConfig,
  HarnessBilling,
  GithubConfig,
  Issue,
  IssueAutomations,
  IssueSummary,
  McpInjectionTarget,
  McpServerStatus,
  OpenConnectorConfig,
  OpenConnectorDefaults,
  ConnectorProvider,
  ConnectorProviderDetail,
  ConnectorConnection,
  OAuthClientInfo,
  ConnectorActionResult,
  Message,
  ModelOption,
  OpencodeProviderInfo,
  OrchestratorPreference,
  WorkerRoutingConfig,
  ProviderModels,
  PermissionMode,
  PlanApprovalResult,
  PlanCommentMessageDeliveryState,
  PlanDocument,
  PlanMentionDelivery,
  PlanParticipant,
  PlanTemplateConfig,
  PrFileChange,
  PrMergeMethod,
  PrState,
  SessionPrStatus,
  PrSummary,
  ProviderConfig,
  PullRequest,
  QuestionAnswer,
  ReasoningSetting,
  Repo,
  ReviewComment,
  ReviewSubmitKind,
  Session,
  SettledSessionStatus,
  Skill,
  StreamEvent,
  TerminalChunk,
  ThemeCatalog,
  ThemeSummary,
  VsCodeTheme,
  TerminalInfo,
  ContextConfig,
  ContextSnapshot,
  Usage,
  WorkerActivity,
  WorkspaceConfig
} from "@jingler/core"
import { JinglerRpcs } from "@jingler/contracts"
import { RpcClient } from "@effect/rpc"
import type { FromClientEncoded, FromServerEncoded } from "@effect/rpc/RpcMessage"
import { Cause, Effect, Exit, Fiber, Layer, ManagedRuntime, Runtime, Scope, Stream } from "effect"

/**
 * A custom `RpcClient.Protocol` bound to the preload bridge. `send` ships a
 * client→server frame to main; incoming server→client frames are pushed into
 * the client core via `writeResponse`.
 */
const ClientProtocolLive = Layer.effect(
  RpcClient.Protocol,
  RpcClient.Protocol.make((writeResponse) =>
    Effect.gen(function* () {
      const runFork = Runtime.runFork(yield* Effect.runtime<never>())

      window.jingler.on((data) => {
        runFork(writeResponse(data as FromServerEncoded))
      })

      return {
        send: (request: FromClientEncoded) =>
          Effect.sync(() => window.jingler.send(request)),
        supportsAck: true,
        supportsTransferables: false
      }
    })
  )
)

/** One runtime provides the IPC client protocol for the app's lifetime. */
const runtime = ManagedRuntime.make(ClientProtocolLive)

/**
 * The client's background fibers must outlive any single call, so we build it
 * once inside a scope that is never closed (until the page unloads).
 */
const clientScope = Effect.runSync(Scope.make())

const clientPromise = runtime.runPromise(
  RpcClient.make(JinglerRpcs).pipe(Scope.extend(clientScope))
)

const run = <A>(
  f: (client: Awaited<typeof clientPromise>) => Effect.Effect<A, unknown>
): Promise<A> => clientPromise.then((client) => runtime.runPromise(f(client)))

/**
 * Forward a run's events to `onEvent`, guaranteeing the turn settles.
 *
 * The renderer's conversation machine only leaves `running` on a `Done`/`Failed`
 * event. A transport-level failure used to die on this forked fiber in silence,
 * and a stream that simply ended without a terminal event left the turn spinning
 * (or, after a reload, rendered as an empty assistant block). Whatever happens to
 * the stream, exactly one terminal event reaches the machine. Interruption is the
 * one exception: that is the stop path, which emits its own.
 */
const drainRun = (
  stream: Stream.Stream<StreamEvent, unknown>,
  onEvent: (event: StreamEvent) => void
): Effect.Effect<void> => {
  let terminal = false
  return stream.pipe(
    Stream.runForEach((event) =>
      Effect.sync(() => {
        if (event._tag === "Done" || event._tag === "Failed") terminal = true
        onEvent(event)
      })
    ),
    Effect.onExit((exit) =>
      Effect.sync(() => {
        if (terminal || Exit.isInterrupted(exit)) return
        onEvent({
          _tag: "Failed",
          message: Exit.isFailure(exit)
            ? `The agent stream ended unexpectedly: ${Cause.pretty(exit.cause).split("\n")[0]}`
            : "The agent ended the turn without responding. Try again."
        })
      })
    ),
    Effect.ignore
  )
}

/** The typed calls the renderer consumes. */
export const rpc = {
  /** What each installed harness will actually be billed to. */
  billingPaths: (): Promise<ReadonlyArray<HarnessBilling>> => run((c) => c.Billing.paths()),
  discoveryList: (): Promise<ReadonlyArray<CliInfo>> =>
    run((c) => c.Discovery.list()),
  configGet: (): Promise<WorkspaceConfig | null> =>
    run((c) => c.Config.get()),
  chooseReposDir: (): Promise<WorkspaceConfig | null> =>
    run((c) => c.Setup.chooseReposDir()),
  workspaceRepos: (): Promise<ReadonlyArray<Repo>> =>
    run((c) => c.Workspace.repos()),
  workspaceBranches: (repoPath: string): Promise<ReadonlyArray<string>> =>
    run((c) => c.Workspace.branches({ repoPath })),
  ghStatus: (): Promise<GhStatus> =>
    run((c) => c.Gh.status()),
  sessionsList: (): Promise<ReadonlyArray<Session>> =>
    run((c) => c.Sessions.list()),
  sessionsGet: (id: string): Promise<Session> =>
    run((c) => c.Sessions.get({ id })),
  sessionsCreate: (input: CreateSessionInput): Promise<Session> =>
    run((c) => c.Sessions.create(input)),
  sessionsCreateFromPr: (input: CreateSessionFromPrInput): Promise<Session> =>
    run((c) => c.Sessions.createFromPr(input)),
  sessionsCreateFromIssue: (input: CreateSessionFromIssueInput): Promise<Session> =>
    run((c) => c.Sessions.createFromIssue(input)),
  sessionsLinkIssue: (
    sessionId: string,
    issue: IssueSummary,
    automations: IssueAutomations
  ): Promise<Session> => run((c) => c.Sessions.linkIssue({ sessionId, issue, automations })),
  sessionsUnlinkIssue: (sessionId: string): Promise<Session> =>
    run((c) => c.Sessions.unlinkIssue({ sessionId })),
  sessionsClearInitialPrompt: (sessionId: string): Promise<Session> =>
    run((c) => c.Sessions.clearInitialPrompt({ sessionId })),
  sessionsArchive: (sessionId: string, reason: ArchiveReason): Promise<Session> =>
    run((c) => c.Sessions.archive({ sessionId, reason })),
  sessionsRestore: (sessionId: string): Promise<Session> =>
    run((c) => c.Sessions.restore({ sessionId })),
  sessionsRetitle: (sessionId: string): Promise<Session> =>
    run((c) => c.Sessions.retitle({ sessionId })),
  sessionsRename: (sessionId: string, title: string): Promise<Session> =>
    run((c) => c.Sessions.rename({ sessionId, title })),
  sessionsSetStatus: (sessionId: string, status: SettledSessionStatus): Promise<Session> =>
    run((c) => c.Sessions.setStatus({ sessionId, status })),
  sessionsSetPersistent: (sessionId: string, persistent: boolean): Promise<Session> =>
    run((c) => c.Sessions.setPersistent({ sessionId, persistent })),
  sessionsDelete: (sessionId: string): Promise<void> =>
    run((c) => c.Sessions.delete({ sessionId })),
  sessionsCreateChat: (sessionId: string): Promise<Session> =>
    run((c) => c.Sessions.createChat({ sessionId })),
  sessionsSelectChat: (sessionId: string, chatId: string): Promise<Session> =>
    run((c) => c.Sessions.selectChat({ sessionId, chatId })),
  sessionsRenameChat: (sessionId: string, chatId: string, title: string): Promise<Session> =>
    run((c) => c.Sessions.renameChat({ sessionId, chatId, title })),
  sessionsCloseChat: (sessionId: string, chatId: string): Promise<Session> =>
    run((c) => c.Sessions.closeChat({ sessionId, chatId })),
  sessionsReopenChat: (sessionId: string, chatId: string): Promise<Session> =>
    run((c) => c.Sessions.reopenChat({ sessionId, chatId })),
  sessionsSetOrchestratorEnabled: (
    sessionId: string,
    chatId: string,
    orchestratorEnabled: boolean
  ): Promise<Session> =>
    run((c) =>
      c.Sessions.setOrchestratorEnabled({
        sessionId,
        chatId,
        orchestratorEnabled
      })
    ),
  /**
   * A newest-anchored window of the transcript. Omit `before` for the newest
   * page; pass the previous page's opaque cursor to page further back. `hasMore`
   * gates the "Load earlier" affordance. Images arrive with EMPTY `data`, as
   * attachment bytes are loaded lazily.
   */
  sessionsTranscriptPage: (
    sessionId: string,
    chatId: string,
    before: string | undefined,
    limit: number
  ): Promise<{
    messages: ReadonlyArray<Message>
    hasMore: boolean
    cursor?: string
  }> =>
    run((c) => c.Sessions.transcriptPage({ sessionId, chatId, before, limit })),
  /** One image attachment's base64, or null when the id is unknown. */
  sessionsAttachment: (chatId: string, attachmentId: string): Promise<string | null> =>
    run((c) => c.Sessions.attachment({ chatId, attachmentId })),
  sessionsDiff: (id: string): Promise<string> => run((c) => c.Sessions.diff({ id })),
  workspaceFiles: (repoPath: string): Promise<ReadonlyArray<string>> =>
    run((c) => c.Workspace.files({ repoPath })),
  /**
   * Read one asset out of a session's worktree. `path` is worktree-relative and
   * is re-validated in main — the renderer never gets to say where on disk a
   * read lands.
   */
  assetRead: (sessionId: string, path: string): Promise<AssetPayload> =>
    run((c) => c.Asset.read({ sessionId, path })),
  assetReveal: (sessionId: string, path: string): Promise<void> =>
    run((c) => c.Asset.reveal({ sessionId, path })),
  /** Park Chromium's PDF viewer over `bounds`. Main resolves the path itself. */
  assetOpenPdf: (
    sessionId: string,
    path: string,
    bounds: { x: number; y: number; width: number; height: number }
  ): Promise<void> => run((c) => c.Asset.openPdf({ sessionId, path, bounds })),
  assetHidePdf: (): Promise<void> => run((c) => c.Asset.hidePdf()),
  workspaceRevertFile: (sessionId: string, path: string): Promise<void> =>
    run((c) => c.Workspace.revertFile({ sessionId, path })),
  workspaceRevertLines: (
    sessionId: string,
    path: string,
    startLine: number,
    endLine: number
  ): Promise<void> => run((c) => c.Workspace.revertLines({ sessionId, path, startLine, endLine })),
  skillsList: (sessionId: string): Promise<ReadonlyArray<Skill>> =>
    run((c) => c.Skills.list({ sessionId })),
  /** The unified OpenConnector settings + hasToken + env-aware onboarding defaults. */
  openConnectorGet: (): Promise<{
    config: OpenConnectorConfig
    hasToken: boolean
    defaults: OpenConnectorDefaults
  }> => run((c) => c.OpenConnector.get()),
  /** Save settings, and optionally the token (omit to keep, null/"" to clear). */
  openConnectorSet: (config: OpenConnectorConfig, token?: string | null): Promise<void> =>
    run((c) => c.OpenConnector.set({ config, token })),
  /** Live probe of the configured endpoint (for the panel's Test button). */
  openConnectorTest: (): Promise<McpServerStatus> => run((c) => c.OpenConnector.test()),
  /** One-click onboarding: apply the environment default (dev = local, prod = hosted). */
  openConnectorAutoSetup: (): Promise<void> => run((c) => c.OpenConnector.autoSetup()),
  /** Which harnesses actually receive the unified server, and why not when they don't. */
  openConnectorInjection: (): Promise<ReadonlyArray<McpInjectionTarget>> =>
    run((c) => c.OpenConnector.injection()),
  /** The OpenConnector provider catalog (Connector Center). */
  connectorProviders: (): Promise<ReadonlyArray<ConnectorProvider>> =>
    run((c) => c.Connector.providers()),
  /** ONE provider's connect-form shape — fields, OAuth scopes, action count. */
  connectorProvider: (service: string): Promise<ConnectorProviderDetail> =>
    run((c) => c.Connector.provider({ service })),
  /** The operator's established connections (no secrets). */
  connectorConnections: (): Promise<ReadonlyArray<ConnectorConnection>> =>
    run((c) => c.Connector.connections()),
  /** OAuth-client metadata per provider (whether client creds are stored + redirect URI). */
  connectorOauthConfigs: (): Promise<ReadonlyArray<OAuthClientInfo>> =>
    run((c) => c.Connector.oauthConfigs()),
  /** Create/replace an api-key or custom-credential connection. Secret goes IN only. */
  connectorConnect: (
    service: string,
    authType: "api_key" | "custom_credential",
    values: Record<string, string>,
    connectionName?: string
  ): Promise<ConnectorActionResult> =>
    run((c) => c.Connector.connect({ service, authType, values, connectionName })),
  /** Remove a connection. */
  connectorDisconnect: (service: string, connectionName?: string): Promise<ConnectorActionResult> =>
    run((c) => c.Connector.disconnect({ service, connectionName })),
  /** Store OAuth client id/secret for a provider. Secret goes IN only. */
  connectorSetOauthConfig: (
    provider: string,
    clientId: string,
    clientSecret: string,
    extra?: Record<string, string>
  ): Promise<ConnectorActionResult> =>
    run((c) => c.Connector.setOauthConfig({ provider, clientId, clientSecret, extra })),
  /** Begin OAuth — the main process opens the consent URL in the system browser. */
  connectorStartOauth: (service: string, connectionName?: string): Promise<ConnectorActionResult> =>
    run((c) => c.Connector.startOauth({ service, connectionName })),
  modelsList: (cli: CliKind): Promise<ReadonlyArray<ModelOption>> =>
    run((c) => c.Models.list({ cli })),
  modelsCatalog: (): Promise<ReadonlyArray<ProviderModels>> => run((c) => c.Models.catalog()),
  /** opencode's resolved providers + where each credential came from. */
  opencodeListProviders: (): Promise<ReadonlyArray<OpencodeProviderInfo>> =>
    run((c) => c.Opencode.listProviders()),
  /** Store an API key in opencode's OWN credential file (not SecretStore). */
  opencodeSetAuth: (providerId: string, key: string): Promise<boolean> =>
    run((c) => c.Opencode.setAuth({ providerId, key })),
  usageGet: (): Promise<Usage> => run((c) => c.Usage.get()),
  /** A session's context accounting — drives the meter and the Settings list. */
  contextState: (sessionId: string, chatId: string): Promise<ContextSnapshot> =>
    run((c) => c.Context.state({ sessionId, chatId })),
  /**
   * Compact now. Resolves as soon as the request is accepted, NOT when the
   * summary is ready — the digest builds in the background and applies on the
   * next turn, so the UI must not park on it.
   */
  contextCompactNow: (sessionId: string, chatId: string): Promise<void> =>
    run((c) => c.Context.compactNow({ sessionId, chatId })),
  configSetContext: (context: ContextConfig): Promise<WorkspaceConfig> =>
    run((c) => c.Config.setContext(context)),
  sessionsSetAutoCompact: (id: string, autoCompact: boolean | null): Promise<Session> =>
    run((c) => c.Sessions.setAutoCompact({ id, autoCompact })),
  agentDecideGate: (
    sessionId: string,
    chatId: string,
    gateId: string,
    decision: GateDecision
  ): Promise<void> =>
    run((c) => c.Agent.decideGate({ sessionId, chatId, gateId, decision })),
  agentAnswerQuestion: (
    sessionId: string,
    chatId: string,
    requestId: string,
    answers: ReadonlyArray<QuestionAnswer>
  ): Promise<void> =>
    run((c) => c.Agent.answerQuestion({ sessionId, chatId, requestId, answers })),
  agentSetMode: (sessionId: string, chatId: string, mode: PermissionMode): Promise<void> =>
    run((c) => c.Agent.setMode({ sessionId, chatId, mode })),
  agentSetReasoning: (
    sessionId: string,
    cli: "claude" | "codex" | "opencode",
    reasoning: ReasoningSetting | undefined
  ): Promise<void> =>
    run((c) => {
      if (cli === "claude") {
        const effort = reasoning?.effort
        const compatible = reasoning === undefined
          ? undefined
          : {
              enabled: reasoning.enabled,
              ...(effort === undefined
                ? {}
                : { effort: effort === "minimal" ? "low" as const : effort })
            }
        return c.Agent.setReasoning({
          sessionId,
          cli,
          ...(compatible === undefined ? {} : { reasoning: compatible })
        })
      }
      const effort = reasoning?.effort
      const compatible = reasoning === undefined
        ? undefined
        : {
            enabled: reasoning.enabled,
            ...(effort === undefined
              ? {}
              : { effort: effort === "max" ? "xhigh" as const : effort })
          }
      return c.Agent.setReasoning({
        sessionId,
        cli,
        ...(compatible === undefined ? {} : { reasoning: compatible })
      })
    }),
  agentCommentPlanStep: (
    sessionId: string,
    planId: string,
    stepId: string,
    body: string,
    anchor?: { readonly quote: string; readonly prefix: string; readonly suffix: string }
  ): Promise<void> =>
    run((c) => c.Agent.commentPlanStep({ sessionId, planId, stepId, body, ...(anchor ? { anchor } : {}) })),
  agentRevisePlan: (sessionId: string, planId: string): Promise<void> =>
    run((c) => c.Agent.revisePlan({ sessionId, planId })),
  agentApprovePlan: (
    sessionId: string,
    planId: string,
    executionMode?: ExecutionMode,
    revision?: number
  ): Promise<PlanApprovalResult> =>
    run((c) => c.Agent.approvePlan({ sessionId, planId, executionMode, revision })),
  agentStopWorker: (
    sessionId: string,
    planId: string,
    agentId: string
  ): Promise<void> =>
    run((c) => c.Agent.stopWorker({ sessionId, planId, agentId })),
  agentRetryWorker: (
    sessionId: string,
    planId: string,
    agentId: string
  ): Promise<void> =>
    run((c) => c.Agent.retryWorker({ sessionId, planId, agentId })),
  /**
   * Observe one canonical plan's orchestration workers without starting or
   * resuming execution. The returned handle only detaches this renderer.
   */
  agentWatchWorkers: (
    sessionId: string,
    planId: string,
    chatId: string,
    onActivity: (activity: WorkerActivity) => void,
    onFailure: (error: unknown) => void
  ): (() => void) => {
    let fiber: Fiber.RuntimeFiber<void, unknown> | null = null
    let cancelled = false
    void clientPromise.then(
      (client) => {
        if (cancelled) return
        const streamFiber = runtime.runFork(
          client.Agent.watchWorkers({ sessionId, planId, chatId }).pipe(
            Stream.runForEach((activity) =>
              Effect.sync(() => onActivity(activity))
            )
          )
        )
        fiber = streamFiber
        runtime.runFork(
          Fiber.await(streamFiber).pipe(
            Effect.tap((exit) =>
              Effect.sync(() => {
                if (cancelled) return
                onFailure(
                  Exit.isFailure(exit)
                    ? Cause.squash(exit.cause)
                    : new Error("Worker activity stream ended unexpectedly.")
                )
              })
            ),
            Effect.asVoid
          )
        )
      },
      (error) => {
        if (!cancelled) onFailure(error)
      }
    )
    return () => {
      cancelled = true
      if (fiber) runtime.runFork(Fiber.interrupt(fiber))
    }
  },
  agentSetHarness: (sessionId: string, chatId: string, cli: CliKind, model: string): Promise<Session> =>
    run((c) => c.Agent.setHarness({ sessionId, chatId, cli, model })),
  agentStop: (sessionId: string, chatId: string): Promise<void> =>
    run((c) => c.Agent.stop({ sessionId, chatId })),
  agentStopSubagent: (sessionId: string, chatId: string, agentId: string): Promise<void> =>
    run((c) => c.Agent.stopSubagent({ sessionId, chatId, agentId })),
  agentSteer: (
    sessionId: string,
    chatId: string,
    text: string,
    images: ReadonlyArray<Attachment>
  ) =>
    run((c) => c.Agent.steer({ sessionId, chatId, text, images: [...images] })),

  configSetGithub: (github: GithubConfig): Promise<WorkspaceConfig> =>
    run((c) => c.Config.setGithub(github)),
  configSetGit: (git: GitConfig): Promise<WorkspaceConfig> =>
    run((c) => c.Config.setGit(git)),
  configSetNotifications: (notifications: NotificationsConfig): Promise<WorkspaceConfig> =>
    run((c) => c.Config.setNotifications(notifications)),
  /** Turn plan mode's unattended (read-only) command execution on or off. */
  configSetPlanAutoRun: (planAutoRun: boolean): Promise<WorkspaceConfig> =>
    run((c) => c.Config.setPlanAutoRun({ planAutoRun })),
  /** Persist ADHD mode; resolves with the whole updated config. */
  configSetAdhdMode: (adhdMode: boolean): Promise<WorkspaceConfig> =>
    run((c) => c.Config.setAdhdMode({ adhdMode })),
  /** Persist Jingler mode (the agentic orchestrator flow); resolves with the whole config. */
  configSetOrchestratorEnabled: (orchestratorEnabled: boolean): Promise<WorkspaceConfig> =>
    run((c) => c.Config.setOrchestratorEnabled({ orchestratorEnabled })),
  /** Persist the conversation + code text-size multiplier. */
  configSetFontScale: (fontScale: number): Promise<WorkspaceConfig> =>
    run((c) => c.Config.setFontScale({ fontScale })),
  /** Which harness new sessions start on (Settings · Providers). */
  configSetDefaultCli: (cli: CliKind): Promise<WorkspaceConfig> =>
    run((c) => c.Config.setDefaultCli({ cli })),
  /** Persist the provider-neutral planner used by newly-created sessions. */
  configSetOrchestrator: (orchestrator: OrchestratorPreference): Promise<WorkspaceConfig> =>
    run((c) => c.Config.setOrchestrator(orchestrator)),
  configSetWorkerRouting: (workerRouting: WorkerRoutingConfig): Promise<WorkspaceConfig> =>
    run((c) => c.Config.setWorkerRouting(workerRouting)),
  /**
   * Ask main to raise an OS notification. Main decides whether it actually
   * surfaces — it owns window focus and the stored prefs.
   */
  notifyShow: (input: {
    sessionId: string
    kind: NotificationKind
    title: string
    body: string
    isActiveSession: boolean
  }): Promise<void> => run((c) => c.Notify.show(input)),
  configSetStarredRepos: (paths: ReadonlyArray<string>): Promise<WorkspaceConfig> =>
    run((c) => c.Config.setStarredRepos({ paths })),
  configSetCollapsedRepos: (paths: ReadonlyArray<string>): Promise<WorkspaceConfig> =>
    run((c) => c.Config.setCollapsedRepos({ paths })),
  configSetLastRepoPath: (path: string): Promise<WorkspaceConfig> =>
    run((c) => c.Config.setLastRepoPath({ path })),
  configSetPlanTemplate: (template: PlanTemplateConfig): Promise<WorkspaceConfig> =>
    run((c) => c.Config.setPlanTemplate({ template })),
  configSetProvider: (cli: CliKind, provider: ProviderConfig): Promise<WorkspaceConfig> =>
    run((c) => c.Config.setProvider({ cli, provider })),
  githubPr: (sessionId: string): Promise<PullRequest | null> =>
    run((c) => c.Github.pr({ sessionId })),
  githubPrState: (sessionId: string): Promise<SessionPrStatus | null> =>
    run((c) => c.Github.prState({ sessionId })),
  githubListPrs: (
    repoPath: string,
    opts: { mine: boolean; search: string }
  ): Promise<ReadonlyArray<PrSummary>> =>
    run((c) => c.Github.listPrs({ repoPath, mine: opts.mine, search: opts.search })),
  githubListIssues: (
    repoPath: string,
    opts: { mine: boolean; search: string }
  ): Promise<ReadonlyArray<IssueSummary>> =>
    run((c) => c.Github.listIssues({ repoPath, mine: opts.mine, search: opts.search })),
  githubCloseIssue: (sessionId: string): Promise<void> =>
    run((c) => c.Github.closeIssue({ sessionId })),
  githubIssue: (sessionId: string): Promise<Issue | null> =>
    run((c) => c.Github.issue({ sessionId })),
  githubFiles: (sessionId: string): Promise<ReadonlyArray<PrFileChange>> =>
    run((c) => c.Github.files({ sessionId })),
  githubDiff: (sessionId: string): Promise<string> =>
    run((c) => c.Github.diff({ sessionId })),
  githubDetectPr: (sessionId: string): Promise<number | null> =>
    run((c) => c.Github.detectPr({ sessionId })),
  /**
   * Run an adversarial review of the session's PR. Cheap and safe to call
   * speculatively: the main process short-circuits on an unchanged PR head, so
   * only `force` guarantees a fresh agent run.
   */
  reviewRun: (sessionId: string, force = false): Promise<AdversarialReview> =>
    run((c) => c.Review.run({ sessionId, force })),
  reviewGet: (sessionId: string): Promise<AdversarialReview | null> =>
    run((c) => c.Review.get({ sessionId })),
  /**
   * Record that the stored review's critical/major findings reached the agent.
   * Returns the stamp, or null when there was no stored review to stamp.
   */
  reviewMarkRouted: (sessionId: string): Promise<string | null> =>
    run((c) => c.Review.markRouted({ sessionId })),
  /**
   * Credit the commits that fixed outstanding findings. Resolves with the updated
   * review, or null when nothing changed — see the contract: null means "leave the
   * query cache alone", which is the common answer.
   */
  reviewReconcile: (sessionId: string): Promise<AdversarialReview | null> =>
    run((c) => c.Review.reconcile({ sessionId })),
  githubCreatePr: (input: {
    sessionId: string
    title: string
    body: string
    base: string
    draft: boolean
  }): Promise<number> => run((c) => c.Github.createPr(input)),
  githubComment: (sessionId: string, body: string, toGithub: boolean): Promise<void> =>
    run((c) => c.Github.comment({ sessionId, body, toGithub })),
  githubReview: (sessionId: string, kind: ReviewSubmitKind, body: string): Promise<void> =>
    run((c) => c.Github.review({ sessionId, kind, body })),
  /**
   * Post the reviewer's drafts to the PR as line-anchored inline comments.
   * Resolves to the number that couldn't be anchored (folded into the review
   * body instead) — 0 when everything landed on a line.
   */
  githubSubmitReview: (
    sessionId: string,
    comments: ReadonlyArray<ReviewComment>
  ): Promise<number> => run((c) => c.Github.submitReview({ sessionId, comments })),
  githubResolveThread: (sessionId: string, threadId: string, resolved: boolean): Promise<void> =>
    run((c) => c.Github.resolveThread({ sessionId, threadId, resolved })),
  githubReplyToThread: (sessionId: string, commentId: number, body: string): Promise<void> =>
    run((c) => c.Github.replyToThread({ sessionId, commentId, body })),
  githubMerge: (sessionId: string, method?: PrMergeMethod): Promise<void> =>
    run((c) => c.Github.merge({ sessionId, method })),
  githubMarkReady: (sessionId: string): Promise<void> =>
    run((c) => c.Github.markReady({ sessionId })),
  /** Merge the base into the PR's head on GitHub (clears a `BEHIND` merge state). */
  githubUpdateBranch: (sessionId: string): Promise<void> =>
    run((c) => c.Github.updateBranch({ sessionId })),

  /**
   * Subscribe to a prompt's normalized event stream. Forks the RPC stream on the
   * client runtime, pushing each `StreamEvent` to `onEvent`; returns a canceller
   * that interrupts the run (used on unmount / session switch / stop).
   */
  agentRun: (
    sessionId: string,
    chatId: string,
    text: string,
    onEvent: (event: StreamEvent) => void,
    images: ReadonlyArray<Attachment> = [],
    options: {
      readonly reasoning?: ReasoningSetting | null
    } = {}
  ): (() => void) => {
    let fiber: Fiber.RuntimeFiber<void, unknown> | null = null
    let cancelled = false
    void clientPromise.then((client) => {
      if (cancelled) return
      fiber = runtime.runFork(
        drainRun(client.Agent.run({ sessionId, chatId, text, images, ...options }), onEvent)
      )
    })
    return () => {
      cancelled = true
      if (fiber) runtime.runFork(Fiber.interrupt(fiber))
    }
  },
  agentResumePlan: (
    sessionId: string,
    chatId: string,
    planId: string,
    revision: number | undefined,
    onEvent: (event: StreamEvent) => void
  ): (() => void) => {
    let fiber: Fiber.RuntimeFiber<void, unknown> | null = null
    let cancelled = false
    void clientPromise.then((client) => {
      if (cancelled) return
      fiber = runtime.runFork(
        drainRun(client.Agent.resumePlan({ sessionId, chatId, planId, revision }), onEvent)
      )
    })
    return () => {
      cancelled = true
      if (fiber) runtime.runFork(Fiber.interrupt(fiber))
    }
  },

  // ── Terminal ─────────────────────────────────────────────────────────────
  /** Spawn a PTY for a session (cwd defaults to its worktree) and return it. */
  terminalCreate: (
    sessionId: string,
    cwd: string | undefined,
    cols: number,
    rows: number
  ): Promise<TerminalInfo> => run((c) => c.Terminal.create({ sessionId, cwd, cols, rows })),
  /** Send keystrokes / pasted text to a terminal (fire-and-forget). */
  terminalWrite: (terminalId: string, data: string): Promise<void> =>
    run((c) => c.Terminal.write({ terminalId, data })),
  /** Resize a terminal's PTY (drives SIGWINCH). */
  terminalResize: (terminalId: string, cols: number, rows: number): Promise<void> =>
    run((c) => c.Terminal.resize({ terminalId, cols, rows })),
  /** Kill a terminal's shell and drop it. */
  terminalKill: (terminalId: string): Promise<void> =>
    run((c) => c.Terminal.kill({ terminalId })),
  /** List a session's live terminals (rebuild the tab strip on mount). */
  terminalList: (sessionId: string): Promise<ReadonlyArray<TerminalInfo>> =>
    run((c) => c.Terminal.list({ sessionId })),

  // ── Background tasks ───────────────────────────────────────────────────────
  /** A session's background tasks — running and recently settled. */
  backgroundTasksList: (sessionId: string): Promise<ReadonlyArray<BackgroundTask>> =>
    run((c) => c.BackgroundTasks.list({ sessionId })),
  /** Ask the harness to stop one task; resolves with its new (usually `stopping`) state. */
  backgroundTasksStop: (sessionId: string, taskId: string): Promise<BackgroundTask | null> =>
    run((c) => c.BackgroundTasks.stop({ sessionId, taskId })),
  /** Drop a settled task's row (the escape hatch for a failed one). Idempotent. */
  backgroundTasksDismiss: (sessionId: string, taskId: string): Promise<void> =>
    run((c) => c.BackgroundTasks.dismiss({ sessionId, taskId })),
  /** A settled task's transcript ("" while it is still running). */
  backgroundTasksOutput: (sessionId: string, taskId: string): Promise<string> =>
    run((c) => c.BackgroundTasks.output({ sessionId, taskId })),

  // ── Browser preview ────────────────────────────────────────────────────────
  /** Show the preview view and load `url` at `bounds` (rejects non-http(s)). */
  browserPreviewOpen: (url: string, bounds: BrowserBounds): Promise<void> =>
    run((c) => c.BrowserPreview.open({ url, bounds })),
  /** Keep the native view aligned with the pane's on-screen rect. */
  browserPreviewSetBounds: (bounds: BrowserBounds): Promise<void> =>
    run((c) => c.BrowserPreview.setBounds({ bounds })),
  /** Navigate the open preview to a new URL (rejects non-http(s)). */
  browserPreviewNavigate: (url: string): Promise<void> =>
    run((c) => c.BrowserPreview.navigate({ url })),
  /** Reload the current preview page. */
  browserPreviewReload: (): Promise<void> => run((c) => c.BrowserPreview.reload()),
  /** Hide the native view for a tab switch, keeping its page and history alive. */
  browserPreviewSetVisible: (visible: boolean): Promise<void> =>
    run((c) => c.BrowserPreview.setVisible({ visible })),
  /** Hide + destroy the preview view (pane closed / session switched). */
  browserPreviewClose: (): Promise<void> => run((c) => c.BrowserPreview.close()),

  // ── Auth ─────────────────────────────────────────────────────────────────
  /** The current authenticated session, or null when signed out. */
  authGetSession: (): Promise<AuthSession | null> => run((c) => c.Auth.getSession()),
  /** Begin OAuth sign-in — returns the URL to open in the system browser. */
  authStartSignIn: (provider: AuthProvider): Promise<string> =>
    run((c) => c.Auth.startSignIn({ provider })),
  /** Request an email magic link. `name` is set only from the sign-up form. */
  authSendMagicLink: (email: string, name?: string): Promise<void> =>
    run((c) => c.Auth.sendMagicLink({ email, name })),
  /** Sign out — revoke on the server and clear the local token. */
  authSignOut: (): Promise<void> => run((c) => c.Auth.signOut()),

  /**
   * Subscribe to a terminal's coalesced output. Mirrors `agentRun`: forks the
   * RPC stream and pushes each `TerminalChunk` to `onChunk`; returns a canceller
   * that detaches (interrupts the fiber) WITHOUT killing the PTY — used on
   * unmount / dock-hide / session switch.
   */
  /**
   * Subscribe to the running reviewer's events for a session. Safe to call when
   * nothing is running — it just stays quiet until a review starts. Returns the
   * unsubscribe.
   */
  planCurrent: (sessionId: string): Promise<PlanDocument | null> =>
    run((c) => c.Plan.current({ sessionId })),
  planStartDraft: (sessionId: string): Promise<PlanDocument> =>
    run((c) => c.Plan.startDraft({ sessionId })),
  planUpdateDocument: (input: {
    sessionId: string
    planId: string
    baseRevision: number
    source: string
    author: "user" | "agent"
  }): Promise<PlanDocument> => run((c) => c.Plan.updateDocument(input)),
  planParticipants: (
    sessionId: string,
    planId: string
  ): Promise<ReadonlyArray<PlanParticipant>> =>
    run((c) => c.Plan.participants({ sessionId, planId })),
  planDispatchMessage: (input: {
    sessionId: string
    planId: string
    baseRevision: number
    annotationId: string
    body: string
    authorId: string
    mentionedParticipantIds: ReadonlyArray<string>
  }): Promise<{
    readonly document: PlanDocument
    readonly messageId: string
    readonly deliveries: ReadonlyArray<PlanMentionDelivery>
  }> => run((c) => c.Plan.dispatchMessage(input)),
  planDispatchExistingMessage: (input: {
    sessionId: string
    planId: string
    baseRevision: number
    annotationId: string
    messageId: string
  }): Promise<{
    readonly document: PlanDocument
    readonly messageId: string
    readonly deliveries: ReadonlyArray<PlanMentionDelivery>
  }> => run((c) => c.Plan.dispatchExistingMessage(input)),
  planUpdateMessageDelivery: (input: {
    sessionId: string
    planId: string
    baseRevision: number
    annotationId: string
    messageId: string
    deliveryState: PlanCommentMessageDeliveryState
    author: "user" | "agent"
  }): Promise<PlanDocument> =>
    run((c) => c.Plan.updateMessageDelivery(input)),
  planSetThreadResolved: (input: {
    sessionId: string
    planId: string
    baseRevision: number
    annotationId: string
    resolved: boolean
    author: "user" | "agent"
  }): Promise<PlanDocument> => run((c) => c.Plan.setThreadResolved(input)),
  planWatch: (
    sessionId: string,
    onDocument: (document: PlanDocument) => void
  ): (() => void) => {
    let fiber: Fiber.RuntimeFiber<void, unknown> | null = null
    let cancelled = false
    void clientPromise.then((client) => {
      if (cancelled) return
      fiber = runtime.runFork(
        client.Plan.watch({ sessionId }).pipe(
          Stream.runForEach((document) => Effect.sync(() => onDocument(document)))
        )
      )
    })
    return () => {
      cancelled = true
      if (fiber) runtime.runFork(Fiber.interrupt(fiber))
    }
  },
  reviewWatch: (
    sessionId: string,
    chatId: string,
    onEvent: (event: StreamEvent) => void
  ): (() => void) => {
    let fiber: Fiber.RuntimeFiber<void, unknown> | null = null
    let cancelled = false
    void clientPromise.then((client) => {
      if (cancelled) return
      fiber = runtime.runFork(
        client.Review.watch({ sessionId, chatId }).pipe(
          Stream.runForEach((event) => Effect.sync(() => onEvent(event)))
        )
      )
    })
    return () => {
      cancelled = true
      if (fiber) runtime.runFork(Fiber.interrupt(fiber))
    }
  },

  terminalAttach: (
    terminalId: string,
    onChunk: (chunk: TerminalChunk) => void
  ): (() => void) => {
    let fiber: Fiber.RuntimeFiber<void, unknown> | null = null
    let cancelled = false
    void clientPromise.then((client) => {
      if (cancelled) return
      fiber = runtime.runFork(
        client.Terminal.attach({ terminalId }).pipe(
          Stream.runForEach((chunk) => Effect.sync(() => onChunk(chunk)))
        )
      )
    })
    return () => {
      cancelled = true
      if (fiber) runtime.runFork(Fiber.interrupt(fiber))
    }
  },

  // ── Themes ─────────────────────────────────────────────────────────────────

  /** Bundled presets plus `~/jingler/themes`, each with resolved tokens. */
  themeList: (): Promise<ThemeCatalog> => run((c) => c.Theme.list()),

  /** The raw VS Code JSON for a theme — what the editor loads. */
  themeGet: (id: string): Promise<VsCodeTheme | null> => run((c) => c.Theme.get({ id })),

  themeSave: (id: string, theme: VsCodeTheme): Promise<ThemeSummary> =>
    run((c) => c.Theme.save({ id, theme })),

  themeDelete: (id: string): Promise<void> => run((c) => c.Theme.delete({ id })),

  /** Copy a theme to an editable user theme — the only way to edit a built-in. */
  themeDuplicate: (id: string, name?: string): Promise<ThemeSummary> =>
    run((c) => c.Theme.duplicate({ id, name })),

  themeImport: (json: string, name?: string): Promise<ThemeSummary> =>
    run((c) => c.Theme.import({ json, name })),

  themeSetActive: (id: string): Promise<WorkspaceConfig> => run((c) => c.Theme.setActive({ id })),

  /** Reveal a user theme's file in Finder/Explorer. Ignored for other paths. */
  themeReveal: (path: string): Promise<void> => run((c) => c.Theme.reveal({ path })),

  themeSetCustomizations: (colors: Record<string, string>): Promise<WorkspaceConfig> =>
    run((c) => c.Theme.setCustomizations({ colors })),

  /**
   * Subscribe to `~/jingler/themes` changing on disk, so a theme edited in the
   * operator's own editor repaints the app live. Returns an unsubscribe.
   */
  themeWatch: (onCatalog: (catalog: ThemeCatalog) => void): (() => void) => {
    let fiber: Fiber.RuntimeFiber<void, unknown> | null = null
    let cancelled = false
    void clientPromise.then((client) => {
      if (cancelled) return
      fiber = runtime.runFork(
        client.Theme.watch().pipe(
          Stream.runForEach((catalog) => Effect.sync(() => onCatalog(catalog)))
        )
      )
    })
    return () => {
      cancelled = true
      if (fiber) runtime.runFork(Fiber.interrupt(fiber))
    }
  },

  // ── Plugins ────────────────────────────────────────────────────────────────

  pluginsList: (): Promise<PluginCatalog> => run((c) => c.Plugins.list()),

  pluginsSetEnabled: (pluginId: string, enabled: boolean): Promise<void> =>
    run((c) => c.Plugins.setEnabled({ pluginId, enabled })),

  pluginsUninstall: (pluginId: string): Promise<void> =>
    run((c) => c.Plugins.uninstall({ pluginId })),

  pluginsReveal: (pluginId: string): Promise<void> =>
    run((c) => c.Plugins.reveal({ pluginId })),

  pluginsInstallFromFolder: (sourcePath: string): Promise<LoadedPlugin> =>
    run((c) => c.Plugins.installFromFolder({ sourcePath })),

  /** Resolves `null` when the operator cancels the picker. */
  pluginsInstallFromPicker: (): Promise<LoadedPlugin | null> =>
    run((c) => c.Plugins.installFromPicker()),

  /** Fire an `activationEvents` trigger. Idempotent; a no-op if already running. */
  pluginsActivate: (pluginId: string): Promise<void> =>
    run((c) => c.Plugins.activate({ pluginId })),

  pluginsStorageGet: (pluginId: string, key: string): Promise<unknown> =>
    run((c) => c.Plugins.storageGet({ pluginId, key })),

  pluginsStorageSet: (pluginId: string, key: string, value: unknown): Promise<void> =>
    run((c) => c.Plugins.storageSet({ pluginId, key, value })),

  pluginsStorageDelete: (pluginId: string, key: string): Promise<void> =>
    run((c) => c.Plugins.storageDelete({ pluginId, key })),

  pluginsStorageKeys: (pluginId: string): Promise<ReadonlyArray<string>> =>
    run((c) => c.Plugins.storageKeys({ pluginId })),

  pluginsInvoke: (pluginId: string, commandId: string, arg?: unknown): Promise<unknown> =>
    run((c) => c.Plugins.invoke({ pluginId, commandId, arg })),

  pluginsAuthSessions: (): Promise<ReadonlyArray<AuthSessionInfo>> =>
    run((c) => c.Plugins.authSessions()),

  pluginsAuthRevoke: (pluginId: string, providerId: string): Promise<void> =>
    run((c) => c.Plugins.authRevoke({ pluginId, providerId })),

  /**
   * Subscribe to `~/jingler/plugins` changing on disk — the same live-reload
   * contract themes have, and the reason a plugin author can edit a file and see
   * the tab update without restarting the app.
   */
  pluginsWatch: (onCatalog: (catalog: PluginCatalog) => void): (() => void) => {
    let fiber: Fiber.RuntimeFiber<void, unknown> | null = null
    let cancelled = false
    void clientPromise.then((client) => {
      if (cancelled) return
      fiber = runtime.runFork(
        client.Plugins.watch().pipe(
          Stream.runForEach((catalog) => Effect.sync(() => onCatalog(catalog)))
        )
      )
    })
    return () => {
      cancelled = true
      if (fiber) runtime.runFork(Fiber.interrupt(fiber))
    }
  }
}
