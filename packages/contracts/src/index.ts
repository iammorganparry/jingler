import {
  AdversarialReview,
  PlanError,
  HarnessBilling,
  PlanningReadiness,
  PlanRound,
  ArchiveReason,
  AssetPayload,
  AssetStat,
  Attachment,
  AuthProvider,
  AuthSession,
  BrowserBounds,
  CliInfo,
  CliKind,
  CreateSessionFromIssueInput,
  CreateSessionFromPrInput,
  CreateSessionInput,
  GateDecision,
  GhStatus,
  GigaplanRoutingConfig,
  GitConfig,
  GithubConfig,
  NotificationKind,
  NotificationsConfig,
  Issue,
  IssueAutomations,
  IssueSummary,
  ContextConfig,
  ContextSnapshot,
  Message,
  ModelOption,
  OpencodeProviderInfo,
  ExecutionMode,
  PermissionMode,
  PrFileChange,
  McpInjectionTarget,
  McpServerStatus,
  OpenConnectorConfig,
  OpenConnectorDefaults,
  ConnectorProvider,
  ConnectorProviderDetail,
  ConnectorConnection,
  ConnectorActionResult,
  OAuthClientInfo,
  PrMergeMethod,
  BackgroundTask,
  PrState,
  SessionPrStatus,
  PrSummary,
  ProviderConfig,
  ProviderModels,
  PullRequest,
  QuestionAnswer,
  ClaudeReasoningSetting,
  CodexReasoningSetting,
  ReasoningEffort,
  ReasoningSetting,
  Repo,
  ReviewComment,
  ReviewSubmitKind,
  Session,
  SessionPlanArtifact,
  SettledSessionStatus,
  Skill,
  StreamEvent,
  TerminalChunk,
  TerminalInfo,
  ThemeCatalog,
  ThemeSummary,
  Usage,
  VsCodeTheme,
  WorkspaceConfig
} from "@starbase/core"
import {
  AssetOutsideWorktreeError,
  AssetTooLargeError,
  AssetUnsupportedError,
  AuthError,
  BrowserPreviewError,
  ConfigError,
  ConnectorError,
  DiscoveryError,
  GhError,
  GitError,
  ReviewError,
  SessionNotFoundError,
  TerminalError,
  ThemeError,
  WorkspaceNotConfiguredError
} from "@starbase/core"
import { Rpc, RpcGroup } from "@effect/rpc"
import { Schema } from "effect"

/**
 * The Starbase RPC surface — a single source of truth shared by the Electron
 * main process (which implements the handlers as Effect services) and the
 * renderer (which calls them through a typed `RpcClient`). Transport is Electron
 * IPC; serialization is JSON. See `apps/desktop/src/main/rpc` for the wiring.
 */
export class StarbaseRpcs extends RpcGroup.make(
  /** List every known coding CLI and whether it is installed on this host. */
  /**
   * What each installed harness will actually be billed to.
   *
   * Read-only and cheap. Exists because the failure it reports was silent: an
   * exported API key overriding a paid subscription, with nothing on screen to
   * say so.
   */
  Rpc.make("Billing.paths", {
    success: Schema.Array(HarnessBilling)
  }),

  Rpc.make("Discovery.list", {
    success: Schema.Array(CliInfo),
    error: DiscoveryError
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

  /** Scan the configured repos directory for git repositories. */
  Rpc.make("Workspace.repos", {
    success: Schema.Array(Repo),
    error: WorkspaceNotConfiguredError
  }),

  /** List the local branch names for one repo (for the base-branch picker). */
  Rpc.make("Workspace.branches", {
    success: Schema.Array(Schema.String),
    error: GitError,
    payload: { repoPath: Schema.String }
  }),

  /** List a repo's tracked files (for the `@` code-reference menu). */
  Rpc.make("Workspace.files", {
    success: Schema.Array(Schema.String),
    error: GitError,
    payload: { repoPath: Schema.String }
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

  /** Create a session: fork an isolated git worktree, persist, and return it. */
  Rpc.make("Sessions.create", {
    success: Session,
    error: GitError,
    payload: CreateSessionInput
  }),

  /**
   * Create a session from an existing PR: land a worktree on the PR's head
   * branch (`gh pr checkout`), link `prNumber`, persist, and return it.
   */
  Rpc.make("Sessions.createFromPr", {
    success: Session,
    error: Schema.Union(GitError, GhError),
    payload: CreateSessionFromPrInput
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

  /** Link a GitHub issue to a live session (attach flow); returns the updated session. */
  Rpc.make("Sessions.linkIssue", {
    success: Session,
    error: Schema.Union(GitError, SessionNotFoundError),
    payload: {
      sessionId: Schema.String,
      issue: IssueSummary,
      automations: IssueAutomations
    }
  }),

  /** Unlink the session's GitHub issue; returns the updated session. */
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
    payload: { sessionId: Schema.String, chatId: Schema.String, title: Schema.String }
  }),

  /** Close one chat; closing the last creates a fresh Chat 1 replacement. */
  Rpc.make("Sessions.closeChat", {
    success: Session,
    error: GitError,
    payload: { sessionId: Schema.String, chatId: Schema.String }
  }),

  /** Load a chat's persisted conversation transcript. */
  Rpc.make("Sessions.transcript", {
    success: Schema.Array(Message),
    payload: { sessionId: Schema.String, chatId: Schema.String }
  }),

  /** The session worktree's unified working diff, for the Changes rail. */
  Rpc.make("Sessions.diff", {
    success: Schema.String,
    payload: { id: Schema.String }
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
      /** Images the operator attached as context (optional; omitted → none). */
      images: Schema.optional(Schema.Array(Attachment)),
      /**
       * `orchestrator` runs the configured Gigaplan voice on its own durable
       * thread; absent keeps the ordinary session harness.
       */
      target: Schema.optional(Schema.Literal("session", "orchestrator")),
      /**
       * Per-turn override. Null deliberately means native default, which lets a
       * just-cleared composer value win even if its persistence RPC is in flight.
       */
      reasoning: Schema.optional(Schema.NullOr(ReasoningSetting))
    }
  }),

  /** Resolve a pending HITL approval gate (allow / deny / always). */
  Rpc.make("Agent.decideGate", {
    payload: {
      sessionId: Schema.String,
      chatId: Schema.String,
      gateId: Schema.String,
      decision: GateDecision
    }
  }),

  /** Submit answers to a pending AskUserQuestion group, resuming the agent. */
  Rpc.make("Agent.answerQuestion", {
    payload: {
      sessionId: Schema.String,
      chatId: Schema.String,
      requestId: Schema.String,
      answers: Schema.Array(QuestionAnswer)
    }
  }),

  /** Change a session's HITL permission mode (ask / accept-edits / auto / plan). */
  Rpc.make("Agent.setMode", {
    payload: { sessionId: Schema.String, chatId: Schema.String, mode: PermissionMode }
  }),

  /** Change the current provider's native thinking settings. */
  Rpc.make("Agent.setReasoning", {
    payload: Schema.Union(
      Schema.Struct({
        sessionId: Schema.String,
        cli: Schema.Literal("claude"),
        reasoning: Schema.optional(ClaudeReasoningSetting)
      }),
      Schema.Struct({
        sessionId: Schema.String,
        cli: Schema.Literal("codex", "opencode"),
        reasoning: Schema.optional(CodexReasoningSetting)
      })
    )
  }),

  /** Comment on a plan step (plan mode) — accumulates on the plan, doesn't resume. */
  Rpc.make("Agent.commentPlanStep", {
    payload: {
      sessionId: Schema.String,
      planId: Schema.String,
      stepId: Schema.String,
      body: Schema.String
    }
  }),

  /** Route the plan's open comments back to the agent as a revision, resuming planning. */
  Rpc.make("Agent.revisePlan", {
    payload: { sessionId: Schema.String, planId: Schema.String }
  }),

  /** Approve a plan — restore the exec mode and start execution. */
  Rpc.make("Agent.approvePlan", {
    payload: {
      sessionId: Schema.String,
      planId: Schema.String,
      executionMode: Schema.optional(ExecutionMode)
    }
  }),

  /**
   * Approve a plan whose original run is gone (stale, e.g. after a restart):
   * re-drive execution as a fresh run (restore the exec mode + prompt with the
   * plan embedded) and stream its events, like `Agent.run`.
   */
  Rpc.make("Agent.resumePlan", {
    success: StreamEvent,
    stream: true,
    payload: { sessionId: Schema.String, chatId: Schema.String, planId: Schema.String }
  }),

  /**
   * Change a session's harness and/or model (used on the next turn — a turn
   * already streaming finishes on the old one).
   *
   * Model and harness move together because a model id only means something to
   * the harness that offers it: `opus` is nonsense to Codex. Switching `cli`
   * also drops the session's `resumeId` (a Codex thread id is meaningless to
   * Claude) so the new harness starts a fresh thread.
   */
  Rpc.make("Agent.setHarness", {
    payload: {
      sessionId: Schema.String,
      chatId: Schema.String,
      cli: CliKind,
      model: Schema.String
    }
  }),

  /** Stop a running agent (denies any pending gate). */
  Rpc.make("Agent.stop", {
    payload: { sessionId: Schema.String, chatId: Schema.String }
  }),

  /**
   * Add input to a live Codex turn. Compaction temporarily defers it; harnesses
   * without native steering report unsupported so the renderer can stop/replay.
   */
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

  /**
   * The unified OpenConnector settings plus whether a bearer token is stored.
   * `hasToken` is a bool, never the token itself — the secret stays in the main
   * process, so the panel can show "configured" without the value crossing over.
   */
  Rpc.make("OpenConnector.get", {
    success: Schema.Struct({
      config: OpenConnectorConfig,
      hasToken: Schema.Boolean,
      /** Environment-aware onboarding defaults (dev = local, prod = hosted). */
      defaults: OpenConnectorDefaults
    }),
    error: ConfigError
  }),

  /**
   * One-click onboarding: apply the environment default. In a dev build this fills
   * the local endpoint + the shipped dev token and enables the feature; in a
   * packaged build it points at the hosted instance (token provisioned separately).
   */
  Rpc.make("OpenConnector.autoSetup", {
    success: Schema.Void,
    error: ConfigError
  }),

  /**
   * Save the settings and, optionally, the bearer token. `token` omitted leaves
   * the stored token untouched (a settings-only save); null/empty clears it; a
   * string replaces it. The token is write-only — it never comes back out.
   */
  Rpc.make("OpenConnector.set", {
    success: Schema.Void,
    error: ConfigError,
    payload: {
      config: OpenConnectorConfig,
      token: Schema.optional(Schema.NullOr(Schema.String))
    }
  }),

  /**
   * Live probe of the configured endpoint (regardless of the enabled toggles), so
   * the panel's "Test" button verifies the URL + token before switching it on.
   * Reuses the MCP status shape; never fails — an unreachable server is `failed`.
   */
  Rpc.make("OpenConnector.test", {
    success: McpServerStatus,
    error: ConfigError
  }),

  /**
   * What each harness would ACTUALLY be launched with — resolved through the same
   * `OpenConnectorService.injection(cli)` the runner calls, not re-derived from the
   * config in the renderer.
   *
   * Without this, "the tools reach every agent" was a claim the UI made and nothing
   * checked: the master switch, the per-harness opt-out, a missing token and a
   * harness with no run path all produce the same green settings screen. Each row
   * carries the reason it is off, so the answer is diagnosable rather than boolean.
   */
  Rpc.make("OpenConnector.injection", {
    success: Schema.Array(McpInjectionTarget),
    error: ConfigError
  }),

  // ── MCP Connector Center — browse + connect OpenConnector providers ─────────

  /** The provider catalog from the configured instance (`GET /v1/providers`). */
  Rpc.make("Connector.providers", {
    success: Schema.Array(ConnectorProvider),
    error: ConnectorError
  }),

  /**
   * ONE provider's connect-form shape (`GET /api/providers/{service}`), fetched
   * when its card is opened. Deliberately per-service: the equivalent list
   * endpoint inlines every action's JSON Schema for ~1,100 providers and is 5 MB.
   * Carries field NAMES and OAuth scopes, never a value.
   */
  Rpc.make("Connector.provider", {
    success: ConnectorProviderDetail,
    error: ConnectorError,
    payload: { service: Schema.String }
  }),

  /** The operator's established connections (`GET /api/connections`). No secrets. */
  Rpc.make("Connector.connections", {
    success: Schema.Array(ConnectorConnection),
    error: ConnectorError
  }),

  /** OAuth-client metadata per provider — whether client creds exist + the redirect URI. */
  Rpc.make("Connector.oauthConfigs", {
    success: Schema.Array(OAuthClientInfo),
    error: ConnectorError
  }),

  /**
   * Create/replace an api-key or custom-credential connection. `values` carries the
   * secret INBOUND only (renderer→main→OpenConnector); the result never echoes it.
   */
  Rpc.make("Connector.connect", {
    success: ConnectorActionResult,
    error: ConnectorError,
    payload: {
      service: Schema.String,
      authType: Schema.Literal("api_key", "custom_credential"),
      values: Schema.Record({ key: Schema.String, value: Schema.String }),
      connectionName: Schema.optional(Schema.String)
    }
  }),

  /** Remove a connection (`DELETE /api/connections/:service`). */
  Rpc.make("Connector.disconnect", {
    success: ConnectorActionResult,
    error: ConnectorError,
    payload: {
      service: Schema.String,
      connectionName: Schema.optional(Schema.String)
    }
  }),

  /** Store OAuth client id/secret for a provider — secret INBOUND only. */
  Rpc.make("Connector.setOauthConfig", {
    success: ConnectorActionResult,
    error: ConnectorError,
    payload: {
      provider: Schema.String,
      clientId: Schema.String,
      clientSecret: Schema.String,
      extra: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.String }))
    }
  }),

  /**
   * Begin an OAuth flow. The main process opens the provider consent URL in the
   * system browser; OpenConnector's own callback stores the grant, so the renderer
   * just re-polls `Connector.connections`. The URL is NOT returned (it may carry a
   * state secret) — success is a plain acknowledgement.
   */
  Rpc.make("Connector.startOauth", {
    success: ConnectorActionResult,
    error: ConnectorError,
    payload: {
      service: Schema.String,
      connectionName: Schema.optional(Schema.String)
    }
  }),

  /** List the models a harness supports (live from the provider; for the chip). */
  Rpc.make("Models.list", {
    success: Schema.Array(ModelOption),
    payload: { cli: CliKind }
  }),

  /**
   * Every installed harness with its models — the composer's model menu, which
   * lets the user switch provider by picking a model under its section. One
   * round trip instead of one per harness.
   */
  Rpc.make("Models.catalog", {
    success: Schema.Array(ProviderModels)
  }),

  /**
   * The providers opencode resolves for the user, and where each credential came
   * from — Settings · Providers. Live from the binary, because the answer is a
   * property of the USER's setup (env vars, `opencode auth login`,
   * `opencode.json`), not of Starbase.
   */
  Rpc.make("Opencode.listProviders", {
    success: Schema.Array(OpencodeProviderInfo),
    error: ConfigError
  }),

  /**
   * Store an API key for one opencode provider (e.g. `openrouter`).
   *
   * Writes to opencode's OWN credential file, exactly as `opencode auth login`
   * would — NOT to Starbase's `SecretStore`, which stays reserved for the
   * Starbase bearer token. A key added here therefore works in a bare `opencode`
   * shell too. Succeeds silently into `false` rather than erroring on a bad key:
   * opencode doesn't validate on write.
   */
  Rpc.make("Opencode.setAuth", {
    success: Schema.Boolean,
    error: ConfigError,
    payload: { providerId: Schema.String, key: Schema.String }
  }),

  /** Provider usage / rate-limit windows for the Usage & limits modal. */
  Rpc.make("Usage.get", {
    success: Usage
  }),

  /**
   * A session's context accounting — what the meter renders and what Settings
   * lists. Cheap enough to poll: it reads in-memory state plus the persisted
   * session, and never touches a harness.
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

  /** Per-session auto-compaction override (absent = follow the global setting). */
  Rpc.make("Sessions.setAutoCompact", {
    success: Session,
    error: GitError,
    payload: { id: Schema.String, autoCompact: Schema.NullOr(Schema.Boolean) }
  }),

  /** Detect the GitHub CLI (`gh`) and its authentication status. */
  Rpc.make("Gh.status", {
    success: GhStatus
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
   * Persist which harness NEW sessions start on. One standing answer, set in
   * Settings · Providers, in place of the New Session dialog's old select.
   */
  Rpc.make("Config.setDefaultCli", {
    success: WorkspaceConfig,
    error: ConfigError,
    payload: Schema.Struct({ cli: CliKind })
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

  /** Persist one CLI's provider defaults (model, mode, reasoning, …). */
  /** Turn learning from finished work on or off. Absent config ⇒ off. */
  /**
   * Which harness+model Gigaplan itself runs on.
   *
   * One fixed model rather than a per-message choice — the intelligence this
   * feature is for is spent choosing a model per PLAN STEP, which is the only
   * place the right answer varies.
   */
  Rpc.make("Config.setOrchestrator", {
    success: WorkspaceConfig,
    error: ConfigError,
    payload: { cli: CliKind, model: Schema.String }
  }),

  Rpc.make("Config.setGigaplanRouting", {
    success: WorkspaceConfig,
    error: ConfigError,
    payload: { routing: GigaplanRoutingConfig }
  }),

  Rpc.make("Config.setProvider", {
    success: WorkspaceConfig,
    error: ConfigError,
    payload: { cli: CliKind, provider: ProviderConfig }
  }),

  /**
   * Run an adversarial review of the session's linked PR: a reviewer agent runs
   * READ-ONLY in the session's worktree, on the configured review model (Fable by
   * default), and argues against the diff.
   *
   * De-duped on the PR head SHA — a run whose head matches the stored review
   * returns that review without spawning an agent, unless `force`. That is what
   * lets the auto-review trigger fire off a poll loop safely.
   */
  /**
   * Run an adversarial planning round: one flagship proposes a plan, a model
   * from a DIFFERENT lab attacks it, and the proposer answers.
   *
   * Streams rather than returning the plan, because the three phases take
   * minutes between them and each runs as a surfaced sub-agent — so the operator
   * watches "proposing / attacking / revising" happen instead of staring at one
   * spinner. The settled plan arrives as a `PlanProposed` event and folds into
   * the transcript through the same path a single-agent plan does.
   */
  Rpc.make("Plan.adversarial", {
    success: StreamEvent,
    stream: true,
    error: PlanError,
    payload: {
      sessionId: Schema.String,
      chatId: Schema.String,
      /**
       * An explicit brief is retained for automation/tests. The composer omits it
       * so main derives the handoff from the accumulated intake transcript.
       */
      brief: Schema.optional(Schema.String),
      /**
       * Screenshots attached to the brief (optional; omitted → none).
       *
       * A brief is very often "make it look like this" — the round used to have
       * no image channel at all, so the composer had to refuse attachments in
       * Gigaplan mode. Every role sees them, because a critic judging a plan
       * drawn from a screenshot it cannot see is judging the wrong thing.
       */
      images: Schema.optional(Schema.Array(Attachment))
    }
  }),

  /**
   * The last planning round for a session, or null — the audit trail behind a
   * plan, holding the pre-revision proposal beside the critique. Never errors:
   * a missing or stale round costs an unavailable audit trail, not a broken tab.
   */
  Rpc.make("Plan.round", {
    success: Schema.NullOr(PlanRound),
    payload: { sessionId: Schema.String }
  }),

  /** The structured plan shared by every chat in this session. */
  Rpc.make("Plan.current", {
    success: Schema.NullOr(SessionPlanArtifact),
    payload: { sessionId: Schema.String }
  }),

  /**
   * Whether adversarial planning is worth offering here, and if not, what would
   * fix it.
   *
   * The renderer needs the REASON, not just a boolean: the entry is rendered
   * disabled with an explanation rather than hidden, so a user with one provider
   * learns why and what to install instead of never discovering the feature.
   */
  Rpc.make("Plan.readiness", {
    success: PlanningReadiness,
    payload: {}
  }),

  /**
   * Run an approved plan, step by step, each on the harness it was assigned.
   *
   * A stream for the same reason `Agent.run` is: the operator watches steps go
   * past as subagents. Takes only the plan's ID — main reads the artifact back
   * from the session's transcript, because the renderer's copy may have been
   * edited on screen and executing anything other than what was approved would
   * make the audit trail a lie.
   */
  Rpc.make("Plan.execute", {
    success: StreamEvent,
    error: PlanError,
    payload: {
      sessionId: Schema.String,
      planId: Schema.String,
      executionMode: Schema.optional(ExecutionMode)
    },
    stream: true
  }),

  Rpc.make("Review.run", {
    success: AdversarialReview,
    error: ReviewError,
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
   * The pull request linked to a session (its `prNumber`), assembled from `gh pr
   * view`. Null when the session has no worktree or no linked PR. Embeds CI
   * checks, reviewers, and the review timeline for the Pull Request tab.
   */
  Rpc.make("Github.pr", {
    success: Schema.NullOr(PullRequest),
    error: GhError,
    payload: { sessionId: Schema.String }
  }),

  /**
   * List open PRs for a repo (for the "new session from a PR" picker). `mine`
   * filters to the authenticated user; `search` is a free-text query. Never
   * errors — folds to an empty list.
   */
  Rpc.make("Github.listPrs", {
    success: Schema.Array(PrSummary),
    payload: {
      repoPath: Schema.String,
      mine: Schema.Boolean,
      search: Schema.String
    }
  }),

  /**
   * List open issues for a repo (for the "new session from an issue" picker +
   * attach dialog). `mine` filters to issues assigned to you. Never errors —
   * folds to an empty list.
   */
  Rpc.make("Github.listIssues", {
    success: Schema.Array(IssueSummary),
    payload: {
      repoPath: Schema.String,
      mine: Schema.Boolean,
      search: Schema.String
    }
  }),

  /** Close the session's linked issue (close-on-merge automation). */
  Rpc.make("Github.closeIssue", {
    error: GhError,
    payload: { sessionId: Schema.String }
  }),

  /** The full linked-issue view model for the session's Issue tab (null if none). */
  Rpc.make("Github.issue", {
    success: Schema.NullOr(Issue),
    error: GhError,
    payload: { sessionId: Schema.String }
  }),

  /**
   * A session's linked PR reduced to what the sidebar row shows — its lifecycle
   * state plus a CI rollup. Polled per session on a timer, so it is deliberately
   * the cheapest PR read in the contract; `Github.pullRequest` is the rich one.
   */
  Rpc.make("Github.prState", {
    success: Schema.NullOr(SessionPrStatus),
    payload: { sessionId: Schema.String }
  }),

  /** The changed files of a session's PR, for the Code Review file list. */
  Rpc.make("Github.files", {
    success: Schema.Array(PrFileChange),
    payload: { sessionId: Schema.String }
  }),

  /** The unified diff of a session's PR vs its base branch. */
  Rpc.make("Github.diff", {
    success: Schema.String,
    payload: { sessionId: Schema.String }
  }),

  /**
   * Detect a PR already open on the session's branch, link it (persist
   * `prNumber`), and return its number (null if none).
   */
  Rpc.make("Github.detectPr", {
    success: Schema.NullOr(Schema.Number),
    payload: { sessionId: Schema.String }
  }),

  /** Open a PR from the session's branch and link it; returns the PR number. */
  Rpc.make("Github.createPr", {
    success: Schema.Number,
    error: GhError,
    payload: {
      sessionId: Schema.String,
      title: Schema.String,
      body: Schema.String,
      base: Schema.String,
      draft: Schema.Boolean
    }
  }),

  /**
   * Post a top-level comment on the session's PR. `toGithub` gates the actual
   * `gh pr comment` write (the renderer separately routes the body to the agent).
   */
  Rpc.make("Github.comment", {
    error: GhError,
    payload: { sessionId: Schema.String, body: Schema.String, toGithub: Schema.Boolean }
  }),

  /**
   * Submit the reviewer's drafts to the session's PR as a COMMENT review
   * carrying real, line-anchored inline comments.
   *
   * Distinct from `Github.comment` (one top-level blob) and `Github.review` (a
   * body and nothing else): this is the only path that produces inline threads,
   * so a comment written in Starbase comes back from GitHub on the same line.
   *
   * Returns how many drafts couldn't be anchored to a line in the PR's current
   * diff — those are folded into the review body rather than dropped, so a
   * non-zero count is informational, not a failure.
   */
  Rpc.make("Github.submitReview", {
    success: Schema.Number,
    error: GhError,
    payload: { sessionId: Schema.String, comments: Schema.Array(ReviewComment) }
  }),

  /** Submit a review (comment / approve / request-changes) on the session's PR. */
  Rpc.make("Github.review", {
    error: GhError,
    payload: { sessionId: Schema.String, kind: ReviewSubmitKind, body: Schema.String }
  }),

  /**
   * Resolve / unresolve an inline review thread on the session's PR. `threadId`
   * is the GraphQL node id carried on `PrReviewThread.id`.
   */
  Rpc.make("Github.resolveThread", {
    error: GhError,
    payload: { sessionId: Schema.String, threadId: Schema.String, resolved: Schema.Boolean }
  }),

  /**
   * Reply to the inline review thread `commentId` belongs to. `commentId` is the
   * REST numeric id from `PrThreadComment.databaseId` (not the node id).
   */
  Rpc.make("Github.replyToThread", {
    error: GhError,
    payload: { sessionId: Schema.String, commentId: Schema.Number, body: Schema.String }
  }),

  /**
   * Merge the session's linked PR. `method` defaults to a merge commit; surfaces
   * `GhError` when GitHub rejects the merge (branch protection, conflicts, …).
   */
  Rpc.make("Github.merge", {
    error: GhError,
    payload: { sessionId: Schema.String, method: Schema.optional(PrMergeMethod) }
  }),

  /**
   * Flip the session's draft PR to "ready for review" (`gh pr ready`); surfaces
   * `GhError` when there is no linked PR or GitHub rejects it.
   */
  Rpc.make("Github.markReady", {
    error: GhError,
    payload: { sessionId: Schema.String }
  }),

  /**
   * Merge the base branch into the PR's head — GitHub's "Update branch", the fix
   * for a `BEHIND` merge state. Updates the REMOTE head only; the session's
   * worktree is deliberately left alone, since the agent may be mid-turn.
   * Surfaces `GhError` when there is no linked PR or GitHub rejects it.
   */
  Rpc.make("Github.updateBranch", {
    error: GhError,
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
    payload: { terminalId: Schema.String, cols: Schema.Number, rows: Schema.Number }
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
   * system browser. The flow completes via the `starbase://` deep link.
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
  // native view aligned. There is one preview view (the single window).

  /**
   * Show the preview view and load `url` at `bounds`. Only http/https URLs are
   * accepted (fails with `BrowserPreviewError` otherwise). Idempotent — reuses
   * the existing view if already open.
   */
  Rpc.make("BrowserPreview.open", {
    error: BrowserPreviewError,
    payload: { url: Schema.String, bounds: BrowserBounds }
  }),

  /** Reposition/resize the view to track the pane's rect (on layout/scroll). No-op if closed. */
  Rpc.make("BrowserPreview.setBounds", {
    payload: { bounds: BrowserBounds }
  }),

  /** Navigate the open view to a new URL. Fails with `BrowserPreviewError` for non-http(s). */
  Rpc.make("BrowserPreview.navigate", {
    error: BrowserPreviewError,
    payload: { url: Schema.String }
  }),

  /** Reload the current page. No-op if closed. */
  Rpc.make("BrowserPreview.reload", {}),

  /**
   * Show/hide the native view without destroying it — the Preview dock switching
   * away from the Browser tab. `close` would also hide it, but it discards the
   * page, its history and its scroll position with it.
   */
  Rpc.make("BrowserPreview.setVisible", {
    payload: { visible: Schema.Boolean }
  }),

  /** Hide + destroy the view (pane closed or session switched). Idempotent. */
  Rpc.make("BrowserPreview.close", {}),

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
      AssetTooLargeError,
      AssetUnsupportedError,
      SessionNotFoundError
    ),
    payload: { sessionId: Schema.String, path: Schema.String }
  }),

  /**
   * Cheap probe: does this path exist in the worktree and what would we render
   * it as? Used to decide whether a candidate path in the transcript is worth
   * making clickable without paying for its contents.
   */
  Rpc.make("Asset.stat", {
    success: Schema.NullOr(AssetStat),
    error: SessionNotFoundError,
    payload: { sessionId: Schema.String, path: Schema.String }
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
    error: Schema.Union(AssetOutsideWorktreeError, SessionNotFoundError, BrowserPreviewError),
    payload: { sessionId: Schema.String, path: Schema.String, bounds: BrowserBounds }
  }),

  /** Hide the PDF view without destroying it (the dock switched tabs). */
  Rpc.make("Asset.hidePdf", {}),

  // ── Themes ─────────────────────────────────────────────────────────────────

  /**
   * Everything installed: bundled presets plus `~/starbase/themes/*.json`.
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
   * Replace the override layer — Starbase's `workbench.colorCustomizations`.
   * Keyed by VS Code colour name, so an override survives switching themes and
   * stays portable back to VS Code.
   */
  Rpc.make("Theme.setCustomizations", {
    success: WorkspaceConfig,
    error: ConfigError,
    payload: { colors: Schema.Record({ key: Schema.String, value: Schema.String }) }
  }),

  /**
   * Re-emits the whole catalog whenever `~/starbase/themes` changes on disk, so
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
  })
) {}
