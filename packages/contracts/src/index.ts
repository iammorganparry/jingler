import {
  AdversarialReview,
  ArchiveReason,
  AssetFileEntry,
  AssetPayload,
  AssetWriteResult,
  Attachment,
  AuthProvider,
  AuthSession,
  BrowserBounds,
  CreateSessionFromIssueInput,
  CreateSessionFromPrInput,
  CreateSessionInput,
  GateDecision,
  GitHubAppConnectionStatus,
  GitHubCloneRepository,
  GitHubFeedbackClaimStatus,
  GitHubRelayStreamMessage,
  GitHubRelayEvent,
  GitConfig,
  GithubConfig,
  NotificationKind,
  NotificationsConfig,
  Issue,
  IssueAutomations,
  IssueComment,
  IssueDetail,
  IssueIdentity,
  IssueReference,
  IssueProviderDescriptor,
  IssueSummary,
  ContextConfig,
  ContextSnapshot,
  Message,
  AuthSessionInfo,
  AuthSessionRequest,
  LoadedPlugin,
  PluginCatalog,
  PluginEvent,
  PluginId,
  ContributionId,
  PluginSettingValue,
  PluginSettingsSnapshot,
  ExecutionMode,
  Environment,
  ExplanationDocument,
  EnvironmentDiscovery,
  PairSshEnvironmentInput,
  SshHost,
  ExternalInstructionIdentity,
  PermissionMode,
  PlanTemplateConfig,
  PrFileChange,
  McpConfigEntry,
  McpRemoteAuth,
  McpImportCandidateView,
  McpImportSourceId,
  McpServer,
  McpServerStatus,
  SetMcpApiKeyInput,
  McpAuthorizationStart,
  OffloadComputeSettings,
  PrMergeMethod,
  BackgroundTask,
  SessionPrStatus,
  PrSummary,
  Project,
  ProjectDirectoryListing,
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
  TerminalInfo,
  ThemeCatalog,
  ThemeSummary,
  Usage,
  VsCodeTheme,
  WorkspaceConfig,
  WebSearchConfig,
  WebSearchError,
  WebSearchSettingsStatus,
  SetWebSearchCredentialInput,
  ClearWebSearchCredentialInput,
  RuntimeDiagnosticSnapshot,
  RuntimeRecoveryError,
  ModelCertification,
  ProviderCatalog,
  ProviderConnection,
  ProviderConnectionError,
  ProviderLoginEvent,
  ConnectClaudeTokenInput,
  StartCodexLoginInput,
  ProviderConnectionInput,
  ProviderModelId,
  JinglerSubagentName,
  SetProviderApiKeyInput,
  SetDefaultProviderModelInput,
  SetSessionProviderModelInput,
  VerifyProviderModelInput,
  AgentResourceRpcError,
  PeerAgentMessageResult,
  ManagedResource,
  ManagedResourceSelector,
  ManagedResourceScope,
  ResourceDetectionResult,
  ResourceImportResult,
  FONT_SCALE_RANGE
} from "@jingler/core"
import {
  AssetOutsideWorktreeError,
  AssetBinaryError,
  AssetTooLargeError,
  AssetUnsupportedError,
  AssetWriteConflictError,
  AssetWriteIoError,
  AuthError,
  BrowserControlError,
  BrowserPreviewError,
  ConfigError,
  EnvironmentError,
  EnvironmentHandoffError,
  GitHubApiError,
  GitError,
  PluginError,
  ReviewError,
  SessionNotFoundError,
  TerminalError,
  ThemeError,
  WorkspaceNotConfiguredError
} from "@jingler/core"
import { Rpc, RpcGroup } from "@effect/rpc"
import { Schema } from "effect"

export const SessionCreationPhase = Schema.Literal(
  "checking-access",
  "resolving-repository",
  "starting-sandbox",
  "creating-session",
  "ready"
)
export type SessionCreationPhase = Schema.Schema.Type<typeof SessionCreationPhase>

export const SessionCreationUpdate = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("progress"), phase: SessionCreationPhase }),
  Schema.Struct({ kind: Schema.Literal("complete"), session: Session }),
  Schema.Struct({ kind: Schema.Literal("failed"), message: Schema.String })
)
export type SessionCreationUpdate = Schema.Schema.Type<typeof SessionCreationUpdate>

export const SessionDiffStat = Schema.Struct({
  added: Schema.Number,
  removed: Schema.Number,
  files: Schema.Number
})
export type SessionDiffStat = Schema.Schema.Type<typeof SessionDiffStat>

export const SessionFileDiff = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("patch"), patch: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("too-large"),
    added: Schema.Number,
    removed: Schema.Number,
    reason: Schema.Literal("lines", "bytes"),
    lineLimit: Schema.Number,
    byteLimit: Schema.Number
  })
)
export type SessionFileDiff = Schema.Schema.Type<typeof SessionFileDiff>

/** One changed file in the Code Review pane's worktree diff. */
export const SessionReviewFile = Schema.Struct({
  path: Schema.String,
  added: Schema.Number,
  removed: Schema.Number,
  /** Why the file's patch is absent from `patch`; null when it is included. */
  omitted: Schema.NullOr(Schema.Literal("lines", "bytes"))
})
export type SessionReviewFile = Schema.Schema.Type<typeof SessionReviewFile>

/**
 * Every changed file with counts, plus a patch that carries ONLY the files
 * within the per-file and whole-review limits. Oversized files are listed,
 * never transported.
 */
export const SessionReviewDiff = Schema.Struct({
  files: Schema.Array(SessionReviewFile),
  patch: Schema.String,
  lineLimit: Schema.Number,
  byteLimit: Schema.Number
})
export type SessionReviewDiff = Schema.Schema.Type<typeof SessionReviewDiff>

/**
 * Kept as a small group so the renderer can construct this client separately
 * from the long-lived core client. Mapping the entire application RPC union to
 * one nested client type exceeds TypeScript's instantiation depth; the server
 * merges both groups back into the single IPC surface below.
 */
export class AssetListRpcs extends RpcGroup.make(
  Rpc.make("Asset.list", {
    success: Schema.Array(AssetFileEntry),
    error: Schema.Union(
      AssetOutsideWorktreeError,
      GitError,
      SessionNotFoundError
    ),
    payload: { sessionId: Schema.String }
  })
) {}

/**
 * The Jingler RPC surface — a single source of truth shared by the Electron
 * main process (which implements the handlers as Effect services) and the
 * renderer (which calls them through a typed `RpcClient`). Transport is Electron
 * IPC; serialization is JSON. See `apps/desktop/src/main/rpc` for the wiring.
 */
export class JinglerCoreRpcs extends RpcGroup.make(
  Rpc.make("RuntimeDiagnostics.get", {
    success: Schema.NullOr(RuntimeDiagnosticSnapshot),
    payload: { runId: Schema.String }
  }),

  Rpc.make("RuntimeDiagnostics.latest", {
    success: Schema.NullOr(RuntimeDiagnosticSnapshot)
  }),

  Rpc.make("RuntimeDiagnostics.export", {
    success: Schema.String,
    payload: { runId: Schema.String }
  }),

  Rpc.make("Provider.list", {
    success: ProviderCatalog,
    error: ProviderConnectionError
  }),

  Rpc.make("Provider.status", {
    success: Schema.Array(ProviderConnection),
    error: ProviderConnectionError
  }),

  Rpc.make("Provider.loginEvents", {
    success: ProviderLoginEvent,
    stream: true
  }),

  Rpc.make("Provider.connectClaudeToken", {
    success: ProviderConnection,
    error: ProviderConnectionError,
    payload: ConnectClaudeTokenInput
  }),

  Rpc.make("Provider.startCodexLogin", {
    success: ProviderConnection,
    error: ProviderConnectionError,
    payload: StartCodexLoginInput
  }),

  Rpc.make("Provider.cancelLogin", {
    success: Schema.Void,
    error: ProviderConnectionError,
    payload: ProviderConnectionInput
  }),

  Rpc.make("Provider.setApiKey", {
    success: ProviderConnection,
    error: ProviderConnectionError,
    payload: SetProviderApiKeyInput
  }),

  Rpc.make("Provider.refresh", {
    success: ProviderConnection,
    error: ProviderConnectionError,
    payload: ProviderConnectionInput
  }),

  Rpc.make("Provider.logout", {
    success: Schema.Void,
    error: ProviderConnectionError,
    payload: ProviderConnectionInput
  }),

  /** Irreversibly removes a connection and its credential from every store. */
  Rpc.make("Provider.removeConnection", {
    success: Schema.Void,
    error: ProviderConnectionError,
    payload: ProviderConnectionInput
  }),

  Rpc.make("Provider.verifyModel", {
    success: ModelCertification,
    error: ProviderConnectionError,
    payload: VerifyProviderModelInput
  }),

  Rpc.make("AgentResources.list", {
    success: Schema.Array(ManagedResource),
    error: AgentResourceRpcError
  }),

  Rpc.make("AgentResources.detect", {
    success: ResourceDetectionResult,
    error: AgentResourceRpcError,
    payload: { sessionId: Schema.NullOr(Schema.String) }
  }),

  Rpc.make("AgentResources.importFiles", {
    success: ResourceImportResult,
    error: AgentResourceRpcError,
    payload: {
      sessionId: Schema.NullOr(Schema.String),
      sourcePaths: Schema.Array(Schema.String),
      scope: ManagedResourceScope
    }
  }),

  Rpc.make("AgentResources.remove", {
    error: AgentResourceRpcError,
    payload: ManagedResourceSelector
  }),

  Rpc.make("AgentResources.setEnabled", {
    error: AgentResourceRpcError,
    payload: {
      ...ManagedResourceSelector.fields,
      enabled: Schema.Boolean
    }
  }),

  Rpc.make("AgentResources.reveal", {
    error: AgentResourceRpcError,
    payload: ManagedResourceSelector
  }),

  Rpc.make("AgentResources.enabledForTarget", {
    success: Schema.Array(ManagedResource),
    error: AgentResourceRpcError,
    payload: { targetId: Schema.String }
  }),

  Rpc.make("AgentResources.watch", {
    success: Schema.Array(ManagedResource),
    stream: true
  }),

  Rpc.make("Environment.list", {
    success: Schema.Array(Environment),
    error: EnvironmentError
  }),

  Rpc.make("Environment.refresh", {
    success: Schema.Array(Environment),
    error: EnvironmentError
  }),

  /** Safe, versioned runtime catalogue announced by one paired device. */
  Rpc.make("Environment.discovery", {
    success: EnvironmentDiscovery,
    error: EnvironmentError,
    payload: { deviceId: Schema.String }
  }),

  Rpc.make("Environment.watch", {
    success: Schema.Array(Environment),
    error: EnvironmentError,
    stream: true
  }),

  Rpc.make("Environment.suggestHosts", {
    success: Schema.Array(SshHost)
  }),

  Rpc.make("Environment.pairSsh", {
    success: Environment,
    error: EnvironmentError,
    payload: PairSshEnvironmentInput
  }),

  Rpc.make("Environment.rename", {
    success: Environment,
    error: EnvironmentError,
    payload: { deviceId: Schema.String, name: Schema.String }
  }),

  Rpc.make("Environment.revoke", {
    error: EnvironmentError,
    payload: { deviceId: Schema.String }
  }),

  /** Read the persisted app config (null `reposDir` means first-run setup is pending). */
  Rpc.make("Config.get", {
    success: Schema.NullOr(WorkspaceConfig)
  }),

  /**
   * Open a native folder picker for the repos directory, persist the choice, and
   * return the updated config. Returns null if the user cancels the dialog.
   */
  Rpc.make("Setup.chooseReposDir", {
    success: Schema.NullOr(WorkspaceConfig)
  }),

  /** Durable repositories registered independently of workspace creation. */
  Rpc.make("Projects.list", {
    success: Schema.Array(Project),
    error: GitError,
    payload: { environmentId: Schema.optional(Schema.String) }
  }),

  Rpc.make("Projects.register", {
    success: Project,
    error: GitError,
    payload: {
      path: Schema.String,
      name: Schema.optional(Schema.String),
      environmentId: Schema.optional(Schema.String)
    }
  }),

  Rpc.make("Projects.browse", {
    success: Schema.NullOr(Schema.String)
  }),

  /** Choose the parent folder for a GitHub clone and return its full destination. */
  Rpc.make("Projects.browseCloneDestination", {
    success: Schema.NullOr(Schema.String),
    payload: { repositoryName: Schema.String }
  }),

  Rpc.make("Projects.listDirectories", {
    success: ProjectDirectoryListing,
    error: GitError,
    payload: { path: Schema.optional(Schema.String) }
  }),

  Rpc.make("Projects.createDirectory", {
    success: Project,
    error: GitError,
    payload: {
      path: Schema.String,
      name: Schema.optional(Schema.String),
      environmentId: Schema.optional(Schema.String)
    }
  }),

  Rpc.make("Projects.clone", {
    success: Project,
    error: GitError,
    payload: {
      url: Schema.String,
      destination: Schema.String,
      name: Schema.optional(Schema.String),
      environmentId: Schema.optional(Schema.String)
    }
  }),

  /** Clone through the GitHub App without exposing its short-lived credential to the renderer. */
  Rpc.make("Projects.cloneFromGitHub", {
    success: Project,
    error: Schema.Union(GitError, GitHubApiError),
    payload: {
      installationId: Schema.String,
      repository: Schema.String,
      destination: Schema.String,
      name: Schema.optional(Schema.String)
    }
  }),

  /** Ensure a locally registered project is available on a selected remote host. */
  Rpc.make("Projects.ensureOnEnvironment", {
    success: Project,
    error: GitError,
    payload: {
      projectId: Schema.String,
      environmentId: Schema.String
    }
  }),

  /** Removes only the registration; repositories and workspaces remain intact. */
  Rpc.make("Projects.remove", {
    error: GitError,
    payload: { id: Schema.String, environmentId: Schema.optional(Schema.String) }
  }),

  /** Scan the configured repos directory for git repositories. */
  Rpc.make("Workspace.repos", {
    success: Schema.Array(Repo),
    error: WorkspaceNotConfiguredError
  }),

  /** List the local branch names for one repo (for the base-branch picker). */
  Rpc.make("Workspace.branches", {
    success: Schema.Array(Schema.String),
    error: GitError,
    payload: { repoPath: Schema.String, environmentId: Schema.optional(Schema.String) }
  }),

  /** List a repo's tracked files (for the `@` code-reference menu). */
  Rpc.make("Workspace.files", {
    success: Schema.Array(Schema.String),
    error: GitError,
    payload: {
      repoPath: Schema.String,
      environmentId: Schema.optional(Schema.String),
      sessionId: Schema.optional(Schema.String)
    }
  }),

  /** Discard ALL uncommitted changes to a file in a session's worktree. */
  Rpc.make("Workspace.revertFile", {
    error: GitError,
    payload: { sessionId: Schema.String, path: Schema.String }
  }),

  /** Revert just the uncommitted changes in a NEW-file line range (reverse-apply). */
  Rpc.make("Workspace.revertLines", {
    error: GitError,
    payload: {
      sessionId: Schema.String,
      path: Schema.String,
      startLine: Schema.Number,
      endLine: Schema.Number
    }
  }),

  /** List all agent sessions for the sidebar. */
  Rpc.make("Sessions.list", {
    success: Schema.Array(Session)
  }),

  /** Fetch one session by id. */
  Rpc.make("Sessions.get", {
    success: Session,
    error: SessionNotFoundError,
    payload: { id: Schema.String }
  }),

  /** Create a worktree-backed or direct-checkout session, persist, and return it. */
  Rpc.make("Sessions.create", {
    success: Session,
    error: GitError,
    payload: CreateSessionInput
  }),

  /** Create a session while streaming real provisioning milestones to the renderer. */
  Rpc.make("Sessions.createWithProgress", {
    success: SessionCreationUpdate,
    error: GitError,
    payload: CreateSessionInput,
    stream: true
  }),

  /**
   * Create a session from an existing PR: land a worktree on the PR's head
   * branch using API-resolved fork metadata and ordinary git, link `prNumber`, persist, and return it.
   */
  Rpc.make("Sessions.createFromPr", {
    success: Session,
    error: Schema.Union(GitError, GitHubApiError),
    payload: CreateSessionFromPrInput
  }),

  Rpc.make("Sessions.createFromPrWithProgress", {
    success: SessionCreationUpdate,
    error: Schema.Union(GitError, GitHubApiError),
    payload: CreateSessionFromPrInput,
    stream: true
  }),

  /**
   * Create a session from a GitHub issue: fork a fresh `<number>-<slug>` branch
   * off base, link the issue + automations, seed the task from the issue.
   */
  Rpc.make("Sessions.createFromIssue", {
    success: Session,
    error: GitError,
    payload: CreateSessionFromIssueInput
  }),

  Rpc.make("Sessions.createFromIssueWithProgress", {
    success: SessionCreationUpdate,
    error: GitError,
    payload: CreateSessionFromIssueInput,
    stream: true
  }),

  /** Link a provider-neutral issue to a live session; returns the updated session. */
  Rpc.make("Sessions.linkIssue", {
    success: Session,
    error: Schema.Union(GitError, SessionNotFoundError),
    payload: {
      sessionId: Schema.String,
      issue: IssueReference,
      automations: Schema.optional(IssueAutomations)
    }
  }),

  /** Add or refresh several provider-neutral links and select the last one. */
  Rpc.make("Sessions.addIssues", {
    success: Session,
    error: Schema.Union(GitError, SessionNotFoundError),
    payload: { sessionId: Schema.String, issues: Schema.Array(IssueReference) }
  }),

  /** Select one existing provider-scoped issue link. */
  Rpc.make("Sessions.selectIssue", {
    success: Session,
    error: Schema.Union(GitError, SessionNotFoundError),
    payload: { sessionId: Schema.String, issue: IssueIdentity }
  }),

  /** Remove one provider-scoped issue link without disturbing the others. */
  Rpc.make("Sessions.removeIssue", {
    success: Session,
    error: Schema.Union(GitError, SessionNotFoundError),
    payload: { sessionId: Schema.String, issue: IssueIdentity }
  }),

  /** Unlink every provider-neutral issue; returns the updated session. */
  Rpc.make("Sessions.unlinkIssue", {
    success: Session,
    error: Schema.Union(GitError, SessionNotFoundError),
    payload: { sessionId: Schema.String }
  }),

  /**
   * Clear a session's one-shot `initialPrompt` once the composer has consumed
   * it; returns the updated session so the client state stops re-seeding.
   */
  Rpc.make("Sessions.clearInitialPrompt", {
    success: Session,
    error: Schema.Union(GitError, SessionNotFoundError),
    payload: { sessionId: Schema.String }
  }),

  /** Archive a session (its linked PR merged/closed) — read-only, kept. */
  Rpc.make("Sessions.archive", {
    success: Session,
    error: GitError,
    payload: { sessionId: Schema.String, reason: ArchiveReason }
  }),

  /** Restore an archived session back to an editable state. */
  Rpc.make("Sessions.restore", {
    success: Session,
    error: GitError,
    payload: { sessionId: Schema.String }
  }),

  /** Confirm that an uncertain mutation has been inspected; the call is never replayed. */
  Rpc.make("Sessions.resolveRuntimeRecovery", {
    success: Session,
    error: RuntimeRecoveryError,
    payload: {
      sessionId: Schema.String,
      runId: Schema.String,
      callId: Schema.String
    }
  }),

  /** Regenerate an auto-titled session's title from its transcript; returns it. */
  Rpc.make("Sessions.retitle", {
    success: Session,
    error: GitError,
    payload: { sessionId: Schema.String }
  }),

  /** Manually rename a session — pins the title (stops auto-retitling). */
  Rpc.make("Sessions.rename", {
    success: Session,
    error: GitError,
    payload: { sessionId: Schema.String, title: Schema.String }
  }),

  /**
   * Record a session's lifecycle status when its turn settles. Live activity is
   * renderer-only, but this persists so a session the operator hasn't OPENED this
   * run still reports whether it's idle or blocked on them.
   */
  Rpc.make("Sessions.setStatus", {
    success: Session,
    error: GitError,
    payload: { sessionId: Schema.String, status: SettledSessionStatus }
  }),

  /** Mark a session persistent or ordinary; returns the updated record. */
  Rpc.make("Sessions.setPersistent", {
    success: Session,
    error: GitError,
    payload: { sessionId: Schema.String, persistent: Schema.Boolean }
  }),

  /** Change a pristine session's execution device. Sessions with work require continuation. */
  Rpc.make("Sessions.setEnvironment", {
    success: Session,
    error: Schema.Union(GitError, SessionNotFoundError, EnvironmentError, EnvironmentHandoffError),
    payload: {
      sessionId: Schema.String,
      environmentId: Schema.optional(Schema.String)
    }
  }),

  /** Create a new session on another device while preserving the source session. */
  Rpc.make("Sessions.continueOnEnvironment", {
    success: Session,
    error: Schema.Union(GitError, SessionNotFoundError, EnvironmentError, EnvironmentHandoffError),
    payload: {
      sessionId: Schema.String,
      environmentId: Schema.optional(Schema.String)
    }
  }),

  /**
   * Re-point a drifted direct session at the branch its shared checkout is now
   * on. The recovery for a `BranchDrift`: the agent (or developer) moved `HEAD`
   * to a new branch, and the operator chooses to keep working there. Preserves
   * every other section of the session record; returns the updated session.
   */
  Rpc.make("Sessions.adoptBranch", {
    success: Session,
    error: Schema.Union(GitError, SessionNotFoundError),
    payload: { sessionId: Schema.String }
  }),

  /**
   * Fork a drifted direct session's work onto a fresh, isolated worktree session
   * pinned to the branch the checkout is now on — carrying the transcript and
   * the uncommitted changes — while leaving the source session pinned to its
   * original branch. The recovery for a `BranchDrift` when the operator wants
   * their primary checkout back on the original branch. Returns the new session.
   */
  Rpc.make("Sessions.forkOntoBranch", {
    success: Session,
    error: Schema.Union(GitError, SessionNotFoundError),
    payload: { sessionId: Schema.String }
  }),

  /** Permanently delete a session and remove its worktree. Irreversible. */
  Rpc.make("Sessions.delete", {
    error: GitError,
    payload: { sessionId: Schema.String }
  }),

  /** Create and activate a fresh chat inside a session. */
  Rpc.make("Sessions.createChat", {
    success: Session,
    error: GitError,
    payload: { sessionId: Schema.String }
  }),

  /** Persist which chat is active for the session. */
  Rpc.make("Sessions.selectChat", {
    success: Session,
    error: GitError,
    payload: { sessionId: Schema.String, chatId: Schema.String }
  }),

  /** Rename one chat without changing the session title. */
  Rpc.make("Sessions.renameChat", {
    success: Session,
    error: GitError,
    payload: {
      sessionId: Schema.String,
      chatId: Schema.String,
      title: Schema.String
    }
  }),

  /** Close one chat; closing the last creates a fresh Chat 1 replacement. */
  Rpc.make("Sessions.closeChat", {
    success: Session,
    error: GitError,
    payload: { sessionId: Schema.String, chatId: Schema.String }
  }),

  /** Restore a previously closed chat and make it active. */
  Rpc.make("Sessions.reopenChat", {
    success: Session,
    error: GitError,
    payload: { sessionId: Schema.String, chatId: Schema.String }
  }),

  /**
   * A newest-anchored window of the transcript.
   *
   * A session opens with only its tail, then pages older turns in when the
   * operator asks ("Load earlier"). Holding a 46MB transcript whole as a parsed
   * `Message[]` cost hundreds of MB of renderer heap PER live session, and the
   * residency cap allows several — so a real install's footprint became a
   * high-water mark of the largest transcripts ever opened.
   *
   * `before` is the opaque cursor returned by the previous page. `hasMore`
   * gates the affordance and `cursor` identifies the next older window. Image
   * data is stripped; thumbnails fetch it through `Sessions.attachment`.
   */
  Rpc.make("Sessions.transcriptPage", {
    success: Schema.Struct({
      messages: Schema.Array(Message),
      hasMore: Schema.Boolean,
      cursor: Schema.optional(Schema.String)
    }),
    payload: {
      sessionId: Schema.String,
      chatId: Schema.String,
      before: Schema.optional(Schema.String),
      limit: Schema.Int.pipe(Schema.between(1, 500))
    }
  }),

  /**
   * One image attachment's base64 bytes, by id — the other half of the
   * transcript's empty `data`.
   *
   * Fetched when a thumbnail actually mounts, which for a virtualized transcript
   * means the handful on screen rather than every image the session ever
   * contained. Null when the id is unknown (a transcript edited underneath us,
   * or an attachment whose chat has been deleted); the thumbnail then renders
   * its placeholder rather than a broken image.
   */
  Rpc.make("Sessions.attachment", {
    success: Schema.NullOr(Schema.String),
    payload: { chatId: Schema.String, attachmentId: Schema.String }
  }),

  /** The session worktree's bounded working diff, used by full code review. */
  Rpc.make("Sessions.diff", {
    success: SessionReviewDiff,
    error: GitError,
    payload: { id: Schema.String }
  }),

  /** Lightweight totals for badges and the Changes tab. */
  Rpc.make("Sessions.diffStat", {
    success: SessionDiffStat,
    error: GitError,
    payload: { id: Schema.String }
  }),

  /** One bounded file patch, loaded only when that file is opened. */
  Rpc.make("Sessions.fileDiff", {
    success: SessionFileDiff,
    error: GitError,
    payload: { id: Schema.String, path: Schema.String }
  }),

  /**
   * Send a prompt and stream the agent's normalized events back. This is the
   * harness-agnostic seam: the renderer folds the same `StreamEvent`s the runner
   * persisted, so the experience is identical across models/harnesses.
   */
  Rpc.make("Agent.run", {
    success: StreamEvent,
    stream: true,
    payload: {
      sessionId: Schema.String,
      chatId: Schema.String,
      text: Schema.String,
      /** Operator-visible text when hidden structured context is appended to `text`. */
      displayText: Schema.optional(Schema.String),
      /** Images the operator attached as context (optional; omitted → none). */
      images: Schema.optional(Schema.Array(Attachment)),
      /**
       * Per-turn override. Null deliberately means native default, which lets a
       * just-cleared composer value win even if its persistence RPC is in flight.
       */
      reasoning: Schema.optional(Schema.NullOr(ReasoningSetting)),
      externalInstruction: Schema.optional(ExternalInstructionIdentity)
    }
  }),

  /** Resolve a pending HITL approval gate (allow / deny / always). */
  Rpc.make("Agent.decideGate", {
    error: GitError,
    payload: {
      sessionId: Schema.String,
      chatId: Schema.String,
      gateId: Schema.String,
      decision: GateDecision
    }
  }),

  /** Submit answers to a pending AskUserQuestion group, resuming the agent. */
  Rpc.make("Agent.answerQuestion", {
    error: GitError,
    payload: {
      sessionId: Schema.String,
      chatId: Schema.String,
      requestId: Schema.String,
      answers: Schema.Array(QuestionAnswer)
    }
  }),

  /** Change a session's HITL permission mode (ask / accept-edits / auto / plan). */
  Rpc.make("Agent.setMode", {
    payload: {
      sessionId: Schema.String,
      chatId: Schema.String,
      mode: PermissionMode
    }
  }),

  /** Change one chat's provider-neutral thinking settings. */
  Rpc.make("Agent.setReasoning", {
    payload: {
      sessionId: Schema.String,
      chatId: Schema.String,
      reasoning: Schema.optional(ReasoningSetting)
    }
  }),

    /** Change one conversation's certified provider connection/model atomically. */
  Rpc.make("Agent.setModel", {
    success: Session,
    error: Schema.Union(GitError, SessionNotFoundError),
    payload: SetSessionProviderModelInput
  }),

  /** Stop a running agent (denies any pending gate). */
  Rpc.make("Agent.stop", {
    error: GitError,
    payload: { sessionId: Schema.String, chatId: Schema.String }
  }),

  /**
   * Whether this chat has a live, unsettled turn in main right now.
   *
   * Read at conversation load: a freshly reloaded renderer that dequeues a
   * held message straight into `Agent.run` while main's previous turn still
   * streams gets only the single-flight refusal as its "reply". Asking first
   * lets the load hold the queue until the live turn settles.
   */
  Rpc.make("Agent.chatBusy", {
    success: Schema.Boolean,
    payload: { sessionId: Schema.String, chatId: Schema.String }
  }),

  /** Whether a persisted Plannotator review was interrupted by host restart. */
  Rpc.make("Agent.plannotatorRecoveryNeeded", {
    success: Schema.Boolean,
    payload: { sessionId: Schema.String, chatId: Schema.String }
  }),

  /**
   * Kill ONE live sub-agent, leaving the turn (and its siblings) running.
   *
   * `agentId` is the tab's id — the spawning tool-call id — not the runtime's
   * task id. The tab has only ever known the former; the run that owns the
   * sub-agent is the only place the two are correlated, so the translation
   * happens there rather than being pushed onto the renderer.
   *
   * Fire-and-forget by design. The kill is confirmed the same way an ordinary
   * completion is — a `SubagentEnded` on the stream, with status `stopped` —
   * so there is no reply here that the tab isn't already about to receive.
   */
  Rpc.make("Agent.stopSubagent", {
    payload: {
      sessionId: Schema.String,
      chatId: Schema.String,
      agentId: Schema.String
    }
  }),

  /** Reconcile the active first-class Fleet independently of the parent turn stream. */
  Rpc.make("Agent.subagentFleetSnapshot", {
    success: SubagentFleetSnapshot,
    error: GitError,
    payload: {
      sessionId: Schema.String,
      chatId: Schema.String,
      parentPiSessionId: Schema.String
    }
  }),

  /** Read one exact child session through the runtime's trusted session-root policy. */
  Rpc.make("Agent.subagentTranscript", {
    success: Schema.Array(Message),
    error: GitError,
    payload: {
      sessionId: Schema.String,
      chatId: Schema.String,
      parentPiSessionId: Schema.String,
      runId: Schema.String
    }
  }),

  /** Control one exact pi-subagents run and return its reconciled acknowledgement. */
  Rpc.make("Agent.controlSubagent", {
    success: SubagentFleetControlOutcome,
    error: GitError,
    payload: {
      sessionId: Schema.String,
      chatId: Schema.String,
      request: SubagentFleetControlRequest
    }
  }),

  /**
   * Add input to a live pi turn. Compaction temporarily defers it; providers
   * without steering support report unsupported so the renderer can stop/replay.
   */
  Rpc.make("Agent.messagePeer", {
    success: PeerAgentMessageResult,
    error: GitError,
    payload: {
      sessionId: Schema.String,
      fromChatId: Schema.String,
      toChatId: Schema.String,
      text: Schema.String
    }
  }),

  Rpc.make("Agent.steer", {
    success: Schema.Union(
      Schema.Struct({
        status: Schema.Literal("accepted"),
        user: Message,
        assistant: Message
      }),
      Schema.Struct({
        status: Schema.Literal("deferred", "unsupported")
      })
    ),
    error: GitError,
    payload: {
      sessionId: Schema.String,
      chatId: Schema.String,
      text: Schema.String,
      images: Schema.Array(Attachment)
    }
  }),

  /** List the skills/slash-commands the session's harness exposes (the `/` menu). */
  Rpc.make("Skills.list", {
    success: Schema.Array(Skill),
    payload: { sessionId: Schema.String }
  }),

  // ── MCP servers — the operator's ~/jingler/mcp.json ────────────────────────

  /**
   * The redacted server list plus the file's parse problem, if any. Entries
   * carry header/env NAMES only — mcp.json itself never crosses this boundary.
   */
  Rpc.make("Mcp.list", {
    success: Schema.Struct({
      servers: Schema.Array(McpServer),
      /** Why mcp.json could not be parsed; `servers` is empty then. */
      error: Schema.NullOr(Schema.String)
    })
  }),

  /**
   * Live probe of every configured server (`initialize` + `tools/list`).
   * User-initiated only — probing spawns stdio server commands.
   */
  Rpc.make("Mcp.status", {
    success: Schema.Array(McpServerStatus),
    error: ConfigError
  }),

  /** Create or replace one entry. Values travel INBOUND only. */
  Rpc.make("Mcp.write", {
    success: Schema.Void,
    error: ConfigError,
    payload: { name: Schema.String, entry: McpConfigEntry }
  }),

  Rpc.make("Mcp.remove", {
    success: Schema.Void,
    error: ConfigError,
    payload: { name: Schema.String }
  }),

  Rpc.make("Mcp.setEnabled", {
    success: Schema.Void,
    error: ConfigError,
    payload: { name: Schema.String, enabled: Schema.Boolean }
  }),

  Rpc.make("Mcp.setAuth", {
    success: Schema.Void,
    error: ConfigError,
    payload: { name: Schema.String, auth: McpRemoteAuth }
  }),

  /** Save or replace one API key in the encrypted device credential document. */
  Rpc.make("Mcp.setApiKey", {
    success: Schema.Void,
    error: ConfigError,
    payload: SetMcpApiKeyInput.fields
  }),

  /** Begin OAuth in the system browser; completion lands on a loopback callback. */
  Rpc.make("Mcp.startAuthorization", {
    success: McpAuthorizationStart,
    error: ConfigError,
    payload: { name: Schema.String }
  }),

  /** Parse one source config into redacted candidates for confirmation. */
  Rpc.make("Mcp.importCandidates", {
    success: Schema.Array(McpImportCandidateView),
    error: ConfigError,
    payload: { source: McpImportSourceId }
  }),

  /**
   * Import the confirmed candidates by name. The source file is re-parsed in
   * the main process, so secret values never round-trip through the renderer.
   * Returns the names actually written; existing names are skipped.
   */
  Rpc.make("Mcp.applyImport", {
    success: Schema.Array(Schema.String),
    error: ConfigError,
    payload: { source: McpImportSourceId, names: Schema.Array(Schema.String) }
  }),

  /** Reveal mcp.json in the file manager, creating an empty file if absent. */
  Rpc.make("Mcp.reveal", {
    success: Schema.Void,
    error: ConfigError
  }),

  /** Provider usage / rate-limit windows for the Usage & limits modal. */
  Rpc.make("Usage.get", {
    success: Usage
  }),

  /**
   * A session's context accounting — what the meter renders and what Settings
   * lists. Cheap enough to poll: it reads in-memory state plus the persisted
   * session, and never contacts a provider.
   */
  Rpc.make("Context.state", {
    success: ContextSnapshot,
    payload: { sessionId: Schema.String, chatId: Schema.String }
  }),

  /**
   * Compact this session now, regardless of the budget.
   *
   * Returns immediately — the digest is built on a background fiber, exactly as
   * an automatic compaction would be, and lands on the NEXT turn. A button that
   * blocked until the summary was ready would reintroduce the wait the whole
   * feature exists to remove.
   */
  Rpc.make("Context.compactNow", {
    payload: { sessionId: Schema.String, chatId: Schema.String }
  }),

  /** Persist the auto-compaction levers (master switch + working-set budget). */
  Rpc.make("Config.setContext", {
    success: WorkspaceConfig,
    error: ConfigError,
    payload: ContextConfig
  }),

  /** Persist automatic Cloudflare compute routing and explicit argv allowlists. */
  Rpc.make("Config.setOffloadCompute", {
    success: WorkspaceConfig,
    error: ConfigError,
    payload: OffloadComputeSettings
  }),

  /** Per-session auto-compaction override (absent = follow the global setting). */
  Rpc.make("Sessions.setAutoCompact", {
    success: Session,
    error: GitError,
    payload: { id: Schema.String, autoCompact: Schema.NullOr(Schema.Boolean) }
  }),

  /** Reconcile and return the signed-in user's shared GitHub App connection. */
  Rpc.make("GitHub.status", {
    success: GitHubAppConnectionStatus,
    error: AuthError
  }),

  /** Fetch repositories visible to every active GitHub App installation. */
  Rpc.make("GitHub.repositories", {
    success: Schema.Array(GitHubCloneRepository),
    error: AuthError
  }),

  /** Create a state-bound GitHub App installation URL for the system browser. */
  Rpc.make("GitHub.install", {
    success: Schema.String,
    error: AuthError
  }),

  /** Reconcile installations after repository access or suspension changes. */
  Rpc.make("GitHub.refresh", {
    success: GitHubAppConnectionStatus,
    error: AuthError
  }),

  /** Revoke and remove the product integration without signing out of Jingler. */
  Rpc.make("GitHub.disconnect", {
    error: AuthError
  }),

  /** Verified GitHub webhook deliveries awaiting durable visible routing. */
  Rpc.make("Github.events", {
    success: GitHubRelayStreamMessage,
    stream: true
  }),

  /** Atomically claim feedback for an exact active linked session. */
  Rpc.make("Github.claimFeedback", {
    success: GitHubFeedbackClaimStatus,
    error: GitError,
    payload: {
      operation: Schema.Literal("claim", "mark-dispatched"),
      sessionId: Schema.String,
      installationId: Schema.String,
      repositoryId: Schema.String,
      prNumber: Schema.Number,
      deliveryId: Schema.String,
      semanticKey: Schema.String,
      event: GitHubRelayEvent
    }
  }),

  /** Release a held relay cursor only after visible routing settles. */
  Rpc.make("Github.ackEvent", {
    payload: {
      clientId: Schema.String,
      cursor: Schema.Number,
      /**
       * "retry" is a negative acknowledgement: the renderer could not route the
       * delivery (no matching local session yet, or routing failed outright).
       * Main rejects the held cursor so the relay connection replays the frame
       * with backoff instead of wedging behind it forever. Optional so an older
       * renderer's plain ack still decodes as a routed acknowledgement.
       */
      outcome: Schema.optional(Schema.Literal("routed", "retry"))
    }
  }),

  /** Persist the user's GitHub integration preferences. */
  Rpc.make("Config.setGithub", {
    success: WorkspaceConfig,
    error: ConfigError,
    payload: GithubConfig
  }),

  /** Persist the user's git behaviour preferences. */
  Rpc.make("Config.setGit", {
    success: WorkspaceConfig,
    error: ConfigError,
    payload: GitConfig
  }),

  /** Persist the user's desktop-notification preferences. */
  Rpc.make("Config.setNotifications", {
    success: WorkspaceConfig,
    error: ConfigError,
    payload: NotificationsConfig
  }),

  /** Persist the permission mode used for new chats across every provider model. */
  Rpc.make("Config.setDefaultMode", {
    success: WorkspaceConfig,
    error: ConfigError,
    payload: Schema.Struct({ defaultMode: ExecutionMode })
  }),

  Rpc.make("Config.setSubagentModel", {
    success: WorkspaceConfig,
    error: ConfigError,
    payload: Schema.Struct({
      agent: JinglerSubagentName,
      modelId: Schema.NullOr(ProviderModelId)
    })
  }),

  /**
   * Persist whether plan mode runs commands unattended. Plan mode cannot edit,
   * so this only ever covers read-only commands.
   */
  Rpc.make("Config.setPlanAutoRun", {
    success: WorkspaceConfig,
    error: ConfigError,
    payload: Schema.Struct({ planAutoRun: Schema.Boolean })
  }),

  /**
   * Persist ADHD mode — whether every agent turn is asked to shape its reply
   * for an ADHD reader. Returns the whole config so the renderer can patch its
   * cache without a refetch.
   */
  Rpc.make("Config.setAdhdMode", {
    success: WorkspaceConfig,
    error: ConfigError,
    payload: Schema.Struct({ adhdMode: Schema.Boolean })
  }),

  /**
   * Persist the conversation + code text-size multiplier. Returns the whole
   * config so the renderer can patch its cache without a refetch.
   */
  Rpc.make("Config.setFontScale", {
    success: WorkspaceConfig,
    error: ConfigError,
    // The usable range lives in the contract, not only the service — the schema
    // is the single source of truth, so every client is bounded before main runs.
    payload: Schema.Struct({
      fontScale: Schema.Number.pipe(
        Schema.between(FONT_SCALE_RANGE.min, FONT_SCALE_RANGE.max)
      )
    })
  }),

  /** Persist the certified provider connection and model as one canonical selection. */
  Rpc.make("Config.setDefaultProviderModel", {
    success: WorkspaceConfig,
    error: ConfigError,
    payload: SetDefaultProviderModelInput
  }),

  /** Persist that first-run provider authentication was completed or skipped. */
  Rpc.make("Config.completeProviderSetup", {
    success: WorkspaceConfig,
    error: ConfigError
  }),

  /** Persist only the secret-free WebSearch provider/setup choice. */
  Rpc.make("Config.setWebSearch", {
    success: WorkspaceConfig,
    error: ConfigError,
    payload: WebSearchConfig
  }),

  Rpc.make("WebSearch.get", {
    success: WebSearchSettingsStatus,
    error: WebSearchError
  }),

  /** The key is inbound only; success returns redacted status. */
  Rpc.make("WebSearch.setCredential", {
    success: WebSearchSettingsStatus,
    error: WebSearchError,
    payload: SetWebSearchCredentialInput
  }),

  Rpc.make("WebSearch.clearCredential", {
    success: WebSearchSettingsStatus,
    error: WebSearchError,
    payload: ClearWebSearchCredentialInput
  }),

  Rpc.make("WebSearch.skip", {
    success: WebSearchSettingsStatus,
    error: WebSearchError
  }),

  /**
   * Raise an OS notification for a session.
   *
   * Main owns the Electron `Notification` API, but only the RENDERER knows
   * whether this session is the one the operator is already looking at — so the
   * decision to notify is made there and this call is the delivery mechanism.
   * Deliberately fire-and-forget: a notification that fails to show must never
   * disturb the run that triggered it.
   */
  Rpc.make("Notify.show", {
    success: Schema.Void,
    payload: {
      sessionId: Schema.String,
      kind: NotificationKind,
      title: Schema.String,
      body: Schema.String,
      /**
       * Is this the session the operator currently has open? Only the renderer
       * knows; main pairs it with the window's own focus state (which only main
       * knows authoritatively) to decide whether the operator can already see
       * what we're about to tell them.
       */
      isActiveSession: Schema.Boolean
    }
  }),

  /** Persist the full set of starred repo paths (replaces the stored list). */
  Rpc.make("Config.setStarredRepos", {
    success: WorkspaceConfig,
    error: ConfigError,
    payload: { paths: Schema.Array(Schema.String) }
  }),

  /** Persist the full set of collapsed repo paths (replaces the stored list). */
  Rpc.make("Config.setCollapsedRepos", {
    success: WorkspaceConfig,
    error: ConfigError,
    payload: { paths: Schema.Array(Schema.String) }
  }),

  /** Remember the repo used for the most recent session create (picker default). */
  Rpc.make("Config.setLastRepoPath", {
    success: WorkspaceConfig,
    error: ConfigError,
    payload: { path: Schema.String }
  }),

  /** Persist the editable PRD MDX template used by every native planning harness. */
  Rpc.make("Config.setPlanTemplate", {
    success: WorkspaceConfig,
    error: ConfigError,
    payload: { template: PlanTemplateConfig }
  }),

) {}

/** Review, preview, theme, and plugin half of the renderer RPC client. */
export class JinglerReviewRpcs extends RpcGroup.make(
  /**
   * Run an adversarial review of the session's linked PR: a reviewer agent runs
   * READ-ONLY in the session's worktree, on the configured review model (Fable by
   * default), and argues against the diff.
   *
   * De-duped on the PR head SHA — a run whose head matches the stored review
   * returns that review without spawning an agent, unless `force`. That is what
   * lets the auto-review trigger fire off a poll loop safely.
   */
  /** The latest focused visual explanation for this session. */
  Rpc.make("Explanation.current", {
    success: Schema.NullOr(ExplanationDocument),
    payload: { sessionId: Schema.String }
  }),

  /** Stream replacement revisions of the session's focused explanation. */
  Rpc.make("Explanation.watch", {
    success: Schema.NullOr(ExplanationDocument),
    stream: true,
    payload: { sessionId: Schema.String }
  }),

    Rpc.make("Review.run", {
    success: AdversarialReview,
    error: Schema.Union(ReviewError, GitHubApiError),
    payload: { sessionId: Schema.String, force: Schema.Boolean }
  }),

  /**
   * Watch the running reviewer's events for a session — what it has emitted so
   * far, then everything after, live.
   *
   * Separate from `Review.run` (which blocks for the whole multi-minute run and
   * returns only the verdict) because the watcher usually isn't the caller: the
   * auto-review is a poll across every session, so a reviewer may already be
   * mid-flight when you open one. Subscribing is safe at any time — the stream is
   * simply empty until a review starts.
   *
   * `chatId` is the subscriber, and it is load-bearing, not cosmetic. A review
   * is a session-level artifact, but its transcript is rendered inside ONE chat's
   * sub-agent rail — so it must belong to exactly one chat, or every new chat in
   * the session inherits the last review's Reviewer tab and replays someone
   * else's run. Ownership is the chat that was the session's `activeChatId` when
   * the review STARTED; only that chat's watcher receives the run's events.
   */
  Rpc.make("Review.watch", {
    success: StreamEvent,
    stream: true,
    payload: { sessionId: Schema.String, chatId: Schema.String }
  }),

  /** The last stored adversarial review for a session, or null. Never errors. */
  Rpc.make("Review.get", {
    success: Schema.NullOr(AdversarialReview),
    payload: { sessionId: Schema.String }
  }),

  /**
   * Stamp the stored review as having had its critical/major findings handed to
   * the session's agent, returning the stamp (ISO-8601).
   *
   * The renderer owns the routing itself — the conversation actor lives there,
   * and routing through it is what puts the agent's work and its approval gates
   * in the Conversation tab instead of a hidden run. But it cannot own the
   * MEMORY of having routed: `routed-store` is in-memory, so after a reload the
   * auto-review poll would hand back the same review and re-send the whole batch
   * as a fresh turn. So the renderer acts, and asks main to remember.
   *
   * A no-op (returning the existing stamp) when the review is already routed, so
   * a double-call from a re-render can't move the goalposts.
   */
  Rpc.make("Review.markRouted", {
    success: Schema.NullOr(Schema.String),
    payload: { sessionId: Schema.String }
  }),

  /**
   * Attribute any outstanding findings to the commits that fixed them, and
   * return the updated review — or **null when nothing changed**.
   *
   * Null-on-no-change is the contract, not an accident: the renderer calls this
   * every time a turn settles, and the overwhelmingly common answer is "no new
   * commits touched a finding's file". Returning the unchanged review would have
   * the renderer publish an identical object into the query cache on every turn,
   * re-rendering the review pane for nothing. Null also covers "no stored review"
   * and "no worktree", which need the same treatment: leave the cache alone.
   */
  Rpc.make("Review.reconcile", {
    success: Schema.NullOr(AdversarialReview),
    payload: { sessionId: Schema.String }
  }),

  /**
   * The pull request linked to a session (its `prNumber`), assembled from the
   * GitHub REST and GraphQL APIs. Null when the session has no worktree or no linked PR. Embeds CI
   * checks, reviewers, and the review timeline for the Pull Request tab.
   */
  Rpc.make("Github.pr", {
    success: Schema.NullOr(PullRequest),
    error: GitHubApiError,
    payload: { sessionId: Schema.String }
  }),

  /** Open PRs across every repository granted to the GitHub App. */
  Rpc.make("Github.inbox", {
    success: Schema.Array(PullRequestListItem),
    error: GitHubApiError
  }),

  /** Read one PR without requiring a linked Jingler session. */
  Rpc.make("Github.prBySlug", {
    success: Schema.NullOr(PullRequest),
    error: GitHubApiError,
    payload: { repository: Schema.String, number: Schema.Number }
  }),

  /**
   * List open PRs for a repo (for the "new session from a PR" picker). `mine`
   * filters to the authenticated user; `search` is a free-text query.
   */
  Rpc.make("Github.listPrs", {
    success: Schema.Array(PrSummary),
    error: GitHubApiError,
    payload: {
      repoPath: Schema.String,
      githubSlug: Schema.optional(Schema.String),
      mine: Schema.Boolean,
      search: Schema.String
    }
  }),

  /**
   * List open issues for a repo (for the "new session from an issue" picker +
   * attach dialog). `mine` filters to issues assigned to you.
   */
  Rpc.make("Github.listIssues", {
    success: Schema.Array(IssueSummary),
    error: GitHubApiError,
    payload: {
      repoPath: Schema.String,
      githubSlug: Schema.optional(Schema.String),
      mine: Schema.Boolean,
      search: Schema.String
    }
  }),

  /** Close the session's linked issue (close-on-merge automation). */
  Rpc.make("Github.closeIssue", {
    error: GitHubApiError,
    payload: { sessionId: Schema.String }
  }),

  /** The full linked-issue view model for the session's Issue tab (null if none). */
  Rpc.make("Github.issue", {
    success: Schema.NullOr(Issue),
    error: GitHubApiError,
    payload: { sessionId: Schema.String }
  }),

  /**
   * A session's linked PR reduced to what the sidebar row shows — its lifecycle
   * state plus a CI rollup. Polled per session on a timer, so it is deliberately
   * the cheapest PR read in the contract; `Github.pullRequest` is the rich one.
   */
  Rpc.make("Github.prState", {
    success: Schema.NullOr(SessionPrStatus),
    error: GitHubApiError,
    payload: { sessionId: Schema.String }
  }),

  /** The changed files of a session's PR, for the Code Review file list. */
  Rpc.make("Github.files", {
    success: Schema.Array(PrFileChange),
    error: GitHubApiError,
    payload: { sessionId: Schema.String }
  }),

  /** The unified diff of a session's PR vs its base branch. */
  Rpc.make("Github.diff", {
    success: Schema.String,
    error: GitHubApiError,
    payload: { sessionId: Schema.String }
  }),

  /**
   * Detect a PR already open on the session's branch, link it (persist
   * `prNumber`), and return its number (null if none).
   */
  Rpc.make("Github.detectPr", {
    success: Schema.NullOr(Schema.Number),
    error: GitHubApiError,
    payload: { sessionId: Schema.String }
  }),

  /**
   * Deterministically stage, commit, authenticate, push, create/update a PR,
   * and link it to the session. Every durable checkpoint is streamed so the UI
   * can show the authoritative main-process mutation state.
   */
  Rpc.make("Github.createPr", {
    success: PublishCheckpoint,
    stream: true,
    payload: { sessionId: Schema.String }
  }),

  /**
   * Post a top-level comment on the session's PR. `toGithub` gates the actual
   * GitHub API write (the renderer separately routes the body to the agent).
   */
  Rpc.make("Github.comment", {
    error: GitHubApiError,
    payload: {
      sessionId: Schema.String,
      body: Schema.String,
      toGithub: Schema.Boolean
    }
  }),

  /** Post a top-level conversation comment on a global pull request. */
  Rpc.make("Github.commentBySlug", {
    error: GitHubApiError,
    payload: {
      repository: Schema.String,
      number: Schema.Number,
      body: Schema.String
    }
  }),

  /** Close a global pull request. */
  Rpc.make("Github.closeBySlug", {
    error: GitHubApiError,
    payload: {
      repository: Schema.String,
      number: Schema.Number
    }
  }),

  /** Merge a global pull request using the selected method. */
  Rpc.make("Github.mergeBySlug", {
    error: GitHubApiError,
    payload: {
      repository: Schema.String,
      number: Schema.Number,
      method: PrMergeMethod
    }
  }),

  /**
   * Submit the reviewer's drafts to the session's PR as a COMMENT review
   * carrying real, line-anchored inline comments.
   *
   * Distinct from `Github.comment` (one top-level blob) and `Github.review` (a
   * body and nothing else): this is the only path that produces inline threads,
   * so a comment written in Jingler comes back from GitHub on the same line.
   *
   * Returns how many drafts couldn't be anchored to a line in the PR's current
   * diff — those are folded into the review body rather than dropped, so a
   * non-zero count is informational, not a failure.
   */
  Rpc.make("Github.submitReview", {
    success: Schema.Number,
    error: GitHubApiError,
    payload: {
      sessionId: Schema.String,
      comments: Schema.Array(ReviewComment)
    }
  }),

  /** Submit a review (comment / approve / request-changes) on the session's PR. */
  Rpc.make("Github.review", {
    error: GitHubApiError,
    payload: {
      sessionId: Schema.String,
      kind: ReviewSubmitKind,
      body: Schema.String
    }
  }),

  /**
   * Resolve / unresolve an inline review thread on the session's PR. `threadId`
   * is the GraphQL node id carried on `PrReviewThread.id`.
   */
  Rpc.make("Github.resolveThread", {
    error: GitHubApiError,
    payload: {
      sessionId: Schema.String,
      threadId: Schema.String,
      resolved: Schema.Boolean
    }
  }),

  /**
   * Reply to the inline review thread `commentId` belongs to. `commentId` is the
   * REST numeric id from `PrThreadComment.databaseId` (not the node id).
   */
  Rpc.make("Github.replyToThread", {
    error: GitHubApiError,
    payload: {
      sessionId: Schema.String,
      commentId: Schema.Number,
      body: Schema.String
    }
  }),

  /**
   * Merge the session's linked PR. `method` defaults to a merge commit; surfaces
   * `GitHubApiError` when GitHub rejects the merge (branch protection, conflicts, …).
   */
  Rpc.make("Github.merge", {
    error: GitHubApiError,
    payload: {
      sessionId: Schema.String,
      method: Schema.optional(PrMergeMethod)
    }
  }),

  /**
   * Flip the session's draft PR to "ready for review"; surfaces
   * `GitHubApiError` when there is no linked PR or GitHub rejects it.
   */
  Rpc.make("Github.markReady", {
    error: GitHubApiError,
    payload: { sessionId: Schema.String }
  }),

  /**
   * Merge the base branch into the PR's head — GitHub's "Update branch", the fix
   * for a `BEHIND` merge state. Updates the REMOTE head only; the session's
   * worktree is deliberately left alone, since the agent may be mid-turn.
   * Surfaces `GitHubApiError` when there is no linked PR or GitHub rejects it.
   */
  Rpc.make("Github.updateBranch", {
    error: GitHubApiError,
    payload: { sessionId: Schema.String }
  }),

  // ── Terminal ───────────────────────────────────────────────────────────────
  // A native PTY-backed terminal, scoped to a session (cwd = its worktree). The
  // PTY lives in the main process; only coalesced byte frames cross IPC. Lifecycle
  // (create/resize/kill/list) is unary; the hot output path is the `attach` stream.

  /**
   * Spawn a login shell in `cwd` (defaults to the session's worktree) sized to
   * `cols`×`rows`, and return its descriptor. The PTY outlives dock toggles and
   * session switches — it is only reclaimed by `Terminal.kill`, session delete,
   * or app quit.
   */
  Rpc.make("Terminal.create", {
    success: TerminalInfo,
    error: TerminalError,
    payload: {
      sessionId: Schema.String,
      cwd: Schema.optional(Schema.String),
      cols: Schema.Number,
      rows: Schema.Number
    }
  }),

  /**
   * Subscribe to a terminal's output. Replays the recent scrollback (a bounded
   * ring buffer) so a re-attach after a dock/session toggle restores the screen,
   * then streams live *coalesced* frames. Long-lived: cancel the stream to
   * detach (the PTY keeps running). Ends with an `exit` frame when the shell dies.
   */
  Rpc.make("Terminal.attach", {
    success: TerminalChunk,
    stream: true,
    payload: { terminalId: Schema.String }
  }),

  /** Write operator keystrokes (or pasted text) to a terminal's PTY. No-op if unknown. */
  Rpc.make("Terminal.write", {
    payload: { terminalId: Schema.String, data: Schema.String }
  }),

  /** Resize a terminal's PTY (drives SIGWINCH so TUIs reflow). No-op if unknown. */
  Rpc.make("Terminal.resize", {
    payload: {
      terminalId: Schema.String,
      cols: Schema.Number,
      rows: Schema.Number
    }
  }),

  /** Kill a terminal's shell (SIGHUP) and drop it. Idempotent. */
  Rpc.make("Terminal.kill", {
    payload: { terminalId: Schema.String }
  }),

  /** List the live terminals for a session (to rebuild its tab strip on mount). */
  Rpc.make("Terminal.list", {
    success: Schema.Array(TerminalInfo),
    payload: { sessionId: Schema.String }
  }),

  // ── Background tasks ─────────────────────────────────────────────────────────
  // Harness work that OUTLIVES the turn that started it. Lives in a main-process
  // registry (one statechart per task) rather than in per-run renderer state,
  // which is cleared on every new turn.

  /**
   * A session's background tasks — running first, then settled ones (whose
   * transcripts are still worth reading). Rebuilds the dock on mount.
   */
  Rpc.make("BackgroundTasks.list", {
    success: Schema.Array(BackgroundTask),
    payload: { sessionId: Schema.String }
  }),

  /**
   * Ask the harness to stop one task, returning it in its new state — normally
   * `stopping`, since confirmation arrives later, or a terminal state when no
   * live harness owns it. Null when the id is unknown. Idempotent.
   */
  Rpc.make("BackgroundTasks.stop", {
    success: Schema.NullOr(BackgroundTask),
    payload: { sessionId: Schema.String, taskId: Schema.String }
  }),

  /**
   * Drop a settled task's row. Settled tasks normally age out on their own after
   * a short grace period; a FAILED one is held indefinitely so an error can't
   * scroll past unseen, and this is how the operator clears it. Idempotent — an
   * unknown id (already aged out, already dismissed) succeeds silently.
   */
  Rpc.make("BackgroundTasks.dismiss", {
    success: Schema.Void,
    payload: { sessionId: Schema.String, taskId: Schema.String }
  }),

  /**
   * A settled task's full transcript, read from the `output_file` the harness
   * reported. Empty while the task is still running — there is no output stream
   * before it settles, only the progress fields on the task itself.
   */
  Rpc.make("BackgroundTasks.output", {
    success: Schema.String,
    payload: { sessionId: Schema.String, taskId: Schema.String }
  }),

  // ── Auth ─────────────────────────────────────────────────────────────────────
  // The desktop app is gated behind a BetterAuth sign-in wall. The bearer token
  // lives in the OS keychain (main process); these procedures let the renderer
  // read the session, kick off sign-in, and sign out.

  /** The current authenticated session, or null when signed out. */
  Rpc.make("Auth.getSession", {
    success: Schema.NullOr(AuthSession)
  }),

  /**
   * Begin an OAuth sign-in: returns the provider URL the renderer opens in the
   * system browser. The flow completes via the `jingler://` deep link.
   */
  Rpc.make("Auth.startSignIn", {
    success: Schema.String,
    error: AuthError,
    payload: { provider: AuthProvider }
  }),

  /**
   * Request an email magic link (sent by the server; console-logged in dev).
   * `name` is supplied only from the sign-up form; on first sign-in the server
   * uses it as the new user's display name (ignored for existing users).
   */
  Rpc.make("Auth.sendMagicLink", {
    error: AuthError,
    payload: { email: Schema.String, name: Schema.optional(Schema.String) }
  }),

  /** Sign out — revoke on the server (best effort) and clear the local token. */
  Rpc.make("Auth.signOut", {}),

  // ── Browser preview ──────────────────────────────────────────────────────────
  // An embedded `WebContentsView` (main process) pointed at a localhost dev
  // server. It renders OUTSIDE the renderer's DOM/CSP, so the renderer drives it
  // through these procedures and streams the pane's on-screen bounds to keep the
  // native view aligned. Each repository session owns an isolated preview view.

  /**
   * Show the preview view and load `url` at `bounds`. Only http/https URLs are
   * accepted (fails with `BrowserPreviewError` otherwise). Idempotent — reuses
   * the existing view if already open.
   */
  Rpc.make("BrowserPreview.open", {
    error: BrowserPreviewError,
    payload: {
      sessionId: Schema.String,
      chatId: Schema.String,
      url: Schema.String,
      bounds: BrowserBounds
    }
  }),

  /** Reposition/resize the view to track the pane's rect (on layout/scroll). No-op if closed. */
  Rpc.make("BrowserPreview.setBounds", {
    payload: { sessionId: Schema.String, chatId: Schema.String, bounds: BrowserBounds }
  }),

  /** Navigate the open view to a new URL. Fails with `BrowserPreviewError` for non-http(s). */
  Rpc.make("BrowserPreview.navigate", {
    error: BrowserPreviewError,
    payload: { sessionId: Schema.String, chatId: Schema.String, url: Schema.String }
  }),

  /** Reload the current page. No-op if closed. */
  Rpc.make("BrowserPreview.reload", {
    payload: { sessionId: Schema.String, chatId: Schema.String }
  }),

  /**
   * Show/hide the native view without destroying it — the Preview dock switching
   * away from the Browser tab. `close` would also hide it, but it discards the
   * page, its history and its scroll position with it.
   */
  Rpc.make("BrowserPreview.setVisible", {
    payload: { sessionId: Schema.String, chatId: Schema.String, visible: Schema.Boolean }
  }),

  /** Destroy one chat's native browser view and discard its page state. */
  Rpc.make("BrowserPreview.close", {
    payload: { sessionId: Schema.String, chatId: Schema.String }
  }),

  /**
   * Deliver the operator's verdict on a pending Plannotator review to the
   * live session. The forked extension resolves its awaited review when the
   * reviewId matches; stale or duplicate decisions are ignored there.
   */
  Rpc.make("Plan.decide", {
    error: GitError,
    payload: {
      sessionId: Schema.String,
      chatId: Schema.String,
      reviewId: Schema.String,
      approved: Schema.Boolean,
      feedback: Schema.optional(Schema.String)
    }
  }),

  // ── Browser control (agent QA) ───────────────────────────────────────────────
  // The SAME embedded browser view as BrowserPreview, but driven by an AGENT
  // rather than the operator — so it can QA a preview URL in the browser the
  // operator is watching instead of spawning a headless Chrome out-of-band. Acts
  // on the single global view; every op reveals the dock first (see
  // PreviewViewService), which is the whole point: the agent works where the
  // operator can see it. The browser-control MCP server is what actually calls
  // these on the agent's behalf; the renderer never does.

  /** Navigate the browser to `url` (http/https only) and reveal the dock. */
  Rpc.make("BrowserControl.navigate", {
    error: BrowserControlError,
    payload: { sessionId: Schema.String, chatId: Schema.String, url: Schema.String }
  }),

  /** A PNG screenshot of the current page, base64-encoded — the agent's eyes. */
  Rpc.make("BrowserControl.screenshot", {
    success: Schema.Struct({ pngBase64: Schema.String }),
    error: BrowserControlError,
    payload: { sessionId: Schema.String, chatId: Schema.String }
  }),

  /** Click the first element matching `selector`. Fails if nothing matches. */
  Rpc.make("BrowserControl.click", {
    error: BrowserControlError,
    payload: { sessionId: Schema.String, chatId: Schema.String, selector: Schema.String }
  }),

  /**
   * Type `text` into the first element matching `selector` (focus, set value,
   * dispatch an `input` event so frameworks notice). Fails if nothing matches.
   */
  Rpc.make("BrowserControl.type", {
    error: BrowserControlError,
    payload: {
      sessionId: Schema.String,
      chatId: Schema.String,
      selector: Schema.String,
      text: Schema.String
    }
  }),

  /** The page's visible text (`document.body.innerText`), for the agent to read. */
  Rpc.make("BrowserControl.readText", {
    success: Schema.Struct({ text: Schema.String }),
    error: BrowserControlError,
    payload: { sessionId: Schema.String, chatId: Schema.String }
  }),

  /** Evaluate `expression` in the page and return its `String(...)` result. */
  Rpc.make("BrowserControl.evaluate", {
    success: Schema.Struct({ result: Schema.String }),
    error: BrowserControlError,
    payload: { sessionId: Schema.String, chatId: Schema.String, expression: Schema.String }
  }),

  /** Resolve once `selector` appears in the DOM, or fail after `timeoutMs`. */
  Rpc.make("BrowserControl.waitForSelector", {
    error: BrowserControlError,
    payload: {
      sessionId: Schema.String,
      chatId: Schema.String,
      selector: Schema.String,
      timeoutMs: Schema.Number
    }
  }),

  // ── Assets ───────────────────────────────────────────────────────────────────
  // Files an agent left in a session's worktree, opened as tabs in the Preview
  // dock. `path` is always WORKTREE-RELATIVE and always untrusted — it comes out
  // of agent output. Main resolves it against the session's own worktree and
  // refuses anything that escapes; the renderer's copy of `absolutePath` is for
  // display and Finder only, never an authority for a read.

  /**
   * Read one asset's contents. Returns a payload discriminated on `kind`: text
   * for markdown/code/text/csv, base64 for images, and metadata only for PDFs
   * (whose bytes never cross this boundary — Chromium loads them off disk).
   */
  Rpc.make("Asset.read", {
    success: AssetPayload,
    error: Schema.Union(
      AssetOutsideWorktreeError,
      AssetBinaryError,
      AssetTooLargeError,
      AssetUnsupportedError,
      SessionNotFoundError
    ),
    payload: { sessionId: Schema.String, path: Schema.String }
  }),

  /** Replace one existing UTF-8 text asset if its loaded revision is current. */
  Rpc.make("Asset.write", {
    success: AssetWriteResult,
    error: Schema.Union(
      AssetOutsideWorktreeError,
      AssetBinaryError,
      AssetTooLargeError,
      AssetWriteConflictError,
      AssetWriteIoError,
      SessionNotFoundError
    ),
    payload: {
      sessionId: Schema.String,
      path: Schema.String,
      text: Schema.String,
      expectedRevision: Schema.String
    }
  }),

  /** Reveal the asset in the OS file manager. */
  Rpc.make("Asset.reveal", {
    error: Schema.Union(AssetOutsideWorktreeError, SessionNotFoundError),
    payload: { sessionId: Schema.String, path: Schema.String }
  }),

  /**
   * Show a PDF at `bounds`, in Chromium's own viewer, in a native view over the
   * renderer. That is why the app ships no pdf.js.
   *
   * Takes `sessionId` + a worktree-relative `path` rather than a URL on purpose:
   * main resolves the absolute path itself, through the same containment check
   * that guards a read. A renderer holding a doctored payload therefore cannot
   * point the viewer at an arbitrary file on disk.
   */
  Rpc.make("Asset.openPdf", {
    error: Schema.Union(
      AssetOutsideWorktreeError,
      // Not just containment: main re-checks that the path is a PDF and a
      // regular file, because the native view renders a `file://` DOCUMENT and
      // an agent-authored `.html` there would get a file origin.
      AssetUnsupportedError,
      SessionNotFoundError,
      BrowserPreviewError
    ),
    payload: {
      sessionId: Schema.String,
      path: Schema.String,
      bounds: BrowserBounds
    }
  }),

  /** Keep a session-owned PDF aligned with its Files placeholder. */
  Rpc.make("Asset.setPdfBounds", {
    payload: { sessionId: Schema.String, bounds: BrowserBounds }
  }),

  /** Hide only the named session's PDF without affecting Preview or split panes. */
  Rpc.make("Asset.hidePdf", { payload: { sessionId: Schema.String } }),

  // ── Themes ─────────────────────────────────────────────────────────────────

  /**
   * Everything installed: bundled presets plus `~/jingler/themes/*.json`.
   *
   * Never errors. A malformed user file arrives in `skipped` alongside the
   * themes that did load — one bad file must not empty the picker, and the
   * operator needs both to keep switching themes AND to be told which file is
   * broken.
   *
   * Each summary carries its fully-resolved `tokens`, so the settings grid can
   * paint nine live previews from one call rather than nine.
   */
  Rpc.make("Theme.list", {
    success: ThemeCatalog
  }),

  /**
   * The raw VS Code theme JSON for `id` — what the editor loads and what
   * "export" would write. Null when the id names nothing.
   */
  Rpc.make("Theme.get", {
    success: Schema.NullOr(VsCodeTheme),
    payload: { id: Schema.String }
  }),

  /**
   * Write a user theme. Fails on a built-in id: presets stay immutable so the
   * fallback always has something to fall back to (duplicate one instead).
   */
  Rpc.make("Theme.save", {
    success: ThemeSummary,
    error: ThemeError,
    payload: { id: Schema.String, theme: VsCodeTheme }
  }),

  /** Delete a user theme. Fails on a built-in; a missing file is success. */
  Rpc.make("Theme.delete", {
    error: ThemeError,
    payload: { id: Schema.String }
  }),

  /**
   * Copy any theme to a new editable user theme — the only route from a
   * built-in to something the colour picker can write to.
   */
  Rpc.make("Theme.duplicate", {
    success: ThemeSummary,
    error: ThemeError,
    payload: { id: Schema.String, name: Schema.optional(Schema.String) }
  }),

  /**
   * Import pasted VS Code theme JSON. The error names the offending key rather
   * than saying "invalid theme" — the realistic input is a marketplace theme
   * and the realistic failure is one bad key in nine hundred.
   */
  Rpc.make("Theme.import", {
    success: ThemeSummary,
    error: ThemeError,
    payload: { json: Schema.String, name: Schema.optional(Schema.String) }
  }),

  /** Persist the active theme, keeping any colour customizations layered on it. */
  Rpc.make("Theme.setActive", {
    success: WorkspaceConfig,
    error: ConfigError,
    payload: { id: Schema.String }
  }),

  /**
   * Replace the override layer — Jingler's `workbench.colorCustomizations`.
   * Keyed by VS Code colour name, so an override survives switching themes and
   * stays portable back to VS Code.
   */
  Rpc.make("Theme.setCustomizations", {
    success: WorkspaceConfig,
    error: ConfigError,
    payload: {
      colors: Schema.Record({ key: Schema.String, value: Schema.String })
    }
  }),

  /**
   * Re-emits the whole catalog whenever `~/jingler/themes` changes on disk, so
   * editing a theme in your own editor repaints the app live.
   *
   * The whole catalog rather than a per-file delta: the consumers are a grid
   * that renders the full list and a provider that needs to know whether the
   * ACTIVE theme just moved. Both would have to rebuild the list from deltas
   * anyway, and would drift the first time an event was dropped.
   */
  Rpc.make("Theme.watch", {
    success: ThemeCatalog,
    stream: true
  }),

  /**
   * Reveal a user theme's file in the OS file manager.
   *
   * The whole premise of storing themes as files is that you can open one in
   * your own editor — but only if you can find it. Confined to the themes
   * directory in the handler, so this cannot become a general "reveal any path"
   * primitive by accident.
   */
  Rpc.make("Theme.reveal", {
    payload: { path: Schema.String }
  }),

  // ── Plugins ──────────────────────────────────────────────────────────────────
  // The installed-plugin surface. The registry (list/watch/enable/install) mirrors
  // the theme surface exactly — a directory of manifests, re-emitted whole on every
  // change. The rest (invoke/events/storage/auth) is the extension-host boundary:
  // command dispatch, the host→renderer push stream, per-plugin storage, and the
  // consent-gated credential grants. No `Plugins.*` success schema carries a token;
  // credentials live in the host and only `AuthSessionInfo` metadata ever crosses.

  /**
   * Every plugin directory under `~/jingler/plugins`, decoded.
   *
   * Never errors, for the reason `Theme.list` doesn't: one malformed manifest
   * arrives in `catalog.failed` beside the plugins that loaded, so a single bad
   * `jingler.plugin.json` can inform the operator without emptying the list.
   */
  Rpc.make("Plugins.list", {
    success: PluginCatalog
  }),

  /**
   * Re-emit the whole catalog whenever `~/jingler/plugins` changes on disk, so
   * dropping in (or editing) a plugin folder updates Settings live.
   *
   * The whole catalog rather than a per-file delta — the same reasoning as
   * `Theme.watch`, and served with the same `Stream.unwrap(Effect.map(…))` shape
   * in the handler (the accessor form silently yields a stream-of-one-stream).
   */
  Rpc.make("Plugins.watch", {
    success: PluginCatalog,
    stream: true
  }),

  /**
   * Enable or disable a plugin. Disabled plugins stay in the catalog (the
   * operator can turn them back on) but contribute nothing and never activate.
   * Persisted in `WorkspaceConfig`, so the choice survives a restart.
   */
  Rpc.make("Plugins.setEnabled", {
    error: PluginError,
    payload: { pluginId: PluginId, enabled: Schema.Boolean }
  }),

  /** Remove a plugin's directory. Fails `PluginError` for a built-in or unknown id. */
  Rpc.make("Plugins.uninstall", {
    error: PluginError,
    payload: { pluginId: PluginId }
  }),

  /** Reveal a plugin's directory in the OS file manager (confined to `pluginsDir`). */
  Rpc.make("Plugins.reveal", {
    error: PluginError,
    payload: { pluginId: PluginId }
  }),

  /**
   * Deactivate then re-activate a plugin's host half — the development loop for a
   * plugin author editing `main`. Served by the extension host.
   */
  Rpc.make("Plugins.reload", {
    error: PluginError,
    payload: { pluginId: PluginId }
  }),

  /**
   * Start a plugin's host half because one of its `activationEvents` fired.
   *
   * ## Why this exists at all
   *
   * `activate()` used to be reachable only from `invoke()`. That made
   * `activationEvents` decorative: `onTab:<id>` appeared to work because a plugin
   * tab's first render usually calls `host.invoke(...)`, which activates lazily
   * on the way past — and `onStartupFinished` never fired at any point, so a
   * plugin whose whole job was to subscribe to session events in `activate` never
   * ran a line of code. The docs said otherwise.
   *
   * Idempotent, and cheap when it is a no-op: the runtime tracks what it has
   * activated and joins an in-flight activation rather than starting a second.
   * That matters because the renderer calls this on every plugin-tab switch.
   *
   * A plugin with no `main` resolves without spawning anything.
   */
  Rpc.make("Plugins.activate", {
    error: PluginError,
    payload: { pluginId: PluginId }
  }),

  /**
   * Copy a folder into `~/jingler/plugins` and load it, returning the installed
   * plugin. The source is validated as a real plugin (a decodable manifest)
   * before anything is copied, so a bad folder fails without leaving a partial
   * directory behind.
   *
   * Takes a path the CALLER already has. Settings uses
   * {@link Plugins.installFromPicker} instead, which chooses the path natively.
   */
  Rpc.make("Plugins.installFromFolder", {
    success: LoadedPlugin,
    error: PluginError,
    payload: { sourcePath: Schema.String }
  }),

  /**
   * Show a native folder picker and install whatever the operator chooses.
   *
   * Succeeds with `null` when the picker is cancelled — cancelling is a normal
   * outcome, not an error, and modelling it as one would make Settings show a
   * failure toast for closing a dialog.
   *
   * ## Why the picker lives behind the RPC rather than in the renderer
   *
   * `showOpenDialog` is main-only, so *something* has to cross the boundary. The
   * choice is whether the renderer gets a general "open a folder picker" call and
   * then passes the result to `installFromFolder`, or whether pick-and-install is
   * one atomic operation. It is one operation here because the renderer is a
   * realm plugin UI also runs in: a general picker exposed to it is a picker
   * anything in that realm could open and read a path from, and the path it
   * returns is a filesystem location the operator selected. Fusing the two means
   * the only thing the renderer can do with the picker is install a plugin.
   */
  Rpc.make("Plugins.installFromPicker", {
    success: Schema.NullOr(LoadedPlugin),
    error: PluginError
  }),

  /**
   * Dispatch a command to a plugin's host half and return its result. The renderer
   * side of the command palette / keybinding path. `arg` is the command's opaque
   * argument; the result is whatever the plugin returned, unvalidated JSON.
   *
   * Served by the extension host.
   */
  Rpc.make("Plugins.invoke", {
    success: Schema.Unknown,
    error: PluginError,
    payload: {
      pluginId: PluginId,
      commandId: Schema.String,
      arg: Schema.optional(Schema.Unknown)
    }
  }),

  /**
   * The host→renderer push stream: `Emitted` topic messages, and the lazy
   * `Activated` / `ActivationFailed` lifecycle. One multiplexed stream for the
   * window, tagged by `pluginId` so the renderer fans it back out.
   *
   * Served by the extension host.
   */
  Rpc.make("Plugins.events", {
    success: PluginEvent,
    stream: true
  }),

  /**
   * Read a value from a plugin's private key/value store. Null when unset. The
   * value is opaque JSON — Jingler persists it without interpreting it.
   */
  Rpc.make("Plugins.storageGet", {
    success: Schema.NullOr(Schema.Unknown),
    payload: { pluginId: PluginId, key: Schema.String }
  }),

  /** Write a value into a plugin's private key/value store. */
  Rpc.make("Plugins.storageSet", {
    error: PluginError,
    payload: { pluginId: PluginId, key: Schema.String, value: Schema.Unknown }
  }),

  /**
   * Remove a key from a plugin's store.
   *
   * Distinct from writing `null`: a key present with a null value still shows up
   * in `storageKeys`, so folding delete into set would make the two disagree.
   */
  Rpc.make("Plugins.storageDelete", {
    error: PluginError,
    payload: { pluginId: PluginId, key: Schema.String }
  }),

  /** Every key currently set for a plugin. Empty when the store has never been written. */
  Rpc.make("Plugins.storageKeys", {
    success: Schema.Array(Schema.String),
    payload: { pluginId: PluginId }
  }),

  /**
   * Generated settings state for one plugin. Ordinary values are returned in
   * `values`; secret settings cross the renderer boundary only as configured
   * booleans in `secrets`.
   */
  Rpc.make("Plugins.settingsGet", {
    success: PluginSettingsSnapshot,
    error: PluginError,
    payload: { pluginId: PluginId }
  }),

  /** Persist a manifest-declared ordinary setting after main-process validation. */
  Rpc.make("Plugins.settingSet", {
    error: PluginError,
    payload: {
      pluginId: PluginId,
      settingId: ContributionId,
      value: PluginSettingValue
    }
  }),

  /** Store or replace a secret. No success payload contains the submitted value. */
  Rpc.make("Plugins.secretSet", {
    error: PluginError,
    payload: {
      pluginId: PluginId,
      settingId: ContributionId,
      value: Schema.String
    }
  }),

  /** Remove a secret setting without reading it back through the renderer. */
  Rpc.make("Plugins.secretClear", {
    error: PluginError,
    payload: { pluginId: PluginId, settingId: ContributionId }
  }),

  /** Enabled manifest-declared providers available to the new-session flow. */
  Rpc.make("Plugins.issueProviders", {
    success: Schema.Array(IssueProviderDescriptor)
  }),

  /** Search normalized issues through the owning plugin's supervised host. */
  Rpc.make("Plugins.issueProviderList", {
    success: Schema.Array(IssueSummary),
    error: PluginError,
    payload: {
      providerId: Schema.String,
      repository: Schema.Struct({ name: Schema.String, path: Schema.String }),
      search: Schema.String,
      mine: Schema.Boolean
    }
  }),

  /** Read one normalized issue through the owning plugin's supervised host. */
  Rpc.make("Plugins.issueProviderGet", {
    success: Schema.NullOr(IssueDetail),
    error: PluginError,
    payload: {
      providerId: Schema.String,
      repository: Schema.Struct({ name: Schema.String, path: Schema.String }),
      issueId: Schema.String
    }
  }),

  /** Create an issue without exposing provider credentials or raw responses. */
  Rpc.make("Plugins.issueProviderCreate", {
    success: IssueDetail,
    error: PluginError,
    payload: {
      providerId: Schema.String,
      repository: Schema.Struct({ name: Schema.String, path: Schema.String }),
      title: Schema.String,
      body: Schema.String
    }
  }),

  /** Add a normalized issue comment through the provider's host half. */
  Rpc.make("Plugins.issueProviderAddComment", {
    success: IssueComment,
    error: PluginError,
    payload: {
      providerId: Schema.String,
      repository: Schema.Struct({ name: Schema.String, path: Schema.String }),
      issueId: Schema.String,
      body: Schema.String
    }
  }),

  /**
   * The granted auth sessions, for the Settings list that lets the operator see
   * and revoke what each plugin holds. Returns metadata only — `AuthSessionInfo`
   * has no token field, and that absence is the security boundary, not an
   * omission (see `packages/core/src/plugin.ts`).
   */
  Rpc.make("Plugins.authSessions", {
    success: Schema.Array(AuthSessionInfo)
  }),

  /**
   * A plugin asking for credentials (plugin, provider, scopes). Prompts the
   * operator; returns the granted session's METADATA, or null if declined. The
   * token itself never crosses this boundary — it stays in the host.
   *
   * Served by the extension host.
   */
  Rpc.make("Plugins.authGrant", {
    success: Schema.NullOr(AuthSessionInfo),
    error: PluginError,
    payload: AuthSessionRequest
  }),

  /**
   * Revoke a plugin's session with one provider.
   */
  Rpc.make("Plugins.authRevoke", {
    error: PluginError,
    payload: { pluginId: PluginId, providerId: Schema.String }
  })
) {}

/** The complete server contract; split clients still share this one IPC surface. */
export const JinglerRpcs = JinglerCoreRpcs.merge(
  JinglerReviewRpcs,
  AssetListRpcs
)
