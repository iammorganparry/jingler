/**
 * Renderer-side RPC client. Mirror image of `src/main/rpc.ts`: a custom
 * `RpcClient.Protocol` that shuttles encoded frames over the preload bridge
 * (`window.jingler`), driving a real `RpcClient` built from the shared
 * `JinglerRpcs` group. Callers get plain, typed Promises back.
 */
import type {
  AssetFileEntry,
  AssetPayload,
  AssetWriteResult,
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
  PluginSettingValue,
  PluginSettingsSnapshot,
  CreateSessionFromIssueInput,
  CreateSessionFromPrInput,
  CreateSessionInput,
  ExecutionMode,
  Environment,
  ExplanationDocument,
  PairSshEnvironmentInput,
  SshHost,
  ExternalInstructionIdentity,
  GateDecision,
  GitHubAppConnectionStatus,
  GitHubCloneRepository,
  GitHubFeedbackClaimStatus,
  GitHubRelayDelivery,
  GitHubRelayConnectionUpdate,
  GitHubRelayEvent,
  GitConfig,
  NotificationKind,
  NotificationsConfig,
  GithubConfig,
  Issue,
  IssueAutomations,
  IssueComment,
  IssueDetail,
  IssueIdentity,
  IssueReference,
  IssueProviderDescriptor,
  IssueSummary,
  McpRemoteAuth,
  McpServerStatus,
  OffloadComputeSettings,
  Message,
  Project,
  ProjectDirectoryListing,
  PermissionMode,
  PlanDocument,
  PlanTemplateConfig,
  PrFileChange,
  PrMergeMethod,
  SessionPrStatus,
  PrSummary,
  PublishCheckpoint,
  PullRequest,
  PullRequestListItem,
  QuestionAnswer,
  ReasoningSetting,
  Repo,
  ReviewComment,
  ReviewSubmitKind,
  Session,
  SettledSessionStatus,
  Skill,
  StreamEvent,
  SubagentFleetControlOutcome,
  SubagentFleetControlRequest,
  SubagentFleetSnapshot,
  TerminalChunk,
  ThemeCatalog,
  ThemeSummary,
  VsCodeTheme,
  TerminalInfo,
  ContextConfig,
  ContextSnapshot,
  Usage,
  WorkspaceConfig,
  RuntimeDiagnosticSnapshot,
  ModelCertification,
  ProviderCatalog,
  ProviderConnection,
  ProviderConnectionId,
  ProviderLoginEvent,
  ProviderId,
  ProviderModelId,
  JinglerSubagentName,
  CodexLoginMethod,
  DetectedResourceCandidate,
  McpConfigEntry,
  McpImportCandidateView,
  McpImportSourceId,
  McpServer,
  ManagedResource,
  ManagedResourceSelector,
  ManagedResourceScope,
  ResourceDetectionResult,
  ResourceImportResult,
  WebSearchProvider,
  WebSearchSettingsStatus
} from "@jingler/core"
import {
  type AssetHover,
  AssetListRpcs,
  JinglerCoreRpcs,
  JinglerReviewRpcs,
  type SessionCreationPhase,
  type SessionCreationUpdate,
  type SessionDiffStat,
  type SessionFileDiff,
  type SessionReviewDiff
} from "@jingler/contracts"
import { RpcClient } from "@effect/rpc"
import type {
  FromClientEncoded,
  FromServerEncoded
} from "@effect/rpc/RpcMessage"
import {
  Cause,
  Effect,
  Exit,
  Fiber,
  Layer,
  ManagedRuntime,
  Runtime,
  Scope,
  Stream
} from "effect"
import { unwrapRpcFailure } from "./rpc-failure.js"

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

/**
 * Each typed RPC group owns a protocol runtime. Effect's Protocol deliberately
 * serializes `run` with a one-writer semaphore, so sharing one Protocol service
 * between clients would leave every client after the first unable to receive
 * responses. They still use the same IPC channel; request ids are process-global.
 */
const coreRuntime = ManagedRuntime.make(ClientProtocolLive)
const reviewRuntime = ManagedRuntime.make(ClientProtocolLive)
const assetListRuntime = ManagedRuntime.make(ClientProtocolLive)

/**
 * The client's background fibers must outlive any single call, so we build it
 * once inside a scope that is never closed (until the page unloads).
 */
const clientScope = Effect.runSync(Scope.make())

const clientEffect = RpcClient.make(JinglerCoreRpcs)
const scopedClientEffect = Scope.extend(clientEffect, clientScope)
const reviewClientEffect = RpcClient.make(JinglerReviewRpcs)
const scopedReviewClientEffect = Scope.extend(reviewClientEffect, clientScope)
const clientPromise = Promise.all([
  coreRuntime.runPromise(scopedClientEffect),
  reviewRuntime.runPromise(scopedReviewClientEffect)
]).then(([core, review]) => ({
  ...core,
  ...review,
  // GitHub RPCs span both groups: connection/replay operations live in the
  // core group while review and publish operations live in the review group.
  // A shallow spread would discard the core half of the namespace.
  Github: { ...core.Github, ...review.Github }
}))

const assetListClientEffect = RpcClient.make(AssetListRpcs)
const scopedAssetListClientEffect = Scope.extend(
  assetListClientEffect,
  clientScope
)
const assetListClientPromise = assetListRuntime.runPromise(
  scopedAssetListClientEffect
)

const run = <A>(
  f: (client: Awaited<typeof clientPromise>) => Effect.Effect<A, unknown>,
  signal?: AbortSignal
): Promise<A> =>
  clientPromise
    .then((client) => coreRuntime.runPromise(f(client), { signal }))
    .catch((error) => Promise.reject(unwrapRpcFailure(error)))

const runAssetList = <A>(
  f: (
    client: Awaited<typeof assetListClientPromise>
  ) => Effect.Effect<A, unknown>
): Promise<A> =>
  assetListClientPromise
    .then((client) => assetListRuntime.runPromise(f(client)))
    .catch((error) => Promise.reject(unwrapRpcFailure(error)))

const drainSessionCreation = (
  stream: Stream.Stream<SessionCreationUpdate, unknown>,
  onProgress?: (phase: SessionCreationPhase) => void
): Promise<Session> => {
  let created: Session | null = null
  return coreRuntime.runPromise(
    stream.pipe(
      Stream.runForEach((update) =>
        Effect.sync(() => {
          if (update.kind === "progress") onProgress?.(update.phase)
          else if (update.kind === "complete") created = update.session
          else throw new Error(update.message)
        })
      )
    )
  ).then(() => {
    if (created === null) throw new Error("Session creation ended before completion.")
    return created
  }).catch((error) => Promise.reject(unwrapRpcFailure(error)))
}

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
  runtimeDiagnosticsGet: (runId: string): Promise<RuntimeDiagnosticSnapshot | null> =>
    run((c) => c.RuntimeDiagnostics.get({ runId })),
  runtimeDiagnosticsLatest: (): Promise<RuntimeDiagnosticSnapshot | null> =>
    run((c) => c.RuntimeDiagnostics.latest()),
  runtimeDiagnosticsExport: (runId: string): Promise<string> =>
    run((c) => c.RuntimeDiagnostics.export({ runId })),
  providerList: (): Promise<ProviderCatalog> => run((c) => c.Provider.list()),
  providerStatus: (): Promise<ReadonlyArray<ProviderConnection>> =>
    run((c) => c.Provider.status()),
  providerLoginEvents: (
    onEvent: (event: ProviderLoginEvent) => void
  ): (() => void) => {
    let fiber: Fiber.RuntimeFiber<void, unknown> | null = null
    let cancelled = false
    void clientPromise.then((client) => {
      if (cancelled) return
      fiber = coreRuntime.runFork(
        client.Provider.loginEvents().pipe(
          Stream.runForEach((event) => Effect.sync(() => onEvent(event)))
        )
      )
    })
    return () => {
      cancelled = true
      if (fiber) coreRuntime.runFork(Fiber.interrupt(fiber))
    }
  },
  providerConnectClaudeToken: (input: {
    id: string
    token: string
    targetId: string
  }): Promise<ProviderConnection> =>
    run((c) => c.Provider.connectClaudeToken(input)),
  providerStartCodexLogin: (input: {
    id: string
    targetId: string
    method: CodexLoginMethod
  }): Promise<ProviderConnection> => run((c) => c.Provider.startCodexLogin(input)),
  providerCancelLogin: (connectionId: ProviderConnectionId): Promise<void> =>
    run((c) => c.Provider.cancelLogin({ connectionId })),
  providerSetApiKey: (input: {
    id: string
    providerId: string
    apiKey: string
    targetId: string
  }): Promise<ProviderConnection> => run((c) => c.Provider.setApiKey(input)),
  providerRefresh: (connectionId: ProviderConnectionId): Promise<ProviderConnection> =>
    run((c) => c.Provider.refresh({ connectionId })),
  providerLogout: (connectionId: ProviderConnectionId): Promise<void> =>
    run((c) => c.Provider.logout({ connectionId })),
  providerRemoveConnection: (connectionId: ProviderConnectionId): Promise<void> =>
    run((c) => c.Provider.removeConnection({ connectionId })),
  providerVerifyModel: (
    connectionId: ProviderConnectionId,
    modelId: ProviderModelId
  ): Promise<ModelCertification> =>
    run((c) => c.Provider.verifyModel({ connectionId, modelId })),
  agentResourcesList: (): Promise<ReadonlyArray<ManagedResource>> =>
    run((c) => c.AgentResources.list()),
  agentResourcesDetect: (sessionId: string | null): Promise<ResourceDetectionResult> =>
    run((c) => c.AgentResources.detect({ sessionId })),
  agentResourcesImportFiles: (
    sessionId: string | null,
    candidates: ReadonlyArray<DetectedResourceCandidate>,
    scope: ManagedResourceScope
  ): Promise<ResourceImportResult> =>
    run((c) => c.AgentResources.importFiles({
      sessionId,
      sourcePaths: candidates.map((candidate) => candidate.provenance.sourcePath),
      scope
    })),
  mcpList: (): Promise<{
    readonly servers: ReadonlyArray<McpServer>
    readonly error: string | null
  }> => run((c) => c.Mcp.list()),
  mcpStatus: (): Promise<ReadonlyArray<McpServerStatus>> =>
    run((c) => c.Mcp.status()),
  mcpWrite: (name: string, entry: McpConfigEntry): Promise<void> =>
    run((c) => c.Mcp.write({ name, entry })),
  mcpRemove: (name: string): Promise<void> =>
    run((c) => c.Mcp.remove({ name })),
  mcpSetEnabled: (name: string, enabled: boolean): Promise<void> =>
    run((c) => c.Mcp.setEnabled({ name, enabled })),
  mcpSetAuth: (name: string, auth: McpRemoteAuth): Promise<void> =>
    run((c) => c.Mcp.setAuth({ name, auth })),
  mcpSetApiKey: (name: string, apiKey: string): Promise<void> =>
    run((c) => c.Mcp.setApiKey({ name, apiKey })),
  mcpStartAuthorization: (name: string) =>
    run((c) => c.Mcp.startAuthorization({ name })),
  mcpImportCandidates: (
    source: McpImportSourceId
  ): Promise<ReadonlyArray<McpImportCandidateView>> =>
    run((c) => c.Mcp.importCandidates({ source })),
  mcpApplyImport: (
    source: McpImportSourceId,
    names: ReadonlyArray<string>
  ): Promise<ReadonlyArray<string>> =>
    run((c) => c.Mcp.applyImport({ source, names })),
  mcpReveal: (): Promise<void> => run((c) => c.Mcp.reveal()),
  agentResourcesRemove: (selector: ManagedResourceSelector): Promise<void> =>
    run((c) => c.AgentResources.remove(selector)),
  agentResourcesSetEnabled: (
    selector: ManagedResourceSelector,
    enabled: boolean
  ): Promise<void> => run((c) => c.AgentResources.setEnabled({ ...selector, enabled })),
  agentResourcesReveal: (selector: ManagedResourceSelector): Promise<void> =>
    run((c) => c.AgentResources.reveal(selector)),
  agentResourcesEnabledForTarget: (targetId: string): Promise<ReadonlyArray<ManagedResource>> =>
    run((c) => c.AgentResources.enabledForTarget({ targetId })),
  agentResourcesWatch: (
    onResources: (resources: ReadonlyArray<ManagedResource>) => void
  ): (() => void) => {
    let fiber: Fiber.RuntimeFiber<void, unknown> | null = null
    let cancelled = false
    void clientPromise.then((client) => {
      if (cancelled) return
      fiber = coreRuntime.runFork(
        client.AgentResources.watch().pipe(
          Stream.runForEach((resources) => Effect.sync(() => onResources(resources)))
        )
      )
    })
    return () => {
      cancelled = true
      if (fiber) coreRuntime.runFork(Fiber.interrupt(fiber))
    }
  },
  /** What each installed harness will actually be billed to. */
  configGet: (): Promise<WorkspaceConfig | null> => run((c) => c.Config.get()),
  chooseReposDir: (): Promise<WorkspaceConfig | null> =>
    run((c) => c.Setup.chooseReposDir()),
  workspaceRepos: (): Promise<ReadonlyArray<Repo>> =>
    run((c) => c.Workspace.repos()),
  projectsList: (environmentId?: string): Promise<ReadonlyArray<Project>> =>
    run((c) => c.Projects.list(environmentId === undefined ? {} : { environmentId })),
  projectsRegister: (input: {
    path: string
    name?: string
    environmentId?: string
  }): Promise<Project> => run((c) => c.Projects.register(input)),
  projectsBrowse: (): Promise<string | null> => run((c) => c.Projects.browse()),
  projectsBrowseCloneDestination: (repositoryName: string): Promise<string | null> =>
    run((c) => c.Projects.browseCloneDestination({ repositoryName })),
  projectsListDirectories: (path?: string): Promise<ProjectDirectoryListing> =>
    run((c) => c.Projects.listDirectories(path === undefined ? {} : { path })),
  projectsCreateDirectory: (input: {
    path: string
    name?: string
    environmentId?: string
  }): Promise<Project> => run((c) => c.Projects.createDirectory(input)),
  projectsClone: (input: {
    url: string
    destination: string
    name?: string
    environmentId?: string
  }): Promise<Project> => run((c) => c.Projects.clone(input)),
  projectsCloneFromGitHub: (input: {
    installationId: string
    repository: string
    destination: string
    name?: string
  }): Promise<Project> => run((c) => c.Projects.cloneFromGitHub(input)),
  projectsEnsureOnEnvironment: (projectId: string, environmentId: string): Promise<Project> =>
    run((c) => c.Projects.ensureOnEnvironment({ projectId, environmentId })),
  projectsRemove: (id: string, environmentId?: string): Promise<void> =>
    run((c) => c.Projects.remove({ id, ...(environmentId === undefined ? {} : { environmentId }) })),
  workspaceBranches: (repoPath: string, environmentId?: string): Promise<ReadonlyArray<string>> =>
    run((c) => c.Workspace.branches({ repoPath, ...(environmentId ? { environmentId } : {}) })),
  githubConnectionStatus: (): Promise<GitHubAppConnectionStatus> =>
    run((c) => c.GitHub.status()),
  githubRepositories: (): Promise<ReadonlyArray<GitHubCloneRepository>> =>
    run((c) => c.GitHub.repositories()),
  githubConnectionInstall: (): Promise<string> =>
    run((c) => c.GitHub.install()),
  githubConnectionRefresh: (): Promise<GitHubAppConnectionStatus> =>
    run((c) => c.GitHub.refresh()),
  githubConnectionDisconnect: (): Promise<void> =>
    run((c) => c.GitHub.disconnect()),
  environmentsList: (): Promise<ReadonlyArray<Environment>> =>
    run((c) => c.Environment.list()),
  environmentsRefresh: (): Promise<ReadonlyArray<Environment>> =>
    run((c) => c.Environment.refresh()),
  environmentsDiscovery: (deviceId: string) =>
    run((c) => c.Environment.discovery({ deviceId })),
  environmentsWatch: (
    onEnvironments: (environments: ReadonlyArray<Environment>) => void,
    onFailure: (error: unknown) => void
  ): (() => void) => {
    let fiber: Fiber.RuntimeFiber<void, unknown> | null = null
    let cancelled = false
    void clientPromise.then((client) => {
      if (cancelled) return
      fiber = coreRuntime.runFork(
        client.Environment.watch().pipe(
          Stream.runForEach((environments) =>
            Effect.sync(() => onEnvironments(environments))
          ),
          Effect.catchAll((error) => Effect.sync(() => onFailure(error)))
        )
      )
    })
    return () => {
      cancelled = true
      if (fiber) coreRuntime.runFork(Fiber.interrupt(fiber))
    }
  },
  environmentsSuggestHosts: (): Promise<ReadonlyArray<SshHost>> =>
    run((c) => c.Environment.suggestHosts()),
  environmentsPairSsh: (input: PairSshEnvironmentInput): Promise<Environment> =>
    run((c) => c.Environment.pairSsh(input)),
  environmentsRename: (deviceId: string, name: string): Promise<Environment> =>
    run((c) => c.Environment.rename({ deviceId, name })),
  environmentsRevoke: (deviceId: string): Promise<void> =>
    run((c) => c.Environment.revoke({ deviceId })),
  sessionsList: (): Promise<ReadonlyArray<Session>> =>
    run((c) => c.Sessions.list()),
  sessionsGet: (id: string): Promise<Session> =>
    run((c) => c.Sessions.get({ id })),
  sessionsCreate: (
    input: CreateSessionInput,
    onProgress?: (phase: SessionCreationPhase) => void
  ): Promise<Session> =>
    clientPromise.then((c) => drainSessionCreation(c.Sessions.createWithProgress(input), onProgress)),
  sessionsCreateFromPr: (
    input: CreateSessionFromPrInput,
    onProgress?: (phase: SessionCreationPhase) => void
  ): Promise<Session> =>
    clientPromise.then((c) => drainSessionCreation(c.Sessions.createFromPrWithProgress(input), onProgress)),
  sessionsCreateFromIssue: (
    input: CreateSessionFromIssueInput,
    onProgress?: (phase: SessionCreationPhase) => void
  ): Promise<Session> =>
    clientPromise.then((c) => drainSessionCreation(c.Sessions.createFromIssueWithProgress(input), onProgress)),
  sessionsLinkIssue: (
    sessionId: string,
    issue: IssueReference,
    automations?: IssueAutomations
  ): Promise<Session> => run((c) => c.Sessions.linkIssue({ sessionId, issue, automations })),
  sessionsAddIssues: (
    sessionId: string,
    issues: ReadonlyArray<IssueReference>
  ): Promise<Session> => run((c) => c.Sessions.addIssues({ sessionId, issues: [...issues] })),
  sessionsSelectIssue: (sessionId: string, issue: IssueIdentity): Promise<Session> =>
    run((c) => c.Sessions.selectIssue({ sessionId, issue })),
  sessionsRemoveIssue: (sessionId: string, issue: IssueIdentity): Promise<Session> =>
    run((c) => c.Sessions.removeIssue({ sessionId, issue })),
  sessionsUnlinkIssue: (sessionId: string): Promise<Session> =>
    run((c) => c.Sessions.unlinkIssue({ sessionId })),
  sessionsClearInitialPrompt: (sessionId: string): Promise<Session> =>
    run((c) => c.Sessions.clearInitialPrompt({ sessionId })),
  sessionsArchive: (
    sessionId: string,
    reason: ArchiveReason
  ): Promise<Session> => run((c) => c.Sessions.archive({ sessionId, reason })),
  sessionsRestore: (sessionId: string): Promise<Session> =>
    run((c) => c.Sessions.restore({ sessionId })),
  sessionsResolveRuntimeRecovery: (
    sessionId: string,
    runId: string,
    callId: string
  ): Promise<Session> =>
    run((c) => c.Sessions.resolveRuntimeRecovery({ sessionId, runId, callId })),
  sessionsRetitle: (sessionId: string): Promise<Session> =>
    run((c) => c.Sessions.retitle({ sessionId })),
  sessionsRename: (sessionId: string, title: string): Promise<Session> =>
    run((c) => c.Sessions.rename({ sessionId, title })),
  sessionsSetEnvironment: (sessionId: string, environmentId?: string): Promise<Session> =>
    run((c) => c.Sessions.setEnvironment({ sessionId, environmentId })),
  sessionsContinueOnEnvironment: (sessionId: string, environmentId?: string): Promise<Session> =>
    run((c) => c.Sessions.continueOnEnvironment({ sessionId, environmentId })),
  /** Re-point a drifted direct session at the branch its checkout is now on. */
  sessionsAdoptBranch: (sessionId: string): Promise<Session> =>
    run((c) => c.Sessions.adoptBranch({ sessionId })),
  /** Fork a drifted direct session's work onto a new worktree session on the live branch. */
  sessionsForkOntoBranch: (sessionId: string): Promise<Session> =>
    run((c) => c.Sessions.forkOntoBranch({ sessionId })),
  sessionsSetStatus: (
    sessionId: string,
    status: SettledSessionStatus
  ): Promise<Session> =>
    run((c) => c.Sessions.setStatus({ sessionId, status })),
  sessionsSetPersistent: (
    sessionId: string,
    persistent: boolean
  ): Promise<Session> =>
    run((c) => c.Sessions.setPersistent({ sessionId, persistent })),
  sessionsDelete: (sessionId: string): Promise<void> =>
    run((c) => c.Sessions.delete({ sessionId })),
  sessionsCreateChat: (sessionId: string): Promise<Session> =>
    run((c) => c.Sessions.createChat({ sessionId })),
  sessionsSelectChat: (sessionId: string, chatId: string): Promise<Session> =>
    run((c) => c.Sessions.selectChat({ sessionId, chatId })),
  sessionsRenameChat: (
    sessionId: string,
    chatId: string,
    title: string
  ): Promise<Session> =>
    run((c) => c.Sessions.renameChat({ sessionId, chatId, title })),
  sessionsCloseChat: (sessionId: string, chatId: string): Promise<Session> =>
    run((c) => c.Sessions.closeChat({ sessionId, chatId })),
  sessionsReopenChat: (sessionId: string, chatId: string): Promise<Session> =>
    run((c) => c.Sessions.reopenChat({ sessionId, chatId })),
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
  sessionsAttachment: (
    chatId: string,
    attachmentId: string
  ): Promise<string | null> =>
    run((c) => c.Sessions.attachment({ chatId, attachmentId })),
  sessionsDiff: (id: string): Promise<SessionReviewDiff> =>
    run((c) => c.Sessions.diff({ id })),
  sessionsDiffStat: (id: string): Promise<SessionDiffStat> =>
    run((c) => c.Sessions.diffStat({ id })),
  sessionsFileDiff: (id: string, path: string): Promise<SessionFileDiff> =>
    run((c) => c.Sessions.fileDiff({ id, path })),
  workspaceFiles: (
    repoPath: string,
    environmentId?: string,
    sessionId?: string
  ): Promise<ReadonlyArray<string>> =>
    run((c) => c.Workspace.files({
      repoPath,
      ...(environmentId ? { environmentId } : {}),
      ...(sessionId ? { sessionId } : {})
    })),
  /** Validated repository browser entries for one session worktree. */
  assetList: (sessionId: string): Promise<ReadonlyArray<AssetFileEntry>> =>
    runAssetList((c) => c.Asset.list({ sessionId })),
  /**
   * Read one asset out of a session's worktree. `path` is worktree-relative and
   * is re-validated in main — the renderer never gets to say where on disk a
   * read lands.
   */
  assetHover: (
    sessionId: string,
    path: string,
    symbol: string,
    line: number,
    column: number,
    text?: string,
    signal?: AbortSignal
  ): Promise<AssetHover | null> =>
    run((c) => c.Asset.hover({
      sessionId,
      path,
      symbol,
      line,
      column,
      ...(text === undefined ? {} : { text })
    }), signal),
  assetRead: (sessionId: string, path: string): Promise<AssetPayload> =>
    run((c) => c.Asset.read({ sessionId, path })),
  /** Save one existing text asset only if its loaded revision is still current. */
  assetWrite: (
    sessionId: string,
    path: string,
    text: string,
    expectedRevision: string
  ): Promise<AssetWriteResult> =>
    run((c) => c.Asset.write({ sessionId, path, text, expectedRevision })),
  assetReveal: (sessionId: string, path: string): Promise<void> =>
    run((c) => c.Asset.reveal({ sessionId, path })),
  /** Park Chromium's PDF viewer over `bounds`. Main resolves the path itself. */
  assetOpenPdf: (
    sessionId: string,
    path: string,
    bounds: { x: number; y: number; width: number; height: number }
  ): Promise<void> => run((c) => c.Asset.openPdf({ sessionId, path, bounds })),
  assetSetPdfBounds: (
    sessionId: string,
    bounds: { x: number; y: number; width: number; height: number }
  ): Promise<void> => run((c) => c.Asset.setPdfBounds({ sessionId, bounds })),
  assetHidePdf: (sessionId: string): Promise<void> =>
    run((c) => c.Asset.hidePdf({ sessionId })),
  workspaceRevertFile: (sessionId: string, path: string): Promise<void> =>
    run((c) => c.Workspace.revertFile({ sessionId, path })),
  workspaceRevertLines: (
    sessionId: string,
    path: string,
    startLine: number,
    endLine: number
  ): Promise<void> =>
    run((c) =>
      c.Workspace.revertLines({ sessionId, path, startLine, endLine })
    ),
  skillsList: (sessionId: string): Promise<ReadonlyArray<Skill>> =>
    run((c) => c.Skills.list({ sessionId })),
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
  sessionsSetAutoCompact: (
    id: string,
    autoCompact: boolean | null
  ): Promise<Session> =>
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
    run((c) =>
      c.Agent.answerQuestion({ sessionId, chatId, requestId, answers })
    ),
  agentSetMode: (
    sessionId: string,
    chatId: string,
    mode: PermissionMode
  ): Promise<void> => run((c) => c.Agent.setMode({ sessionId, chatId, mode })),
  agentSetReasoning: (
    sessionId: string,
    chatId: string,
    reasoning: ReasoningSetting | undefined
  ): Promise<void> =>
    run((c) => c.Agent.setReasoning({
      sessionId,
      chatId,
      ...(reasoning === undefined ? {} : { reasoning })
    })),
  agentSetModel: (
    sessionId: string,
    chatId: string,
    connectionId: ProviderConnectionId,
    providerId: ProviderId,
    modelId: ProviderModelId
  ): Promise<Session> =>
    run((c) => c.Agent.setModel({ sessionId, chatId, connectionId, providerId, modelId })),
  agentStop: (sessionId: string, chatId: string): Promise<void> =>
    run((c) => c.Agent.stop({ sessionId, chatId })),
  agentChatBusy: (sessionId: string, chatId: string): Promise<boolean> =>
    run((c) => c.Agent.chatBusy({ sessionId, chatId })),
  agentPlannotatorRecoveryNeeded: (sessionId: string, chatId: string): Promise<boolean> =>
    run((c) => c.Agent.plannotatorRecoveryNeeded({ sessionId, chatId })),
  agentStopSubagent: (
    sessionId: string,
    chatId: string,
    agentId: string
  ): Promise<void> =>
    run((c) => c.Agent.stopSubagent({ sessionId, chatId, agentId })),
  agentSubagentFleetSnapshot: (
    sessionId: string,
    chatId: string,
    parentPiSessionId: string
  ): Promise<SubagentFleetSnapshot> =>
    run((c) => c.Agent.subagentFleetSnapshot({ sessionId, chatId, parentPiSessionId })),
  agentSubagentTranscript: (
    sessionId: string,
    chatId: string,
    parentPiSessionId: string,
    runId: string
  ): Promise<ReadonlyArray<Message>> =>
    run((c) => c.Agent.subagentTranscript({
      sessionId,
      chatId,
      parentPiSessionId,
      runId
    })),
  agentControlSubagent: (
    sessionId: string,
    chatId: string,
    request: SubagentFleetControlRequest
  ): Promise<SubagentFleetControlOutcome> =>
    run((c) => c.Agent.controlSubagent({ sessionId, chatId, request })),
  agentMessagePeer: (
    sessionId: string,
    fromChatId: string,
    toChatId: string,
    text: string
  ) => run((c) => c.Agent.messagePeer({ sessionId, fromChatId, toChatId, text })),
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
  configSetNotifications: (
    notifications: NotificationsConfig
  ): Promise<WorkspaceConfig> =>
    run((c) => c.Config.setNotifications(notifications)),
  /** Turn plan mode's unattended (read-only) command execution on or off. */
  configSetDefaultMode: (defaultMode: ExecutionMode): Promise<WorkspaceConfig> =>
    run((c) => c.Config.setDefaultMode({ defaultMode })),
  configSetSubagentModel: (
    agent: JinglerSubagentName,
    modelId: ProviderModelId | null
  ): Promise<WorkspaceConfig> =>
    run((c) => c.Config.setSubagentModel({ agent, modelId })),
  configSetPlanAutoRun: (planAutoRun: boolean): Promise<WorkspaceConfig> =>
    run((c) => c.Config.setPlanAutoRun({ planAutoRun })),
  /** Persist ADHD mode; resolves with the whole updated config. */
  configSetAdhdMode: (adhdMode: boolean): Promise<WorkspaceConfig> =>
    run((c) => c.Config.setAdhdMode({ adhdMode })),
  /** Persist automatic compute routing and shell-free command allowlists. */
  configSetOffloadCompute: (
    offloadCompute: OffloadComputeSettings
  ): Promise<WorkspaceConfig> =>
    run((c) => c.Config.setOffloadCompute(offloadCompute)),
  /** Persist the conversation + code text-size multiplier. */
  configSetFontScale: (fontScale: number): Promise<WorkspaceConfig> =>
    run((c) => c.Config.setFontScale({ fontScale })),
  /** Persist a certified connection/model identity atomically. */
  configSetDefaultProviderModel: (
    connectionId: ProviderConnectionId,
    providerId: ProviderId,
    modelId: ProviderModelId
  ): Promise<WorkspaceConfig> =>
    run((c) => c.Config.setDefaultProviderModel({ connectionId, providerId, modelId })),
  configCompleteProviderSetup: (): Promise<WorkspaceConfig> =>
    run((c) => c.Config.completeProviderSetup()),
  configSetWebSearch: (webSearch: import("@jingler/core").WebSearchConfig) =>
    run((c) => c.Config.setWebSearch(webSearch)),
  webSearchGet: (): Promise<WebSearchSettingsStatus> =>
    run((c) => c.WebSearch.get()),
  webSearchSetCredential: (
    provider: WebSearchProvider,
    apiKey: string
  ): Promise<WebSearchSettingsStatus> =>
    run((c) => c.WebSearch.setCredential({ provider, apiKey })),
  webSearchClearCredential: (
    provider: WebSearchProvider
  ): Promise<WebSearchSettingsStatus> =>
    run((c) => c.WebSearch.clearCredential({ provider })),
  webSearchSkip: (): Promise<WebSearchSettingsStatus> =>
    run((c) => c.WebSearch.skip()),
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
  configSetStarredRepos: (
    paths: ReadonlyArray<string>
  ): Promise<WorkspaceConfig> =>
    run((c) => c.Config.setStarredRepos({ paths })),
  configSetCollapsedRepos: (
    paths: ReadonlyArray<string>
  ): Promise<WorkspaceConfig> =>
    run((c) => c.Config.setCollapsedRepos({ paths })),
  configSetLastRepoPath: (path: string): Promise<WorkspaceConfig> =>
    run((c) => c.Config.setLastRepoPath({ path })),
  configSetPlanTemplate: (
    template: PlanTemplateConfig
  ): Promise<WorkspaceConfig> =>
    run((c) => c.Config.setPlanTemplate({ template })),
  githubPr: (sessionId: string): Promise<PullRequest | null> =>
    run((c) => c.Github.pr({ sessionId })),
  githubPrState: (sessionId: string): Promise<SessionPrStatus | null> =>
    run((c) => c.Github.prState({ sessionId })),
  githubPrInbox: (): Promise<ReadonlyArray<PullRequestListItem>> =>
    run((c) => c.Github.inbox()),
  githubPrBySlug: (repository: string, number: number): Promise<PullRequest | null> =>
    run((c) => c.Github.prBySlug({ repository, number })),
  githubListPrs: (
    repoPath: string,
    opts: { mine: boolean; search: string; githubSlug?: string }
  ): Promise<ReadonlyArray<PrSummary>> =>
    run((c) =>
      c.Github.listPrs({ repoPath, ...(opts.githubSlug ? { githubSlug: opts.githubSlug } : {}), mine: opts.mine, search: opts.search })
    ),
  githubListIssues: (
    repoPath: string,
    opts: { mine: boolean; search: string; githubSlug?: string }
  ): Promise<ReadonlyArray<IssueSummary>> =>
    run((c) =>
      c.Github.listIssues({ repoPath, ...(opts.githubSlug ? { githubSlug: opts.githubSlug } : {}), mine: opts.mine, search: opts.search })
    ),
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
  githubEvents: (
    onDelivery: (delivery: GitHubRelayDelivery) => void,
    onStatus?: (status: GitHubRelayConnectionUpdate) => void
  ): (() => void) => {
    let fiber: Fiber.RuntimeFiber<void, unknown> | null = null
    let cancelled = false
    void clientPromise.then((client) => {
      if (cancelled) return
      fiber = coreRuntime.runFork(
        client.Github.events().pipe(
          Stream.runForEach((message) =>
            Effect.sync(() => {
              if ("event" in message) onDelivery(message)
              else onStatus?.(message)
            })
          )
        )
      )
    })
    return () => {
      cancelled = true
      if (fiber) coreRuntime.runFork(Fiber.interrupt(fiber))
    }
  },
  githubClaimFeedback: (input: {
    operation: "claim" | "mark-dispatched"
    sessionId: string
    installationId: string
    repositoryId: string
    prNumber: number
    deliveryId: string
    semanticKey: string
    event: GitHubRelayEvent
  }): Promise<GitHubFeedbackClaimStatus> =>
    run((client) => client.Github.claimFeedback(input)),
  githubAckEvent: (
    clientId: string,
    cursor: number,
    outcome?: "routed" | "retry"
  ): Promise<void> =>
    run((client) => client.Github.ackEvent({ clientId, cursor, outcome })),
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
  githubPublish: (
    sessionId: string,
    onCheckpoint: (checkpoint: PublishCheckpoint) => void
  ): (() => void) => {
    let fiber: Fiber.RuntimeFiber<void, unknown> | null = null
    let cancelled = false
    void clientPromise.then((client) => {
      if (cancelled) return
      fiber = coreRuntime.runFork(
        client.Github.createPr({ sessionId }).pipe(
          Stream.runForEach((checkpoint) =>
            Effect.sync(() => onCheckpoint(checkpoint))
          )
        )
      )
    })
    return () => {
      cancelled = true
      if (fiber) coreRuntime.runFork(Fiber.interrupt(fiber))
    }
  },
  githubComment: (
    sessionId: string,
    body: string,
    toGithub: boolean
  ): Promise<void> =>
    run((c) => c.Github.comment({ sessionId, body, toGithub })),
  githubCommentBySlug: (
    repository: string,
    number: number,
    body: string
  ): Promise<void> =>
    run((c) => c.Github.commentBySlug({ repository, number, body })),
  githubCloseBySlug: (repository: string, number: number): Promise<void> =>
    run((c) => c.Github.closeBySlug({ repository, number })),
  githubMergeBySlug: (
    repository: string,
    number: number,
    method: PrMergeMethod
  ): Promise<void> =>
    run((c) => c.Github.mergeBySlug({ repository, number, method })),
  githubReview: (
    sessionId: string,
    kind: ReviewSubmitKind,
    body: string
  ): Promise<void> => run((c) => c.Github.review({ sessionId, kind, body })),
  /**
   * Post the reviewer's drafts to the PR as line-anchored inline comments.
   * Resolves to the number that couldn't be anchored (folded into the review
   * body instead) — 0 when everything landed on a line.
   */
  githubSubmitReview: (
    sessionId: string,
    comments: ReadonlyArray<ReviewComment>
  ): Promise<number> =>
    run((c) => c.Github.submitReview({ sessionId, comments })),
  githubResolveThread: (
    sessionId: string,
    threadId: string,
    resolved: boolean
  ): Promise<void> =>
    run((c) => c.Github.resolveThread({ sessionId, threadId, resolved })),
  githubReplyToThread: (
    sessionId: string,
    commentId: number,
    body: string
  ): Promise<void> =>
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
      readonly displayText?: string
      readonly reasoning?: ReasoningSetting | null
      readonly externalInstruction?: ExternalInstructionIdentity
    } = {}
  ): (() => void) => {
    let fiber: Fiber.RuntimeFiber<void, unknown> | null = null
    let cancelled = false
    void clientPromise.then((client) => {
      if (cancelled) return
      fiber = coreRuntime.runFork(
        drainRun(
          client.Agent.run({ sessionId, chatId, text, images, ...options }),
          onEvent
        )
      )
    })
    return () => {
      cancelled = true
      if (fiber) coreRuntime.runFork(Fiber.interrupt(fiber))
    }
  },
  // ── Terminal ─────────────────────────────────────────────────────────────
  /** Spawn a PTY for a session (cwd defaults to its worktree) and return it. */
  terminalCreate: (
    sessionId: string,
    cwd: string | undefined,
    cols: number,
    rows: number
  ): Promise<TerminalInfo> =>
    run((c) => c.Terminal.create({ sessionId, cwd, cols, rows })),
  /** Send keystrokes / pasted text to a terminal (fire-and-forget). */
  terminalWrite: (terminalId: string, data: string): Promise<void> =>
    run((c) => c.Terminal.write({ terminalId, data })),
  /** Resize a terminal's PTY (drives SIGWINCH). */
  terminalResize: (
    terminalId: string,
    cols: number,
    rows: number
  ): Promise<void> => run((c) => c.Terminal.resize({ terminalId, cols, rows })),
  /** Kill a terminal's shell and drop it. */
  terminalKill: (terminalId: string): Promise<void> =>
    run((c) => c.Terminal.kill({ terminalId })),
  /** List a session's live terminals (rebuild the tab strip on mount). */
  terminalList: (sessionId: string): Promise<ReadonlyArray<TerminalInfo>> =>
    run((c) => c.Terminal.list({ sessionId })),

  // ── Background tasks ───────────────────────────────────────────────────────
  /** A session's background tasks — running and recently settled. */
  backgroundTasksList: (
    sessionId: string
  ): Promise<ReadonlyArray<BackgroundTask>> =>
    run((c) => c.BackgroundTasks.list({ sessionId })),
  /** Ask the harness to stop one task; resolves with its new (usually `stopping`) state. */
  backgroundTasksStop: (
    sessionId: string,
    taskId: string
  ): Promise<BackgroundTask | null> =>
    run((c) => c.BackgroundTasks.stop({ sessionId, taskId })),
  /** Drop a settled task's row (the escape hatch for a failed one). Idempotent. */
  backgroundTasksDismiss: (sessionId: string, taskId: string): Promise<void> =>
    run((c) => c.BackgroundTasks.dismiss({ sessionId, taskId })),
  /** A settled task's transcript ("" while it is still running). */
  backgroundTasksOutput: (sessionId: string, taskId: string): Promise<string> =>
    run((c) => c.BackgroundTasks.output({ sessionId, taskId })),

  // ── Browser preview ────────────────────────────────────────────────────────
  /** Show the preview view and load `url` at `bounds` (rejects non-http(s)). */
  browserPreviewOpen: (
    sessionId: string,
    chatId: string,
    url: string,
    bounds: BrowserBounds
  ): Promise<void> =>
    run((c) => c.BrowserPreview.open({ sessionId, chatId, url, bounds })),
  /** Keep the native view aligned with the pane's on-screen rect. */
  browserPreviewSetBounds: (
    sessionId: string,
    chatId: string,
    bounds: BrowserBounds
  ): Promise<void> =>
    run((c) => c.BrowserPreview.setBounds({ sessionId, chatId, bounds })),
  /** Navigate the open preview to a new URL (rejects non-http(s)). */
  browserPreviewNavigate: (sessionId: string, chatId: string, url: string): Promise<void> =>
    run((c) => c.BrowserPreview.navigate({ sessionId, chatId, url })),
  /** Reload the current preview page. */
  browserPreviewReload: (sessionId: string, chatId: string): Promise<void> =>
    run((c) => c.BrowserPreview.reload({ sessionId, chatId })),
  /** Hide the native view for a tab switch, keeping its page and history alive. */
  browserPreviewSetVisible: (
    sessionId: string,
    chatId: string,
    visible: boolean
  ): Promise<void> =>
    run((c) => c.BrowserPreview.setVisible({ sessionId, chatId, visible })),
  /** Destroy one chat's native browser view after its tab is explicitly closed. */
  browserPreviewClose: (sessionId: string, chatId: string): Promise<void> =>
    run((c) => c.BrowserPreview.close({ sessionId, chatId })),
  /**
   * Deliver the operator's verdict on a pending Plannotator review. The live
   * session's forked extension resolves the awaited review when the reviewId
   * matches; stale or duplicate decisions are ignored there.
   */
  planDecide: (
    sessionId: string,
    chatId: string,
    reviewId: string,
    approved: boolean,
    feedback?: string
  ): Promise<void> =>
    run((c) => c.Plan.decide({ sessionId, chatId, reviewId, approved, feedback })),
  // ── Auth ─────────────────────────────────────────────────────────────────
  /** The current authenticated session, or null when signed out. */
  authGetSession: (): Promise<AuthSession | null> =>
    run((c) => c.Auth.getSession()),
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
  explanationCurrent: (sessionId: string): Promise<ExplanationDocument | null> =>
    run((c) => c.Explanation.current({ sessionId })),
  explanationWatch: (
    sessionId: string,
    onDocument: (document: ExplanationDocument | null) => void
  ): (() => void) => {
    let fiber: Fiber.RuntimeFiber<void, unknown> | null = null
    let cancelled = false
    void clientPromise.then((client) => {
      if (cancelled) return
      fiber = coreRuntime.runFork(
        client.Explanation.watch({ sessionId }).pipe(
          Stream.runForEach((document) => Effect.sync(() => onDocument(document)))
        )
      )
    })
    return () => {
      cancelled = true
      if (fiber) coreRuntime.runFork(Fiber.interrupt(fiber))
    }
  },
  planCurrent: async (..._args: ReadonlyArray<unknown>): Promise<PlanDocument | null> => null,
  planStartDraft: async (..._args: ReadonlyArray<unknown>): Promise<PlanDocument> => {
    throw new Error("Plannotator owns plan drafts")
  },
  planDispatchMessage: async (..._args: ReadonlyArray<unknown>): Promise<never> => {
    throw new Error("Plannotator owns plan feedback")
  },
  planWatch: (_sessionId: string, _chatId: string, onDocument: (document: PlanDocument | null) => void): (() => void) => {
    onDocument(null)
    return () => {}
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
      fiber = coreRuntime.runFork(
        client.Review.watch({ sessionId, chatId }).pipe(
          Stream.runForEach((event) => Effect.sync(() => onEvent(event)))
        )
      )
    })
    return () => {
      cancelled = true
      if (fiber) coreRuntime.runFork(Fiber.interrupt(fiber))
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
      fiber = coreRuntime.runFork(
        client.Terminal.attach({ terminalId }).pipe(
          Stream.runForEach((chunk) => Effect.sync(() => onChunk(chunk)))
        )
      )
    })
    return () => {
      cancelled = true
      if (fiber) coreRuntime.runFork(Fiber.interrupt(fiber))
    }
  },

  // ── Themes ─────────────────────────────────────────────────────────────────

  /** Bundled presets plus `~/jingler/themes`, each with resolved tokens. */
  themeList: (): Promise<ThemeCatalog> => run((c) => c.Theme.list()),

  /** The raw VS Code JSON for a theme — what the editor loads. */
  themeGet: (id: string): Promise<VsCodeTheme | null> =>
    run((c) => c.Theme.get({ id })),

  themeSave: (id: string, theme: VsCodeTheme): Promise<ThemeSummary> =>
    run((c) => c.Theme.save({ id, theme })),

  themeDelete: (id: string): Promise<void> =>
    run((c) => c.Theme.delete({ id })),

  /** Copy a theme to an editable user theme — the only way to edit a built-in. */
  themeDuplicate: (id: string, name?: string): Promise<ThemeSummary> =>
    run((c) => c.Theme.duplicate({ id, name })),

  themeImport: (json: string, name?: string): Promise<ThemeSummary> =>
    run((c) => c.Theme.import({ json, name })),

  themeSetActive: (id: string): Promise<WorkspaceConfig> =>
    run((c) => c.Theme.setActive({ id })),

  /** Reveal a user theme's file in Finder/Explorer. Ignored for other paths. */
  themeReveal: (path: string): Promise<void> =>
    run((c) => c.Theme.reveal({ path })),

  themeSetCustomizations: (
    colors: Record<string, string>
  ): Promise<WorkspaceConfig> =>
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
      fiber = coreRuntime.runFork(
        client.Theme.watch().pipe(
          Stream.runForEach((catalog) => Effect.sync(() => onCatalog(catalog)))
        )
      )
    })
    return () => {
      cancelled = true
      if (fiber) coreRuntime.runFork(Fiber.interrupt(fiber))
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

  pluginsStorageSet: (
    pluginId: string,
    key: string,
    value: unknown
  ): Promise<void> =>
    run((c) => c.Plugins.storageSet({ pluginId, key, value })),

  pluginsStorageDelete: (pluginId: string, key: string): Promise<void> =>
    run((c) => c.Plugins.storageDelete({ pluginId, key })),

  pluginsStorageKeys: (pluginId: string): Promise<ReadonlyArray<string>> =>
    run((c) => c.Plugins.storageKeys({ pluginId })),

  pluginsSettingsGet: (pluginId: string): Promise<PluginSettingsSnapshot> =>
    run((c) => c.Plugins.settingsGet({ pluginId })),

  pluginsSettingSet: (
    pluginId: string,
    settingId: string,
    value: PluginSettingValue
  ): Promise<void> => run((c) => c.Plugins.settingSet({ pluginId, settingId, value })),

  pluginsSecretSet: (
    pluginId: string,
    settingId: string,
    value: string
  ): Promise<void> => run((c) => c.Plugins.secretSet({ pluginId, settingId, value })),

  pluginsSecretClear: (pluginId: string, settingId: string): Promise<void> =>
    run((c) => c.Plugins.secretClear({ pluginId, settingId })),

  pluginsIssueProviders: (): Promise<ReadonlyArray<IssueProviderDescriptor>> =>
    run((c) => c.Plugins.issueProviders()),

  pluginsIssueProviderList: (input: {
    providerId: string
    repository: { name: string; path: string }
    search: string
    mine: boolean
  }): Promise<ReadonlyArray<IssueSummary>> =>
    run((c) => c.Plugins.issueProviderList(input)),

  pluginsIssueProviderGet: (input: {
    providerId: string
    repository: { name: string; path: string }
    issueId: string
  }): Promise<IssueDetail | null> => run((c) => c.Plugins.issueProviderGet(input)),

  pluginsIssueProviderCreate: (input: {
    providerId: string
    repository: { name: string; path: string }
    title: string
    body: string
  }): Promise<IssueDetail> => run((c) => c.Plugins.issueProviderCreate(input)),

  pluginsIssueProviderAddComment: (input: {
    providerId: string
    repository: { name: string; path: string }
    issueId: string
    body: string
  }): Promise<IssueComment> => run((c) => c.Plugins.issueProviderAddComment(input)),

  pluginsInvoke: (
    pluginId: string,
    commandId: string,
    arg?: unknown
  ): Promise<unknown> =>
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
      fiber = coreRuntime.runFork(
        client.Plugins.watch().pipe(
          Stream.runForEach((catalog) => Effect.sync(() => onCatalog(catalog)))
        )
      )
    })
    return () => {
      cancelled = true
      if (fiber) coreRuntime.runFork(Fiber.interrupt(fiber))
    }
  }
}
