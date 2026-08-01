import { Schema } from "effect"
import { CLI_KINDS, CliKind } from "./cli.js"
import { BUDGET_RANGE, DEFAULT_BUDGET_TOKENS } from "./context.js"
import {
  PlanTemplateConfig,
  WorkerRoutingConfig
} from "./plan-document.js"
import { ThemeConfig } from "./theme.js"

/**
 * Domain schemas for Jingler. These are Effect `Schema`s so they can be reused
 * for RPC payload encode/decode, persistence, and runtime validation. The plain
 * TypeScript types are derived from the schemas via `Schema.Schema.Type`.
 */

// ── CLI discovery ────────────────────────────────────────────────────────────

export { CLI_KINDS, CliKind } from "./cli.js"

/** The outcome of probing for one CLI on the host. */
export const CliInfo = Schema.Struct({
  kind: CliKind,
  /** Human label, e.g. "Claude Code". */
  label: Schema.String,
  /** Resolved absolute path to the binary, or null when not found. */
  binPath: Schema.NullOr(Schema.String),
  /** Reported version string, or null when unknown / unavailable. */
  version: Schema.NullOr(Schema.String),
  available: Schema.Boolean,
  /**
   * Whether this harness exposes BACKGROUND TASKS the operator can see and stop
   * individually. Only Claude does today: it reports a live task set plus
   * per-task start/progress/settle signals and accepts a per-task stop. Codex and
   * OpenCode can only abort a whole turn, so the dock stays hidden for them
   * rather than offering a Stop button that cannot target anything.
   *
   * OPTIONAL for the same reason `ToolCall.output` is: this decodes persisted and
   * in-flight payloads written before the field existed, and a required field
   * would reject them.
   */
  backgroundTasks: Schema.optional(Schema.Boolean),
  /**
   * Whether this harness reports how much of the context window it is using, via
   * a `Usage` stream event. Claude, Codex and opencode do; Cursor has no headless
   * adapter and runs on the scripted fallback, so it reports nothing real.
   *
   * Gates BOTH the context meter and auto-compaction: a harness we cannot measure
   * is one we leave alone, with its own internal limit still the backstop. Showing
   * a meter fed by a fabricated number would be worse than showing none.
   *
   * OPTIONAL for the same reason `backgroundTasks` is: it decodes payloads
   * persisted before the field existed.
   */
  contextReporting: Schema.optional(Schema.Boolean),
  /**
   * Why an *installed* CLI is nonetheless unavailable — e.g. "opencode 1.0.220
   * found; Jingler needs ≥1.18". Absent when the CLI is usable, or simply not
   * installed (nothing to explain). Without this a too-old binary is
   * indistinguishable from a missing one, which is a miserable thing to debug.
   */
  note: Schema.optional(Schema.String)
})
export type CliInfo = Schema.Schema.Type<typeof CliInfo>

/** Which account an installed harness run is charged to. */
export const HarnessBilling = Schema.Struct({
  cli: CliKind,
  path: Schema.Literal("subscription", "api-key", "unknown", "undetermined"),
  keyWithheld: Schema.Boolean
})
export type HarnessBilling = Schema.Schema.Type<typeof HarnessBilling>

/** Harnesses a session can be started on. */
export const startableClis = (clis: ReadonlyArray<CliInfo>): ReadonlyArray<CliInfo> =>
  clis.filter((c) => c.available)

/**
 * Which harness a NEW session runs on: the configured default when it is still
 * installed, else the first available one, else null (nothing to run on).
 *
 * Single source of truth for a choice that used to live in the New Session
 * dialog as a select. The fallback matters — a config naming a harness the user
 * has since uninstalled must not wedge session creation.
 */
export const newSessionCli = (
  clis: ReadonlyArray<CliInfo>,
  defaultCli?: CliKind | null
): CliKind | null => {
  const startable = startableClis(clis)
  const configured = startable.find((c) => c.kind === defaultCli)
  return (configured ?? startable[0])?.kind ?? null
}

// ── Sessions ─────────────────────────────────────────────────────────────────

/** Lifecycle status of an agent session, mirrored in the sidebar pills. */
export const SessionStatus = Schema.Literal(
  "thinking",
  "running",
  "needs-input",
  "idle",
  "done"
)
export type SessionStatus = Schema.Schema.Type<typeof SessionStatus>

/**
 * The subset of `SessionStatus` that may be WRITTEN BACK to the store.
 *
 * A run lives in the main process and dies with the app, so persisting a busy
 * status ("thinking"/"running") would strand the session in it forever after a
 * restart — reporting work for a run that no longer exists. Keeping the invariant
 * in the type means the boundary enforces it, rather than every caller having to
 * remember. Live, in-flight state is `SessionActivity`, which is never persisted.
 */
export const SettledSessionStatus = Schema.Literal("idle", "needs-input")
export type SettledSessionStatus = Schema.Schema.Type<typeof SettledSessionStatus>

/** Added / removed line counts for a session's working diff. */
export const DiffStat = Schema.Struct({
  added: Schema.Number,
  removed: Schema.Number
})
export type DiffStat = Schema.Schema.Type<typeof DiffStat>

/**
 * Human-in-the-loop permission mode for a session:
 * - `ask` — pause for approval before every edit and command,
 * - `accept-edits` — auto-apply file edits, still pause for shell commands,
 * - `auto` — auto-apply edits and run allowlisted commands without prompting,
 * - `plan` — read-only planning: the agent designs a plan for review and cannot
 *   edit or run commands until the operator approves it (see `supportsPlanMode`).
 */
export const PermissionMode = Schema.Literal("ask", "accept-edits", "auto", "plan")
export type PermissionMode = Schema.Schema.Type<typeof PermissionMode>

/** Claude's provider-native adaptive-thinking effort values. */
export const ClaudeReasoningEffort = Schema.Literal("low", "medium", "high", "xhigh", "max")
export type ClaudeReasoningEffort = Schema.Schema.Type<typeof ClaudeReasoningEffort>

/** Codex's provider-native model reasoning effort values. */
export const CodexReasoningEffort = Schema.Literal("minimal", "low", "medium", "high", "xhigh")
export type CodexReasoningEffort = Schema.Schema.Type<typeof CodexReasoningEffort>

/**
 * Provider-native effort values accepted at the shared adapter boundary.
 *
 * Thinking being disabled is deliberately not an effort value. Providers model
 * it independently, and treating "off" as the bottom rung made it possible to
 * send incompatible combinations such as disabled thinking with maximum effort.
 */
export const ReasoningEffort = Schema.Literal(
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max"
)
export type ReasoningEffort = Schema.Schema.Type<typeof ReasoningEffort>

export const ReasoningSetting = Schema.Struct({
  enabled: Schema.Boolean,
  effort: Schema.optional(ReasoningEffort)
})
export type ReasoningSetting = Schema.Schema.Type<typeof ReasoningSetting>

export const ClaudeReasoningSetting = Schema.Struct({
  enabled: Schema.Boolean,
  effort: Schema.optional(ClaudeReasoningEffort)
})
export type ClaudeReasoningSetting = Schema.Schema.Type<typeof ClaudeReasoningSetting>

export const CodexReasoningSetting = Schema.Struct({
  enabled: Schema.Boolean,
  effort: Schema.optional(CodexReasoningEffort)
})
export type CodexReasoningSetting = Schema.Schema.Type<typeof CodexReasoningSetting>

export const SessionReasoning = Schema.Struct({
  claude: Schema.optional(ReasoningSetting),
  codex: Schema.optional(ReasoningSetting),
  opencode: Schema.optional(ReasoningSetting)
})
export type SessionReasoning = Schema.Schema.Type<typeof SessionReasoning>

/** Concrete harness permission modes that can execute an approved plan. */
export const ExecutionMode = Schema.Literal("ask", "accept-edits", "auto")
export type ExecutionMode = Schema.Schema.Type<typeof ExecutionMode>

/**
 * Whether a harness can hold a plan-mode turn.
 *
 * "Can" means two things, and a harness needs both: a way to be held read-only
 * while it thinks, and a channel to submit a plan through. Claude has a real
 * `ExitPlanMode` tool the adapter intercepts; Codex and opencode submit the same
 * plan protocol in a fenced reply. Cursor falls through to the scripted stub,
 * so offering plan mode there would fabricate support it does not have.
 *
 * A predicate rather than a scatter of `cli === "claude"` checks because the
 * gate is enforced in four places — the composer chip, the Shift+Tab cycle, and
 * the renderer AND main-process coercions on harness switch — and three of them
 * silently drop the mode instead of erroring, so a missed site looks like a bug
 * with no message.
 */
export const supportsPlanMode = (cli: CliKind): boolean =>
  cli === "claude" || cli === "codex" || cli === "opencode"

/**
 * Whether the harness can take new input INTO a live turn (`Agent.steer`).
 *
 * Claude (streaming-input `query()`) and Codex (`turn/steer`) both can; the rest
 * have no channel into a running turn, so a steer there is answered
 * `unsupported` and the renderer falls back to stop-and-replay.
 *
 * This gates the queue's automatic flush, which is why it is a predicate rather
 * than a try-it-and-see: auto-flushing into a harness that cannot steer would
 * KILL the running turn at every tool boundary, turning "your message will be
 * picked up shortly" into "your agent keeps getting interrupted".
 */
export const supportsSteer = (cli: CliKind): boolean =>
  cli === "claude" || cli === "codex"

/**
 * Whether a harness can run in fully-autonomous `auto` mode — no sandbox, no
 * per-action gate.
 *
 * `auto` is the default a fresh session lands in when the harness supports it,
 * because that is how the operator drives the CLI directly (unsandboxed, keychain
 * reachable, `gh`/`git push` "just work"). A harness that does NOT support it
 * falls back to `accept-edits`, where the sandbox stays on and any action needing
 * escalation is FORWARDED to the operator through the approval gate. Every harness
 * Jingler ships today supports `auto`; the predicate exists so a future harness
 * that cannot can opt out in one place.
 */
export const supportsAutoMode = (cli: CliKind): boolean =>
  cli === "claude" || cli === "codex" || cli === "cursor" || cli === "opencode"

/**
 * The mode a fresh session should start in: the operator's configured default
 * when they set one in settings, else `auto` where the harness supports it, else
 * `accept-edits` (sandbox on, permissions forwarded). The single source of truth
 * for "what does a new session default to", so creation and the runtime fallback
 * cannot drift.
 */
export const defaultModeFor = (
  cli: CliKind,
  configuredDefault?: PermissionMode
): PermissionMode =>
  configuredDefault ?? (supportsAutoMode(cli) ? "auto" : "accept-edits")

/**
 * Automations for a session linked to a GitHub issue (design I2 toggles).
 * Defined before `Session` so it can be referenced inline below.
 */
export const IssueAutomations = Schema.Struct({
  /** Post agent progress comments back to the linked issue as work happens. */
  progressComments: Schema.Boolean,
  /** Close the linked issue automatically when the session's PR merges. */
  closeOnMerge: Schema.Boolean
})
export type IssueAutomations = Schema.Schema.Type<typeof IssueAutomations>

/** A single agent session shown in the sidebar and opened in the main pane. */
/** One isolated conversation inside a session's shared worktree. */
export const ChatRole = Schema.Literal("direct", "orchestrator")
export type ChatRole = Schema.Schema.Type<typeof ChatRole>

export const Chat = Schema.Struct({
  id: Schema.String,
  /** Null until the first message provides an automatic title. */
  title: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  /** Provider thread identities belong to the chat, not the shared worktree. */
  resumeId: Schema.optional(Schema.String),
  /** Permission and model choices are restored independently for each chat. */
  /**
   * What this conversation is responsible for. Absent means `direct`, which
   * keeps sessions written before orchestration behaving exactly as they did.
   */
  role: Schema.optional(ChatRole),
  /**
   * Whether this orchestrator chat uses Jingler's worker flow. Per-chat so one
   * composer's toggle cannot change another conversation.
   */
  orchestratorEnabled: Schema.optional(Schema.Boolean),
  mode: Schema.optional(PermissionMode),
  allowlist: Schema.optional(Schema.Array(Schema.String)),
  model: Schema.optional(Schema.String),
  contextTokens: Schema.optional(Schema.Number)
})
export type Chat = Schema.Schema.Type<typeof Chat>
export type ChatId = Chat["id"]

/** Backward-compatible semantic role for a persisted chat. */
export const chatRoleOf = (chat: Pick<Chat, "role">): ChatRole =>
  chat.role ?? "direct"

/** How a session uses its repository checkout. */
export const WorkspaceMode = Schema.Literal("worktree", "direct")
export type WorkspaceMode = Schema.Schema.Type<typeof WorkspaceMode>

export const Session = Schema.Struct({
  id: Schema.String,
  /** owner/repo, e.g. "trigify/api". */
  repo: Schema.String,
  branch: Schema.String,
  title: Schema.String,
  status: SessionStatus,
  /** Which CLI is driving this session. */
  cli: CliKind,
  diff: DiffStat,
  /** Optional linked pull-request number. */
  prNumber: Schema.NullOr(Schema.Number),
  /** Optional linked GitHub issue number (drives the sidebar badge + banner). */
  issueNumber: Schema.optional(Schema.Number),
  /** Linked issue web URL (the banner "Open" link). */
  issueUrl: Schema.optional(Schema.String),
  /** Linked issue title (banner). */
  issueTitle: Schema.optional(Schema.String),
  /** Linked issue label chips (banner). Same shape as `PrLabel`. */
  issueLabels: Schema.optional(
    Schema.Array(Schema.Struct({ name: Schema.String, color: Schema.NullOr(Schema.String) }))
  ),
  /** Issue automation prefs (progress comments / close-on-merge). */
  automations: Schema.optional(IssueAutomations),
  /**
   * A one-shot prompt to seed the composer with the first time the session is
   * opened (e.g. the task derived from a linked issue). Cleared once consumed so
   * it never re-seeds; HITL — the user reviews and sends it themselves.
   */
  initialPrompt: Schema.optional(Schema.String),
  costUsd: Schema.Number,
  tokens: Schema.Number,
  /**
   * Tokens currently OCCUPYING the model's context window.
   *
   * Deliberately not `tokens`, which is the session's lifetime total and only
   * ever grows. This one goes both ways: a compaction is supposed to make it
   * fall, and that drop is the signal the feature worked. Folding the two into
   * one field would make a compaction look like negative usage on the sidebar,
   * and make the meter read a lifetime sum as though it were the working set.
   *
   * Absent on sessions written before compaction existed, which read as "not
   * measured yet" rather than "empty".
   */
  contextTokens: Schema.optional(Schema.Number),
  /** ISO-8601 last-activity timestamp. */
  updatedAt: Schema.String,
  /** Ordered conversations sharing this session's worktree and review state. */
  chats: Schema.Array(Chat),
  /** Recoverable conversations removed from the visible tab row, newest first. */
  closedChats: Schema.optional(Schema.Array(Chat)),
  /** The chat restored when the session is next opened. */
  activeChatId: Schema.String,
  /** Absolute path to the checkout this session works in. */
  worktreePath: Schema.optional(Schema.String),
  /**
   * Whether Jingler owns an isolated linked worktree or is using the repository's
   * primary checkout directly. Absent on legacy sessions, which are worktrees.
   */
  workspaceMode: Schema.optional(WorkspaceMode),
  /**
   * Whether this session should remain available across ordinary lifecycle
   * cleanup. Absent on legacy sessions, which are not persistent.
   */
  persistent: Schema.optional(Schema.Boolean),
  /**
   * Absolute path to the ORIGIN repo this session was forked from.
   *
   * Needed to clean up after a worktree whose directory no longer exists: git
   * is normally asked which repo owns a worktree by running it INSIDE that
   * worktree, which a deleted directory makes impossible. Without this, such a
   * worktree's registration can never be pruned and git keeps reporting it.
   *
   * Optional because sessions created before this existed do not carry it; the
   * cleanup then degrades to what it did before rather than failing.
   */
  repoPath: Schema.optional(Schema.String),
  /** The branch this session's worktree was forked from. */
  baseBranch: Schema.optional(Schema.String),
  /** Per-provider reasoning choices, retained when the session changes harness. */
  reasoning: Schema.optional(SessionReasoning),
  /**
   * Legacy single-chat aliases accepted during the rolling migration.
   * New code reads/writes the active `Chat`; `SessionStore` strips these on read.
   */
  resumeId: Schema.optional(Schema.String),
  mode: Schema.optional(PermissionMode),
  allowlist: Schema.optional(Schema.Array(Schema.String)),
  model: Schema.optional(Schema.String),
  reasoningEffort: Schema.optional(
    Schema.Union(
      ReasoningEffort,
      Schema.Literal("off", "think", "think-hard", "ultrathink")
    )
  ),
  /**
   * Per-session auto-compaction override. Absent = follow the global setting.
   *
   * Overrides in BOTH directions on purpose. A user mid-way through something
   * delicate may want one session pinned open with its full history intact, and
   * a user who left the global switch off may still want it on for the one
   * session that has been running all day.
   */
  autoCompact: Schema.optional(Schema.Boolean),
  /**
   * True only for sessions the agent auto-names (refreshed each turn). A manual
   * rename — or a title typed at creation — pins the name (false). Absent is
   * treated as pinned, so legacy/user-named sessions are never auto-overwritten.
   */
  autoTitle: Schema.optional(Schema.Boolean),
  /**
   * Whether the session is archived — set automatically once its linked PR is
   * merged or closed. Archived sessions are read-only (collapsed into the
   * "Archived" sidebar group) but never deleted; the user restores or deletes them.
   */
  archived: Schema.optional(Schema.Boolean),
  /** Why the session was archived (drives the "Merged"/"Closed" pill). */
  archiveReason: Schema.optional(Schema.Literal("merged", "closed")),
  /** ISO-8601 timestamp the session was archived (for the "2d ago" label). */
  archivedAt: Schema.optional(Schema.String)
})
export type Session = Schema.Schema.Type<typeof Session>

/** Backward-compatible workspace ownership for persisted sessions. */
export const workspaceModeOf = (
  session: Pick<Session, "workspaceMode">
): WorkspaceMode => session.workspaceMode ?? "worktree"

/** Backward-compatible persistence status for persisted sessions. */
export const persistentOf = (session: Pick<Session, "persistent">): boolean =>
  session.persistent ?? false

/** Why a session was archived — matches `Session.archiveReason`. */
export const ArchiveReason = Schema.Literal("merged", "closed")
export type ArchiveReason = Schema.Schema.Type<typeof ArchiveReason>

// ── Workspace ────────────────────────────────────────────────────────────────

/**
 * The user's GitHub integration preferences. Persisted inside `WorkspaceConfig`;
 * absent until the user configures the integration (so it stays optional there).
 */
export const GithubConfig = Schema.Struct({
  /** Master switch for the pull-request features (PR/Code Review tabs, writes). */
  enabled: Schema.Boolean,
  /** Open a PR automatically once a session's branch has pushable commits. */
  autoCreatePr: Schema.Boolean,
  /** Auto-detect a PR already open on a session's branch and link it. */
  autoDetectPr: Schema.Boolean,
  /**
   * Run an adversarial review automatically when a PR is opened or its head
   * advances. Off by default (a reviewer run costs real tokens); de-duped on the
   * PR head SHA so a poll loop can fire it safely. Absent on older configs.
   */
  autoAdversarialReview: Schema.optional(Schema.Boolean),
  /** Harness that runs the reviewer; absent = "claude". */
  reviewCli: Schema.optional(CliKind),
  /** Reviewer model id; absent = `DEFAULT_REVIEW_MODEL[reviewCli]` (Fable). */
  reviewModel: Schema.optional(Schema.String)
})
export type GithubConfig = Schema.Schema.Type<typeof GithubConfig>


/** The user's git behaviour preferences. Persisted inside `WorkspaceConfig`. */
export const GitConfig = Schema.Struct({
  /**
   * Allow opening a session from a PR whose head branch is already checked out
   * in another worktree (e.g. your main repo). When on, the session's worktree
   * shares the branch ref (`git checkout --ignore-other-worktrees`); when off,
   * git's safeguard is respected and the create fails with a clear error.
   */
  shareCheckedOutBranches: Schema.Boolean
})
export type GitConfig = Schema.Schema.Type<typeof GitConfig>

/**
 * What a desktop notification can be about.
 *
 * These are the moments a parallel operator cannot afford to miss while looking
 * at another session: the agent is BLOCKED on them, or it has stopped. Progress
 * is deliberately not among them — a notification per tool call would train the
 * operator to ignore the channel entirely.
 */
export const NotificationKind = Schema.Literal("needs-input", "done", "failed", "pr")
export type NotificationKind = Schema.Schema.Type<typeof NotificationKind>

/**
 * Desktop-notification preferences. Persisted inside `WorkspaceConfig`.
 *
 * Per-kind toggles rather than one switch: the kinds differ sharply in how
 * interruptive they earn the right to be, and an operator who mutes "done"
 * because it is noisy must not thereby lose "needs-input", which is the one that
 * actually costs them time when missed.
 */
export const NotificationsConfig = Schema.Struct({
  /** Master switch — off silences every kind regardless of the flags below. */
  enabled: Schema.Boolean,
  needsInput: Schema.Boolean,
  done: Schema.Boolean,
  failed: Schema.Boolean,
  /** A PR for one of your sessions was merged or closed. */
  pr: Schema.Boolean,
  /** Play the OS notification sound rather than showing it silently. */
  sound: Schema.Boolean
})
export type NotificationsConfig = Schema.Schema.Type<typeof NotificationsConfig>

/**
 * What notifications do when the operator has never chosen.
 *
 * On by default, because a notification the operator never asked for is a far
 * smaller harm than a blocked agent nobody noticed for an hour — which is the
 * whole reason the feature exists. Sound is the exception: it interrupts a room,
 * not just a screen, so it stays opt-in.
 */
export const NOTIFICATIONS_DEFAULT: NotificationsConfig = {
  enabled: true,
  needsInput: true,
  done: true,
  failed: true,
  pr: true,
  sound: false
}

/** Tone / verbosity preset for a harness's replies (Claude "output style"). */
export const OutputStyle = Schema.Literal("default", "explanatory", "concise")
export type OutputStyle = Schema.Schema.Type<typeof OutputStyle>

/**
 * Per-CLI provider defaults a new session inherits — the "Settings · Providers"
 * levers (design E10). Keyed by `CliKind` inside `WorkspaceConfig.providers`.
 * Only `defaultMode`/`defaultModel` are consumed at session creation today; the
 * remaining levers are persisted and surfaced in the settings view for future
 * adapter wiring.
 */
export const ProviderConfig = Schema.Struct({
  /** Whether this provider is offered when starting a session. */
  enabled: Schema.Boolean,
  /** Permission mode new sessions start in (maps to the harness `--permission-mode`). */
  defaultMode: PermissionMode,
  /** Default harness model id for new sessions; absent = the harness default. */
  defaultModel: Schema.optional(Schema.String),
  /**
   * Small/fast model for summaries & side tasks; absent = the harness default.
   *
   * Consumed by the context digest (`digestModelFor`), which runs through the
   * session's own harness binary — so the summary bills to the user's existing
   * subscription rather than any separate API credential.
   */
  backgroundModel: Schema.optional(Schema.String),
  /**
   * The model's context-window size in tokens, when Jingler can't infer it.
   *
   * Only route to auto-compaction for opencode, whose catalogue is resolved from
   * the user's own credentials across ~167 providers — there is no honest window
   * default to invent, so `contextWindowFor` reports unknown and compaction stays
   * off until the user says how big the window is. Also the escape hatch when a
   * harness ships a model whose window we don't know yet.
   */
  contextWindow: Schema.optional(Schema.Number),
  /** Whether extended thinking is enabled; absent preserves the provider default. */
  thinkingEnabled: Schema.optional(Schema.Boolean),
  /** Provider-native effort; absent = the harness default. */
  reasoningEffort: Schema.optional(ReasoningEffort),
  /** Reply tone/verbosity preset; absent = the harness default. */
  outputStyle: Schema.optional(OutputStyle),
  /**
   * Model ids to show in the composer's model menu; absent = show everything the
   * harness offers. Curation exists for opencode, whose catalogue is resolved
   * live from the user's own credentials and is enormous — a single OpenRouter
   * key alone yields ~342 models, which is unusable as a flat menu. Ids are
   * harness-native (for opencode, `provider/model`).
   *
   * The composer's menu ONLY (`Models.catalog`). It must never narrow a
   * CONFIGURATION surface such as Settings' default-model picker
   * (`Models.list`): a curation that could hide models from the screen you'd use
   * to change it is a one-way door — pick three, and the fourth can never be
   * chosen again from inside the app.
   *
   * No UI writes this yet; the picker that does lands separately. Until then a
   * hand-edited `config.json` is the only writer, which is exactly why the
   * one-way-door property matters.
   */
  visibleModels: Schema.optional(Schema.Array(Schema.String))
})
export type ProviderConfig = Schema.Schema.Type<typeof ProviderConfig>

/**
 * The harness/model pair that owns planning for every newly-created session.
 * This is deliberately a real `CliKind`, not a synthetic Jingler provider:
 * orchestration is a role Jingler layers over any planning-capable harness.
 */
export const OrchestratorPreference = Schema.Struct({
  cli: CliKind,
  model: Schema.String
})
export type OrchestratorPreference = Schema.Schema.Type<typeof OrchestratorPreference>

/** The effective route plus enough information for Settings to name a fallback. */
export const OrchestratorResolution = Schema.Struct({
  preference: OrchestratorPreference,
  isFallback: Schema.Boolean,
  fallbackReason: Schema.optional(Schema.String)
})
export type OrchestratorResolution = Schema.Schema.Type<typeof OrchestratorResolution>

/**
 * Where an opencode provider's credential came from. opencode resolves providers
 * from the user's own setup, and this says which part of it:
 *  - `env` — an environment variable they exported (`OPENROUTER_API_KEY`, …)
 *  - `api` — a key in opencode's own store, via `opencode auth login` or us
 *  - `config` — declared in their `opencode.json`
 *  - `custom` — opencode's built-in (e.g. the Zen gateway's free tier)
 *
 * Surfaced in Settings so it's obvious what is Jingler's doing and what is the
 * user's own — we never overwrite a credential we didn't put there.
 */
export const OpencodeProviderSource = Schema.Literal("env", "config", "custom", "api")
export type OpencodeProviderSource = Schema.Schema.Type<typeof OpencodeProviderSource>

/** One provider opencode resolves for the user — a row in Settings · Providers. */
export const OpencodeProviderInfo = Schema.Struct({
  /** opencode's provider id, e.g. "openrouter" — the first segment of a model id. */
  id: Schema.String,
  /** Display name, e.g. "OpenRouter". */
  name: Schema.String,
  /** Null when opencode reports no origin (i.e. it isn't configured). */
  source: Schema.NullOr(OpencodeProviderSource),
  /** Env vars this provider reads, so the UI can name the one to set. */
  env: Schema.Array(Schema.String),
  /** How many models it resolves — 0 means "integration present, no key". */
  modelCount: Schema.Number
})
export type OpencodeProviderInfo = Schema.Schema.Type<typeof OpencodeProviderInfo>

/**
 * Per-CLI provider defaults, keyed by `CliKind`. Partial — a config only carries
 * entries for the CLIs the user has actually customised (a literal-key record
 * would otherwise require every CLI to be present).
 */
export const ProvidersConfig = Schema.partial(
  Schema.Record({ key: CliKind, value: ProviderConfig })
)
export type ProvidersConfig = Schema.Schema.Type<typeof ProvidersConfig>

/**
 * The global auto-compaction levers, persisted at `WorkspaceConfig.context`.
 *
 * Lives here rather than beside the policy in `context.ts` because it is
 * CONFIG — and because `context.ts` may not import this module at runtime
 * without collapsing the schema graph (see the note on its `CliKind` import).
 */
export const ContextConfig = Schema.Struct({
  /** Master switch. Off returns the app to exactly its pre-feature behaviour. */
  auto: Schema.Boolean,
  /** Working-set budget in tokens, constrained to the usable quality band. */
  budgetTokens: Schema.Number.pipe(Schema.between(BUDGET_RANGE.min, BUDGET_RANGE.max))
})
export type ContextConfig = Schema.Schema.Type<typeof ContextConfig>

/** The shipped defaults — auto ON, maximum quality-band budget. */
export const DEFAULT_CONTEXT_CONFIG: ContextConfig = {
  auto: true,
  budgetTokens: DEFAULT_BUDGET_TOKENS
}

/**
 * The self-hosted OpenConnector instance every agent draws its MCP tools from.
 *
 * Jingler runs `claude` / `codex` / `cursor` / `opencode` as separate sessions,
 * each of which would otherwise have to configure MCP servers independently. This
 * points all of them at ONE central OpenConnector `/mcp` endpoint, so a provider
 * connected once (in OpenConnector's own console) is available to every agent.
 *
 * SECURITY: this struct is persisted to `config.json` and crosses the RPC
 * boundary, so it carries NO secret. The instance's bearer token lives only in
 * `SecretStore` (a sibling of the auth `auth.enc`) and is joined in at spawn.
 */
export const OpenConnectorConfig = Schema.Struct({
  /**
   * Base URL of the instance, without the `/mcp` suffix, e.g.
   * `https://mcp.internal`. The injected server targets `${endpoint}/mcp`.
   */
  endpoint: Schema.String,
  /** Master switch. Off means no agent receives the server, regardless of `perCli`. */
  enabled: Schema.Boolean,
  /**
   * The name the unified server is registered under in every harness. Stable so
   * repeated worktree writes stay idempotent and the Settings list is recognisable.
   */
  serverName: Schema.optionalWith(Schema.String, { default: () => "open-connector" }),
  /**
   * Per-harness opt-out. A CLI absent from the map defaults to ENABLED (when the
   * master switch is on); only an explicit `false` withholds the server from that
   * harness.
   *
   * Keyed by a bare string, not `CliKind`, on purpose: a `Record` over a literal
   * union is exhaustive under `Schema.encode` (every harness key would be
   * mandatory), which defeats the "absent ⇒ enabled" default. Lookups still pass a
   * `CliKind`, so the looser key costs no call-site safety.
   */
  perCli: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Boolean }))
})
export type OpenConnectorConfig = Schema.Schema.Type<typeof OpenConnectorConfig>

/** The default before an operator configures anything: present but switched off. */
export const OPEN_CONNECTOR_DEFAULT: OpenConnectorConfig = {
  endpoint: "",
  enabled: false,
  serverName: "open-connector"
}

/**
 * Environment-aware onboarding defaults for OpenConnector, resolved in the main
 * process (it alone knows `app.isPackaged`). The Settings panel prefills from these
 * and offers a one-click "Set up automatically":
 *
 * - `local` (dev builds) → the docker-compose instance on localhost, whose known
 *   dev token (`hasDevToken`) the app can fill in for the operator.
 * - `hosted` (packaged builds) → the Jingler-managed instance; the endpoint is
 *   filled but the token is provisioned separately (no shipped dev token).
 */
export const OpenConnectorDefaults = Schema.Struct({
  /** The default endpoint to prefill (no `/mcp` suffix). */
  endpoint: Schema.String,
  /** Which onboarding path applies to this build. */
  kind: Schema.Literal("local", "hosted"),
  /** True when the build ships a known token the app can auto-fill (dev only). */
  hasDevToken: Schema.Boolean
})
export type OpenConnectorDefaults = Schema.Schema.Type<typeof OpenConnectorDefaults>

/**
 * Persisted app configuration, stored at `~/jingler/config.json`. `reposDir` is
 * null until the user completes first-run setup by choosing a repos directory.
 */
export const WorkspaceConfig = Schema.Struct({
  /** Absolute path to the directory that contains the user's git repos. */
  reposDir: Schema.NullOr(Schema.String),
  /** ISO-8601 timestamp of when the config was first created. */
  createdAt: Schema.String,
  /**
   * Auto-compaction levers. Absent on configs written before the feature, which
   * `DEFAULT_CONTEXT_CONFIG` fills in — so existing users get it switched on
   * without having to find a setting.
   */
  context: Schema.optional(ContextConfig),
  /** GitHub integration prefs; absent until configured (older configs lack it). */
  github: Schema.optional(GithubConfig),
  /** Git behaviour prefs; absent until configured (older configs lack it). */
  git: Schema.optional(GitConfig),
  /**
   * Desktop-notification prefs. Absent on older configs, which means the
   * DEFAULTS apply (see `NOTIFICATIONS_DEFAULT`) rather than "off" — an operator
   * who never opened Settings should still be told when an agent needs them.
   */
  notifications: Schema.optional(NotificationsConfig),
  /**
   * Absolute paths of the repos the user has starred, so the New Session picker
   * can surface them first. Absent on older configs (treated as an empty list).
   */
  starredRepos: Schema.optional(Schema.Array(Schema.String)),
  /**
   * Absolute paths of the repos the user has collapsed in the sidebar (their
   * sessions hidden). The reserved sentinel `"__archived__"` collapses the
   * Archived group. Absent on older configs (treated as an empty list).
   */
  collapsedRepos: Schema.optional(Schema.Array(Schema.String)),
  /**
   * Absolute path of the repo used for the most recent session create, so the
   * New Session dialog can preselect it. Absent until the first create.
   */
  lastRepoPath: Schema.optional(Schema.String),
  /**
   * Per-CLI provider defaults (model, mode, reasoning, …) from the Settings ·
   * Providers view. Absent on older configs (each provider falls back to the
   * harness defaults).
   */
  providers: Schema.optional(ProvidersConfig),
  /**
   * Which harness new sessions start on.
   *
   * Chosen ONCE in Settings · Providers rather than per session: the New Session
   * dialog used to ask, and the answer was the same every time — a decision
   * surface masquerading as a form field.
   *
   * Absent, or naming a harness that is not installed, means "the first
   * available one", so a fresh install can still create sessions.
   */
  defaultCli: Schema.optional(CliKind),
  /**
   * The preferred planner for new sessions. Absent on legacy configs; the
   * resolver chooses the first installed planning-capable harness in that case.
   */
  orchestrator: Schema.optional(OrchestratorPreference),
  /**
   * Concrete implementation-worker routes by plan-stage complexity. Kept
   * separate from `orchestrator`: choosing a cheap planner must not silently
   * downgrade high-complexity implementation work.
   */
  workerRouting: Schema.optional(WorkerRoutingConfig),
  /** Custom PRD/MDX structure injected into every native planning turn. */
  planTemplate: Schema.optional(PlanTemplateConfig),
  /**
   * Whether a session in PLAN mode may run commands without stopping for
   * approval. Absent means ON (see `PLAN_AUTO_RUN_DEFAULT`).
   *
   * On by default because plan mode cannot write: the harness refuses edits, so
   * the commands a planning turn wants are reads — `git log`, `rg`, `gh pr view`.
   * Gating those turned every plan into a queue of approval prompts for actions
   * that cannot change anything, which is how operators learn to click "allow"
   * without reading. Edits still gate exactly as before, in every mode.
   */
  planAutoRun: Schema.optional(Schema.Boolean),
  /**
   * Whether a finished task's final summary is shaped for an ADHD reader —
   * lead with the action, number the steps, state final progress, end with one
   * next action. Absent means OFF (see `ADHD_MODE_DEFAULT`).
   *
   * Off by default because output shaping is a preference and not a safety
   * property. It is injected per turn as a prompt prefix (the same channel as
   * the compaction primer), but explicitly applies only when the task is done.
   */
  adhdMode: Schema.optional(Schema.Boolean),
  /**
   * Whether a session's orchestrator chat runs the agentic orchestrator flow.
   * Absent means ON (see `ORCHESTRATOR_ENABLED_DEFAULT`).
   *
   * On by default: the orchestrator is the point of the app — a natural planner
   * that acts on quick work itself, hands large work to worker agents, and never
   * re-gates an approved plan. Turned OFF, the orchestrator role is not used at
   * all: the orchestrator chat behaves like any plain chat on the session's own
   * harness (its own persona, its own mode/model chips, no forced plan turn), so
   * an operator who wants manual control leans on the source harness directly as
   * they did before the orchestrator existed. Read per turn, so flipping it
   * applies to the next message of an already-running session.
   */
  orchestratorEnabled: Schema.optional(Schema.Boolean),
  /**
   * Multiplier applied to conversation + code text size. Absent means 1
   * (`FONT_SCALE_DEFAULT`) — the unscaled default.
   *
   * Only the transcript and code blocks scale, not the app chrome, so the lever
   * is a single number fed to a `--sb-font-scale` CSS variable consumed by
   * `calc()`. Stored as the multiplier itself (e.g. 0.9 / 1 / 1.15 / 1.3) rather
   * than a preset name, so the renderer paints it with no lookup table.
   */
  fontScale: Schema.optional(Schema.Number),
  /**
   * The active colour theme, plus any per-key overrides on top of it.
   *
   * Absent means `DEFAULT_THEME_ID` (Jingler Dark) — which is also what every
   * config written before theming existed means. Only the CHOICE lives here;
   * the themes themselves are
   * bundled presets or files under `~/jingler/themes`, because a theme is
   * kilobytes of colour table and `config.json` is read on every settings save.
   */
  theme: Schema.optional(ThemeConfig),
  /**
   * The self-hosted OpenConnector instance all agents draw MCP tools from. Absent
   * on older configs, which means the feature is off (`OPEN_CONNECTOR_DEFAULT`);
   * the bearer token is NEVER stored here — it lives in `SecretStore`.
   */
  openConnector: Schema.optional(OpenConnectorConfig),
  /**
   * Ids of plugins the operator has turned OFF. Absent (or a missing id) means
   * enabled — the safe default, since a freshly-dropped-in plugin should work
   * without a settings visit.
   *
   * A disabled LIST rather than an enabled one so the set stays small and the
   * default needs no entry: the catalog is the source of truth for which plugins
   * exist, and this only records the exceptions. A plugin whose directory is
   * gone but whose id lingers here is harmless — nothing matches it.
   */
  disabledPlugins: Schema.optional(Schema.Array(Schema.String))
})
export type WorkspaceConfig = Schema.Schema.Type<typeof WorkspaceConfig>

/**
 * Resolve a stored orchestrator against the live, uncurated model catalogue.
 *
 * Catalogue order is discovery order, so the fallback is deterministic. A
 * provider default is preferred when it still exists; otherwise the provider's
 * first live model is used. `null` means this host has no planning-capable
 * harness/model pair and the caller must retain its existing no-provider
 * behaviour.
 */
export const resolveOrchestratorPreference = (
  config: Pick<WorkspaceConfig, "orchestrator" | "providers"> | null | undefined,
  catalog: ReadonlyArray<{
    readonly cli: CliKind
    readonly models: ReadonlyArray<{ readonly id: string }>
  }>
): OrchestratorResolution | null => {
  const planning = catalog.filter(
    (provider) =>
      supportsPlanMode(provider.cli) &&
      provider.models.length > 0 &&
      config?.providers?.[provider.cli]?.enabled !== false
  )
  const preferred = config?.orchestrator
  const exactProvider = preferred
    ? planning.find((provider) => provider.cli === preferred.cli)
    : undefined
  const exactModel = exactProvider?.models.find((model) => model.id === preferred?.model)
  if (preferred && exactModel) {
    return {
      preference: preferred,
      isFallback: false
    }
  }

  const provider = exactProvider ?? planning[0]
  if (!provider) return null
  const configuredModel = config?.providers?.[provider.cli]?.defaultModel
  const model =
    provider.models.find((candidate) => candidate.id === configuredModel) ??
    provider.models[0]
  if (!model) return null

  const preference = { cli: provider.cli, model: model.id }
  return {
    preference,
    isFallback: true,
    fallbackReason: preferred
      ? `Configured orchestrator ${preferred.cli}/${preferred.model} is unavailable; using ${preference.cli}/${preference.model}.`
      : `No orchestrator is configured; using ${preference.cli}/${preference.model}.`
  }
}

/** Plan mode runs its (read-only) commands unattended unless told otherwise. */
export const PLAN_AUTO_RUN_DEFAULT = true

/** ADHD response shaping is opt-in — it rewrites the voice of every session. */
export const ADHD_MODE_DEFAULT = false

/**
 * The agentic orchestrator flow is on by default — it is the product. Turning it
 * off drops sessions back to driving the source harness directly.
 */
export const ORCHESTRATOR_ENABLED_DEFAULT = true

/** Conversation + code text is unscaled (1×) unless the operator picks a size. */
export const FONT_SCALE_DEFAULT = 1

/**
 * The usable band for the conversation text-size multiplier. The contract
 * enforces it on the write path (`Config.setFontScale`); `clampFontScale` guards
 * the READ path, where a hand-edited `config.json` can carry anything.
 */
export const FONT_SCALE_RANGE = { min: 0.5, max: 2 } as const

/**
 * Coerce a stored/incoming multiplier into the usable band, mapping anything
 * non-finite (a hand-edited `NaN`, a missing value) back to the default. The one
 * place the range is applied, so a bad value can never scale the transcript to
 * zero or off-screen — on read or on write.
 */
export const clampFontScale = (value: number | null | undefined): number =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.min(FONT_SCALE_RANGE.max, Math.max(FONT_SCALE_RANGE.min, value))
    : FONT_SCALE_DEFAULT

/** A git repository discovered under the configured repos directory. */
export const Repo = Schema.Struct({
  /** Folder name, used as the sidebar group label (e.g. "trigify-app"). */
  name: Schema.String,
  /** Absolute path to the repo's working tree. */
  path: Schema.String,
  /** The repo's default branch (e.g. "main"), or null if it can't be resolved. */
  defaultBranch: Schema.NullOr(Schema.String),
  /** The branch currently checked out in the repo, or null (detached/bare). */
  currentBranch: Schema.NullOr(Schema.String),
  /** `origin` remote URL, or null when there is no origin. */
  remoteUrl: Schema.NullOr(Schema.String),
  /** "owner/repo" parsed from a GitHub origin, or null. */
  githubSlug: Schema.NullOr(Schema.String)
})
export type Repo = Schema.Schema.Type<typeof Repo>

/** An isolated git worktree created for a session. */
export const Worktree = Schema.Struct({
  /** Absolute path to the worktree, under `~/jingler/worktrees/…`. */
  path: Schema.String,
  /** The new branch checked out in the worktree (e.g. "jingler/refactor-auth"). */
  branch: Schema.String,
  /** The branch the worktree was forked from. */
  baseBranch: Schema.String,
  /** Absolute path to the origin repo the worktree belongs to. */
  repoPath: Schema.String
})
export type Worktree = Schema.Schema.Type<typeof Worktree>

/** Detection + auth state of the GitHub CLI (`gh`). Never fails; folds to false. */
export const GhStatus = Schema.Struct({
  /** `gh` is installed and on PATH. */
  available: Schema.Boolean,
  /** `gh auth status` reported an authenticated account. */
  authenticated: Schema.Boolean,
  /** The authenticated account handle, or null. */
  login: Schema.NullOr(Schema.String),
  /** The authenticated host (e.g. "github.com"), or null. */
  host: Schema.NullOr(Schema.String),
  /** Reported `gh` version, or null when unavailable. */
  version: Schema.NullOr(Schema.String)
})
export type GhStatus = Schema.Schema.Type<typeof GhStatus>

// ── Pull requests / code review ──────────────────────────────────────────────

/** Overall state of a pull request. "draft" is synthesized from `isDraft`. */
export const PrState = Schema.Literal("open", "closed", "merged", "draft")
export type PrState = Schema.Schema.Type<typeof PrState>

/** Normalized CI check status (mapped from `gh pr checks` buckets). */
export const PrCheckStatus = Schema.Literal("pass", "fail", "running", "pending")
export type PrCheckStatus = Schema.Schema.Type<typeof PrCheckStatus>

/**
 * A session's linked PR, reduced to the two facts a sidebar row can show in one
 * glyph: where the PR is in its life, and whether CI is happy.
 *
 * Deliberately NOT the full `PullRequest`. This is polled for every session with
 * a PR, on a timer, forever — so it carries only what the row renders, and its
 * `gh` call asks for three JSON fields rather than the twenty `PR_VIEW_FIELDS`
 * asks for. Anything richer belongs in the Pull Request tab, which is fetched
 * once, on demand, for one session.
 */
export const SessionPrStatus = Schema.Struct({
  state: PrState,
  /**
   * The rollup across every check on the head commit, or null when the PR has
   * no checks at all.
   *
   * Null and "pending" are different answers and the glyph treats them
   * differently: null means nothing is configured to run, "pending" means
   * something is queued and hasn't started. Collapsing them would make a repo
   * with no CI look permanently mid-build.
   */
  checks: Schema.NullOr(PrCheckStatus)
})
export type SessionPrStatus = Schema.Schema.Type<typeof SessionPrStatus>

/** How a reviewer/timeline review resolved. "pending" = requested, not yet done. */
export const PrReviewKind = Schema.Literal(
  "commented",
  "approved",
  "changes_requested",
  "pending"
)
export type PrReviewKind = Schema.Schema.Type<typeof PrReviewKind>

/** The kind of review a composer submits back to GitHub. */
export const ReviewSubmitKind = Schema.Literal("comment", "approve", "request-changes")
export type ReviewSubmitKind = Schema.Schema.Type<typeof ReviewSubmitKind>

/** The strategy `gh pr merge` uses when merging a pull request. */
export const PrMergeMethod = Schema.Literal("merge", "squash", "rebase")
export type PrMergeMethod = Schema.Schema.Type<typeof PrMergeMethod>

/** A GitHub account reference (author / reviewer). */
export const GithubUser = Schema.Struct({
  login: Schema.String,
  avatarUrl: Schema.NullOr(Schema.String)
})
export type GithubUser = Schema.Schema.Type<typeof GithubUser>

/** A PR label chip. */
export const PrLabel = Schema.Struct({
  name: Schema.String,
  color: Schema.NullOr(Schema.String)
})
export type PrLabel = Schema.Schema.Type<typeof PrLabel>

/** A requested/actual reviewer and their current state. */
export const PrReviewer = Schema.Struct({
  login: Schema.String,
  state: PrReviewKind
})
export type PrReviewer = Schema.Schema.Type<typeof PrReviewer>

/** One CI check on a PR. */
export const PrCheck = Schema.Struct({
  name: Schema.String,
  status: PrCheckStatus,
  /** Link to the run's details page, or null. */
  detailsUrl: Schema.NullOr(Schema.String),
  /** Duration in milliseconds when known, or null (still running / not reported). */
  durationMs: Schema.NullOr(Schema.Number)
})
export type PrCheck = Schema.Schema.Type<typeof PrCheck>

/**
 * A review / comment entry in the PR timeline — top-level reviews and issue
 * comments only. Inline review comments live in `PrReviewThread` instead, so
 * they can keep their diff hunk and reply structure.
 *
 * `path`/`line` are retained for the "send to agent" code reference and are null
 * for everything the timeline currently carries.
 */
export const PrTimelineItem = Schema.Struct({
  id: Schema.String,
  author: Schema.String,
  kind: Schema.Literal("commented", "approved", "changes_requested"),
  body: Schema.String,
  createdAt: Schema.String,
  path: Schema.NullOr(Schema.String),
  line: Schema.NullOr(Schema.Number)
})
export type PrTimelineItem = Schema.Schema.Type<typeof PrTimelineItem>

/** GitHub's relationship between a commenter and the repo (drives the chips). */
export const PrAuthorAssociation = Schema.Literal(
  "OWNER",
  "MEMBER",
  "COLLABORATOR",
  "CONTRIBUTOR",
  "FIRST_TIME_CONTRIBUTOR",
  "FIRST_TIMER",
  "MANNEQUIN",
  "NONE"
)
export type PrAuthorAssociation = Schema.Schema.Type<typeof PrAuthorAssociation>

/** A reaction tally on a comment — e.g. `THUMBS_UP` × 1. Zero-counts are dropped. */
export const PrReaction = Schema.Struct({
  content: Schema.String,
  count: Schema.Number
})
export type PrReaction = Schema.Schema.Type<typeof PrReaction>

/** One comment inside an inline review thread. */
export const PrThreadComment = Schema.Struct({
  /** GraphQL node id. */
  id: Schema.String,
  /**
   * REST numeric id. Replies POST to `/pulls/{n}/comments/{databaseId}/replies`,
   * which does not accept a GraphQL node id.
   */
  databaseId: Schema.NullOr(Schema.Number),
  author: Schema.String,
  authorAvatarUrl: Schema.NullOr(Schema.String),
  /**
   * A GitHub App posted this (`__typename === "Bot"`). Note that bots report an
   * `authorAssociation` of `NONE`, so this is the only reliable bot signal.
   */
  isBot: Schema.Boolean,
  association: Schema.NullOr(PrAuthorAssociation),
  body: Schema.String,
  createdAt: Schema.String,
  reactions: Schema.Array(PrReaction)
})
export type PrThreadComment = Schema.Schema.Type<typeof PrThreadComment>

/**
 * An inline review thread anchored to a diff hunk — GitHub's unit of inline
 * review conversation, and what the Pull Request tab renders instead of a flat
 * list of comments.
 *
 * `line`/`startLine` are the CURRENT anchor and GitHub nulls BOTH of them once
 * the thread is outdated (the hunk has moved), which is the common case on any
 * PR that has been pushed to since review. `originalLine`/`originalStartLine`
 * are the anchor at review time and always survive — so rendering the
 * "Comment on lines +x to +y" caption means falling back to them.
 * A null start (after that fallback) means a single-line comment.
 */
export const PrReviewThread = Schema.Struct({
  id: Schema.String,
  /**
   * Node id of the review that opened the thread, used to group threads under a
   * single "<author> reviewed <when>" header. Null when GitHub reports none.
   */
  reviewId: Schema.NullOr(Schema.String),
  path: Schema.String,
  line: Schema.NullOr(Schema.Number),
  startLine: Schema.NullOr(Schema.Number),
  originalLine: Schema.NullOr(Schema.Number),
  originalStartLine: Schema.NullOr(Schema.Number),
  /** The raw unified-diff hunk (`@@ …` header included) the thread is anchored to. */
  diffHunk: Schema.String,
  isResolved: Schema.Boolean,
  isOutdated: Schema.Boolean,
  resolvedBy: Schema.NullOr(Schema.String),
  comments: Schema.Array(PrThreadComment)
})
export type PrReviewThread = Schema.Schema.Type<typeof PrReviewThread>

/** A changed file in a PR, for the Code Review file list. */
export const PrFileChange = Schema.Struct({
  path: Schema.String,
  additions: Schema.Number,
  deletions: Schema.Number,
  /** Inline-comment count on this file (0 in v1 — not exposed by `gh pr view`). */
  commentCount: Schema.Number,
  /** Whether the reviewer marked the file viewed (false in v1). */
  viewed: Schema.Boolean
})
export type PrFileChange = Schema.Schema.Type<typeof PrFileChange>

/**
 * A pull request linked to a session, assembled from `gh pr view` + `gh pr
 * checks`. Read-only view model for the Pull Request tab.
 */
export const PullRequest = Schema.Struct({
  number: Schema.Number,
  state: PrState,
  title: Schema.String,
  body: Schema.NullOr(Schema.String),
  url: Schema.String,
  /** Source (PR head) branch. */
  headRefName: Schema.String,
  /** Target (base) branch. */
  baseRefName: Schema.String,
  isDraft: Schema.Boolean,
  author: GithubUser,
  createdAt: Schema.String,
  commits: Schema.Number,
  changedFiles: Schema.Number,
  additions: Schema.Number,
  deletions: Schema.Number,
  labels: Schema.Array(PrLabel),
  reviewers: Schema.Array(PrReviewer),
  timeline: Schema.Array(PrTimelineItem),
  /** Inline review threads, grouped and rendered separately from `timeline`. */
  reviewThreads: Schema.Array(PrReviewThread),
  checks: Schema.Array(PrCheck),
  /** GitHub `mergeable` (MERGEABLE | CONFLICTING | UNKNOWN), or null. */
  mergeable: Schema.NullOr(Schema.String),
  /** GitHub `mergeStateStatus` (CLEAN | BLOCKED | DIRTY | BEHIND | …), or null. */
  mergeStateStatus: Schema.NullOr(Schema.String),
  /** Human-readable reasons merging is blocked (synthesized). Empty when clear. */
  mergeBlockers: Schema.Array(Schema.String)
})
export type PullRequest = Schema.Schema.Type<typeof PullRequest>

/**
 * A lightweight PR list-item for the "new session from a PR" picker (from
 * `gh pr list --json …`). Distinct from the full `PullRequest` view model —
 * only the fields the picker row + session creation need.
 */
export const PrSummary = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  /** Source (PR head) branch — the session's worktree checks this out. */
  headRefName: Schema.String,
  /** Target (base) branch. */
  baseRefName: Schema.String,
  author: GithubUser,
  state: PrState,
  isDraft: Schema.Boolean,
  additions: Schema.Number,
  deletions: Schema.Number,
  /** ISO-8601 last-updated timestamp (for the relative "2h ago" label). */
  updatedAt: Schema.String
})
export type PrSummary = Schema.Schema.Type<typeof PrSummary>

/**
 * A lightweight open-issue list-item for the "new session from an issue" picker
 * and the attach-issue dialog (from `gh issue list --json …`). Mirrors
 * `PrSummary`; `body` seeds the prefilled task.
 */
export const IssueSummary = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  /** Issue web URL (for "Open ⧉"). */
  url: Schema.String,
  /** Issue body (markdown) — seeds the composer's prefilled task. */
  body: Schema.String,
  labels: Schema.Array(PrLabel),
  author: GithubUser,
  assignees: Schema.Array(GithubUser),
  /** ISO-8601 last-updated timestamp (for the relative "2h ago" label). */
  updatedAt: Schema.String
})
export type IssueSummary = Schema.Schema.Type<typeof IssueSummary>

/** A comment on a GitHub issue (for the Issue tab's rich view). */
export const IssueComment = Schema.Struct({
  author: GithubUser,
  body: Schema.String,
  createdAt: Schema.String
})
export type IssueComment = Schema.Schema.Type<typeof IssueComment>

/**
 * The full GitHub issue view model for the Issue tab — a recreation of the
 * issue page (from `gh issue view --json …`). Read-only.
 */
export const Issue = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  url: Schema.String,
  state: Schema.Literal("open", "closed"),
  body: Schema.String,
  author: GithubUser,
  assignees: Schema.Array(GithubUser),
  labels: Schema.Array(PrLabel),
  createdAt: Schema.String,
  comments: Schema.Array(IssueComment)
})
export type Issue = Schema.Schema.Type<typeof Issue>

/**
 * A pending inline review comment anchored to a file + line — the payload the
 * renderer sends when it submits its review drafts to the PR.
 *
 * `line` is the END of the range and `startLine` the beginning, matching how
 * GitHub anchors a multi-line comment (and the inverse of how `ReviewFinding`
 * names them). Null `startLine` means a single-line comment.
 *
 * There is no `side`: everything Jingler posts is a comment on the NEW side of
 * the diff, and `prReviewComments` hardcodes `RIGHT` accordingly. A LEFT-side
 * anchor would need `postableLines` to track old-side lines too, which it
 * deliberately does not.
 */
export const ReviewComment = Schema.Struct({
  path: Schema.String,
  line: Schema.Number,
  startLine: Schema.NullOr(Schema.Number),
  body: Schema.String
})
export type ReviewComment = Schema.Schema.Type<typeof ReviewComment>

// ── Adversarial review ───────────────────────────────────────────────────────

/**
 * How bad a finding is, as argued by the reviewer. The reviewer is asked for
 * COVERAGE (report everything, tag it honestly) rather than to self-filter —
 * a model told "only report high-severity issues" silently drops findings it
 * judges below the bar, which reads as a recall regression. Filtering is the
 * UI's job, which is why this field exists.
 */
export const ReviewSeverity = Schema.Literal("critical", "major", "minor", "nit")
export type ReviewSeverity = Schema.Schema.Type<typeof ReviewSeverity>

/**
 * The commit credited with resolving a finding.
 *
 * The subject is stored alongside the SHA rather than looked up on read: the
 * commit may be gone by the time anyone reads this (a rebase, a squashed merge,
 * a discarded worktree), and a resolution that renders as a bare hash nobody can
 * resolve is worse than no attribution at all.
 */
export const ReviewResolution = Schema.Struct({
  /** Full 40-char commit SHA — abbreviated at the point of display, not here. */
  sha: Schema.String,
  /** The commit's subject line, so the card can name what fixed it. */
  subject: Schema.String,
  /** ISO-8601 stamp of when the resolution was ATTRIBUTED, not of the commit. */
  at: Schema.String
})
export type ReviewResolution = Schema.Schema.Type<typeof ReviewResolution>

/** One defect the adversarial reviewer argues for, anchored to file+line where it can be. */
export const ReviewFinding = Schema.Struct({
  /** Stable id within a review — the key for "already routed to the agent". */
  id: Schema.String,
  /** Repo-relative path, or null for a finding about the change as a whole. */
  path: Schema.NullOr(Schema.String),
  /** 1-indexed line in the file's NEW side, or null when not line-anchored. */
  line: Schema.NullOr(Schema.Number),
  /** End of a multi-line range, or null for a single line. */
  endLine: Schema.NullOr(Schema.Number),
  severity: ReviewSeverity,
  /** One-sentence statement of the defect. */
  title: Schema.String,
  /** Why it's wrong — the concrete failure, not a style opinion. */
  rationale: Schema.String,
  /** A concrete fix, or null when the reviewer only raises the problem. */
  suggestion: Schema.NullOr(Schema.String),
  /**
   * The commit that addressed this finding, or null while it is outstanding.
   *
   * Attributed rather than declared: nothing asks the agent to report which
   * finding a commit fixed, so this is inferred — the first commit landed AFTER
   * the reviewed head that touches the finding's own file claims it (see
   * `resolveFindings`). That is a heuristic, and deliberately a conservative one:
   * it can only ever fire for a file the reviewer actually anchored a finding to,
   * and it attributes to the FIRST such commit so the record doesn't drift to the
   * most recent unrelated edit of the same file.
   *
   * `optionalWith` (default null) so reviews persisted before this field decode
   * cleanly rather than folding to null in `ReviewStore.readFile` — which would
   * throw away a real review and silently re-run the priciest model.
   */
  resolvedBy: Schema.optionalWith(Schema.NullOr(ReviewResolution), { default: () => null })
})
export type ReviewFinding = Schema.Schema.Type<typeof ReviewFinding>

/**
 * The result of one adversarial review run against a PR head, persisted per
 * session under `~/jingler/reviews/<sessionId>.json` so it survives reloads.
 */
export const AdversarialReview = Schema.Struct({
  sessionId: Schema.String,
  prNumber: Schema.Number,
  /**
   * The PR head commit the review ran against — the de-dupe key. An auto-review
   * whose head SHA matches the stored one is a no-op, which is what keeps the
   * poll-driven trigger from re-spawning a reviewer on every tick.
   */
  headSha: Schema.String,
  /** The harness that ran the reviewer. */
  cli: CliKind,
  /** The model the reviewer ran on (e.g. "claude-fable-5"). */
  model: Schema.String,
  /** ISO-8601 timestamp of the run. */
  createdAt: Schema.String,
  findings: Schema.Array(ReviewFinding),
  /**
   * Set when the reviewer ran but emitted no parseable findings block — a
   * refusal, a "looks good to me", or malformed output. Carries the raw text so
   * the user sees *something* rather than an empty list that looks like success.
   */
  note: Schema.NullOr(Schema.String),
  /**
   * ISO-8601 stamp of when this review's critical/major findings were handed to
   * the session's agent, or null when they haven't been.
   *
   * Persisted rather than tracked in the renderer, and that is load-bearing: the
   * renderer's `routed-store` is in-memory, and the auto-review poll hands back
   * this same stored review on every tick. After a reload an in-memory guard is
   * empty, so the poll would re-send the whole batch to the agent as a fresh
   * turn — every restart, forever. The stamp lives with the review because a
   * review IS a snapshot of one head: same head, same routing decision.
   *
   * `optionalWith` (default null) so reviews persisted before this field decode
   * cleanly instead of folding to null in `ReviewStore.readFile` — which would
   * silently re-run the priciest model once per existing session.
   */
  routedAt: Schema.optionalWith(Schema.NullOr(Schema.String), { default: () => null }),
  /**
   * ISO-8601 stamp of when this review's minor/nit findings were posted to the
   * PR as inline comments, or null when they weren't (none to post, or the post
   * failed — `postError` distinguishes the two).
   */
  postedAt: Schema.optionalWith(Schema.NullOr(Schema.String), { default: () => null }),
  /**
   * Why posting the minor/nit half to the PR failed, or null.
   *
   * Posting is best-effort: a review costs real tokens and its verdict is useful
   * whether or not GitHub accepted the comments, so a `gh` failure lands here
   * instead of failing the run and throwing the findings away.
   */
  postError: Schema.optionalWith(Schema.NullOr(Schema.String), { default: () => null })
})
export type AdversarialReview = Schema.Schema.Type<typeof AdversarialReview>

/** Parameters for creating a new session. */
export const CreateSessionInput = Schema.Struct({
  /** Absolute path to the origin repo. */
  repoPath: Schema.String,
  /** The repo's folder name, used for grouping + the worktree directory. */
  repoName: Schema.String,
  /**
   * Optional session title. When omitted/blank the session is auto-named by the
   * agent from a detached fresh-base worktree; when provided it seeds the title
   * (pinned) and creates a readable branch immediately.
   */
  title: Schema.optional(Schema.String),
  /** Which CLI will drive the session. */
  cli: CliKind,
  /** The branch to fork the worktree from, or check out for a direct session. */
  baseBranch: Schema.String,
  /**
   * Whether to create an isolated linked worktree. Omitted defaults to true so
   * existing callers and persisted RPC requests retain the current behaviour.
   */
  useWorktree: Schema.optional(Schema.Boolean)
})
export type CreateSessionInput = Schema.Schema.Type<typeof CreateSessionInput>

/**
 * Parameters for creating a session from an *existing* pull request. Unlike
 * `CreateSessionInput` (which forks a fresh `jingler/<slug>` branch), this
 * checks out the PR's head branch into the worktree so the agent's commits
 * update the PR directly. Title + base come from the PR itself.
 */
export const CreateSessionFromPrInput = Schema.Struct({
  /** Absolute path to the origin repo. */
  repoPath: Schema.String,
  /** The repo's folder name, used for grouping + the worktree directory. */
  repoName: Schema.String,
  /** Which CLI will drive the session. */
  cli: CliKind,
  /** The pull request to base the session on. */
  pr: Schema.Struct({
    number: Schema.Number,
    title: Schema.String,
    headRefName: Schema.String,
    baseRefName: Schema.String
  })
})
export type CreateSessionFromPrInput = Schema.Schema.Type<typeof CreateSessionFromPrInput>

/**
 * Parameters for creating a session from a GitHub issue. Unlike
 * `CreateSessionFromPrInput` (which checks out an existing PR branch), this
 * forks a fresh `<number>-<slug>` branch off `baseBranch` like a blank session,
 * links the issue, and seeds the task from the issue title + body.
 */
export const CreateSessionFromIssueInput = Schema.Struct({
  /** Absolute path to the origin repo. */
  repoPath: Schema.String,
  /** The repo's folder name, used for grouping + the worktree directory. */
  repoName: Schema.String,
  /** Which CLI will drive the session. */
  cli: CliKind,
  /** The branch to fork the worktree from. */
  baseBranch: Schema.String,
  /** The issue to link + seed the task from. */
  issue: Schema.Struct({
    number: Schema.Number,
    title: Schema.String,
    url: Schema.String,
    body: Schema.String,
    labels: Schema.Array(PrLabel)
  }),
  /**
   * The (editable) task to seed the composer with — prefilled from the issue in
   * the dialog. Empty falls back to the issue title + body.
   */
  task: Schema.String,
  /** Automations to enable on the new session. */
  automations: IssueAutomations
})
export type CreateSessionFromIssueInput = Schema.Schema.Type<typeof CreateSessionFromIssueInput>

// ── Terminal ─────────────────────────────────────────────────────────────────

/** Lifecycle of a PTY-backed terminal. */
export const TerminalStatus = Schema.Literal("running", "exited")
export type TerminalStatus = Schema.Schema.Type<typeof TerminalStatus>

/**
 * Metadata for one PTY-backed terminal tab. The live byte stream rides
 * `Terminal.attach`; this is just the sidebar/tab-strip descriptor. Terminals
 * are scoped to a session (their cwd is the session's worktree).
 */
export const TerminalInfo = Schema.Struct({
  /** Opaque id (also the RPC key for write/resize/kill/attach). */
  id: Schema.String,
  /** The session this terminal belongs to. */
  sessionId: Schema.String,
  /** Tab label — the shell's base name, e.g. "zsh" or "node". */
  title: Schema.String,
  /** Absolute working directory the shell was spawned in. */
  cwd: Schema.String,
  /** Whether the shell process is still alive. */
  status: TerminalStatus,
  /** Exit code once the shell has exited (null while running). */
  exitCode: Schema.NullOr(Schema.Number)
})
export type TerminalInfo = Schema.Schema.Type<typeof TerminalInfo>

/**
 * One frame on a terminal's `attach` stream. Output frames carry a
 * *coalesced* run of PTY bytes (the service batches raw `onData` chunks on a
 * short tick / size threshold so throughput events stay bounded — the crux of
 * the perf story). An `exit` frame is emitted once, last, when the shell dies.
 */
export const TerminalChunk = Schema.Union(
  Schema.Struct({ _tag: Schema.Literal("data"), data: Schema.String }),
  Schema.Struct({ _tag: Schema.Literal("exit"), exitCode: Schema.Number })
)
export type TerminalChunk = Schema.Schema.Type<typeof TerminalChunk>

// ── Browser preview (embedded WebContentsView over a localhost dev server) ────

/**
 * The on-screen rectangle (CSS pixels, relative to the renderer's top-left) the
 * embedded browser `WebContentsView` should occupy. The renderer streams this
 * from the preview pane's `getBoundingClientRect` so the native view stays
 * aligned with its placeholder as the layout changes.
 */
export const BrowserBounds = Schema.Struct({
  x: Schema.Number,
  y: Schema.Number,
  width: Schema.Number,
  height: Schema.Number
})
export type BrowserBounds = Schema.Schema.Type<typeof BrowserBounds>

// The conversation/transcript model (Message, ToolCall, ApprovalGate) and the
// normalized StreamEvent seam live in ./conversation.ts.
