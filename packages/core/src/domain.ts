import { Schema } from "effect";
import { BUDGET_RANGE, DEFAULT_BUDGET_TOKENS } from "./context.js";
import { PlanTemplateConfig } from "./plan-document.js";
import { ThemeConfig } from "./theme.js";
import {
  AuthKind,
  AuthStatus,
  ProviderConnectionId,
  ProviderId,
  ProviderModelId,
} from "./runtime/provider-connection.js";
import { RuntimeCapabilityManifest } from "./runtime/capability-manifest.js";
import { ReasoningEffort } from "./runtime/reasoning-effort.js";
export { ReasoningEffort } from "./runtime/reasoning-effort.js";
import {
  AgentEndpointId,
  AgentModelSelection,
  AgentRuntimeId,
  RuntimeContinuation,
} from "./runtime/agent-endpoint.js";
import { AgentEndpointCatalog } from "./runtime/agent-endpoint-catalog.js";
import { RuntimeRecoveryState } from "./runtime/runtime-recovery.js";
import {
  SubagentModelAssignments,
  SubagentProviderModelAssignments
} from "./runtime/subagent-settings.js";
import { OffloadComputeSettings } from "./offload-compute.js";
import { WebSearchConfig } from "./web-search.js";

/**
 * Domain schemas for Jingler. These are Effect `Schema`s so they can be reused
 * for RPC payload encode/decode, persistence, and runtime validation. The plain
 * TypeScript types are derived from the schemas via `Schema.Schema.Type`.
 */

// ── Environments ────────────────────────────────────────────────────────────

export const EnvironmentConnectionState = Schema.Literal(
  "online",
  "offline",
  "reconnecting",
  "incompatible",
  "revoked",
);
export type EnvironmentConnectionState = Schema.Schema.Type<
  typeof EnvironmentConnectionState
>;

export const ManagedEnvironmentState = Schema.Literal(
  "provisioning",
  "online",
  "sleeping",
  "restoring",
  "paused",
  "failed",
  "revoked",
);
export type ManagedEnvironmentState = Schema.Schema.Type<
  typeof ManagedEnvironmentState
>;

export const ManagedEnvironmentInstanceType = Schema.Literal(
  "basic",
  "standard-1",
);
export type ManagedEnvironmentInstanceType = Schema.Schema.Type<
  typeof ManagedEnvironmentInstanceType
>;

export const EnvironmentCapabilities = Schema.Struct({
  version: Schema.Number,
  capabilities: Schema.Array(Schema.String),
  maxConcurrentSessions: Schema.Number,
  runtime: Schema.optional(RuntimeCapabilityManifest),
  endpointCatalog: Schema.optional(AgentEndpointCatalog),
  providerConnections: Schema.optional(
    Schema.Array(
      Schema.Struct({
        id: ProviderConnectionId,
        providerId: ProviderId,
        authKind: AuthKind,
        status: AuthStatus,
      }),
    ),
  ),
});
export type EnvironmentCapabilities = Schema.Schema.Type<
  typeof EnvironmentCapabilities
>;

/**
 * Renderer-safe metadata for an account-owned execution device.
 *
 * `kind` defaults while decoding so persisted and in-flight payloads written
 * before managed environments existed remain valid. New encodes always carry
 * the discriminator, making provider selection explicit at every new boundary.
 */
export const OwnedEnvironment = Schema.Struct({
  kind: Schema.optionalWith(Schema.Literal("owned"), {
    default: () => "owned" as const,
  }),
  id: Schema.String,
  name: Schema.String,
  platform: Schema.Struct({ os: Schema.String, arch: Schema.String }),
  capabilities: EnvironmentCapabilities,
  state: EnvironmentConnectionState,
  agentVersion: Schema.NullOr(Schema.String),
  lastSeenAt: Schema.NullOr(Schema.Number),
});
export type OwnedEnvironment = Schema.Schema.Type<typeof OwnedEnvironment>;

/** Renderer-safe metadata for Cloudflare-managed compute. Grants never inhabit this shape. */
export const ManagedEnvironment = Schema.Struct({
  kind: Schema.Literal("managed"),
  id: Schema.String,
  name: Schema.String,
  platform: Schema.Struct({ os: Schema.String, arch: Schema.String }),
  capabilities: EnvironmentCapabilities,
  state: ManagedEnvironmentState,
  agentVersion: Schema.Null,
  lastSeenAt: Schema.NullOr(Schema.Number),
  region: Schema.NullOr(Schema.String),
  instanceType: ManagedEnvironmentInstanceType,
  generation: Schema.Int.pipe(Schema.positive()),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
});
export type ManagedEnvironment = Schema.Schema.Type<typeof ManagedEnvironment>;

/** One provider-neutral execution inventory. No grant, key, or provider token is allowed. */
export const Environment = Schema.Union(OwnedEnvironment, ManagedEnvironment);
export type Environment = Schema.Schema.Type<typeof Environment>;

export const EnvironmentInventoryResponse = Schema.Struct({
  version: Schema.Literal(1),
  environments: Schema.Array(Environment).pipe(Schema.maxItems(384)),
});
export type EnvironmentInventoryResponse = Schema.Schema.Type<
  typeof EnvironmentInventoryResponse
>;

export const CreateManagedEnvironmentRequest = Schema.Struct({
  version: Schema.Literal(1),
  name: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(120)),
  region: Schema.NullOr(
    Schema.String.pipe(Schema.minLength(1), Schema.maxLength(32)),
  ),
  instanceType: ManagedEnvironmentInstanceType,
  idempotencyKey: Schema.String.pipe(
    Schema.minLength(8),
    Schema.maxLength(128),
    Schema.pattern(/^[A-Za-z0-9_-]+$/u),
  ),
});
export type CreateManagedEnvironmentRequest = Schema.Schema.Type<
  typeof CreateManagedEnvironmentRequest
>;

export const RenameManagedEnvironmentRequest = Schema.Struct({
  version: Schema.Literal(1),
  name: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(120)),
});
export type RenameManagedEnvironmentRequest = Schema.Schema.Type<
  typeof RenameManagedEnvironmentRequest
>;

export const ManagedEnvironmentLifecycleRequest = Schema.Struct({
  version: Schema.Literal(1),
  action: Schema.Literal("start", "pause", "restore"),
  expectedGeneration: Schema.Int.pipe(Schema.positive()),
  idempotencyKey: Schema.String.pipe(
    Schema.minLength(8),
    Schema.maxLength(128),
    Schema.pattern(/^[A-Za-z0-9_-]+$/u),
  ),
});
export type ManagedEnvironmentLifecycleRequest = Schema.Schema.Type<
  typeof ManagedEnvironmentLifecycleRequest
>;

export const DeleteManagedEnvironmentRequest = Schema.Struct({
  version: Schema.Literal(1),
  expectedGeneration: Schema.Int.pipe(Schema.positive()),
});
export type DeleteManagedEnvironmentRequest = Schema.Schema.Type<
  typeof DeleteManagedEnvironmentRequest
>;

export const ManagedEnvironmentGrantRequest = Schema.Struct({
  version: Schema.Literal(1),
  sessionId: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(128)),
  usageIntervalId: Schema.String.pipe(
    Schema.minLength(8),
    Schema.maxLength(128),
  ),
  expectedGeneration: Schema.Int.pipe(Schema.positive()),
  connectionId: ProviderConnectionId,
  providerId: ProviderId,
  modelId: ProviderModelId,
  actions: Schema.Array(
    Schema.Literal(
      "session.start",
      "session.input",
      "session.cancel",
      "session.observe",
    ),
  ).pipe(Schema.minItems(1), Schema.maxItems(4)),
});
export type ManagedEnvironmentGrantRequest = Schema.Schema.Type<
  typeof ManagedEnvironmentGrantRequest
>;

export const ManagedEnvironmentGrantResponse = Schema.Struct({
  version: Schema.Literal(1),
  runtimeUrl: Schema.String.pipe(Schema.minLength(1)),
  grant: Schema.String.pipe(Schema.minLength(1)),
  expiresAt: Schema.Int.pipe(Schema.nonNegative()),
});
export type ManagedEnvironmentGrantResponse = Schema.Schema.Type<
  typeof ManagedEnvironmentGrantResponse
>;

export const SshHost = Schema.Struct({
  alias: Schema.String,
  hostname: Schema.String,
  username: Schema.NullOr(Schema.String),
  port: Schema.Number,
  source: Schema.Literal("config", "known-hosts"),
});
export type SshHost = Schema.Schema.Type<typeof SshHost>;

export const PairSshEnvironmentInput = Schema.Struct({
  host: Schema.String,
  username: Schema.optional(Schema.String),
  port: Schema.optional(Schema.Number),
});
export type PairSshEnvironmentInput = Schema.Schema.Type<
  typeof PairSshEnvironmentInput
>;

// ── Sessions ─────────────────────────────────────────────────────────────────

/** Lifecycle status of an agent session, mirrored in the sidebar pills. */
export const SessionStatus = Schema.Literal(
  "thinking",
  "running",
  "needs-input",
  "idle",
  "settled",
  "done",
);
export type SessionStatus = Schema.Schema.Type<typeof SessionStatus>;

/**
 * The subset of `SessionStatus` that may be WRITTEN BACK to the store.
 *
 * A run lives in the main process and dies with the app, so persisting a busy
 * status ("thinking"/"running") would strand the session in it forever after a
 * restart — reporting work for a run that no longer exists. Keeping the invariant
 * in the type means the boundary enforces it, rather than every caller having to
 * remember. Live, in-flight state is `SessionActivity`, which is never persisted.
 */
export const SettledSessionStatus = Schema.Literal("idle", "needs-input", "settled");
export type SettledSessionStatus = Schema.Schema.Type<
  typeof SettledSessionStatus
>;

/** Added / removed line counts for a session's working diff. */
export const DiffStat = Schema.Struct({
  added: Schema.Number,
  removed: Schema.Number,
});
export type DiffStat = Schema.Schema.Type<typeof DiffStat>;

/**
 * Human-in-the-loop permission mode for a session:
 * - `ask` — pause for approval before every edit and command,
 * - `accept-edits` — auto-apply file edits, still pause for shell commands,
 * - `auto` — auto-apply edits and run allowlisted commands without prompting,
 * - `plan` — planning with auto permissions; Plannotator controls when a plan
 *   needs operator review, not workspace access.
 */
export const PermissionMode = Schema.Literal(
  "ask",
  "accept-edits",
  "auto",
  "plan",
);
export type PermissionMode = Schema.Schema.Type<typeof PermissionMode>;

/** Claude's provider-native adaptive-thinking effort values. */
export const ClaudeReasoningEffort = Schema.Literal(
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
);
export type ClaudeReasoningEffort = Schema.Schema.Type<
  typeof ClaudeReasoningEffort
>;

/** Codex's provider-native model reasoning effort values. */
export const CodexReasoningEffort = Schema.Literal(
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
);
export type CodexReasoningEffort = Schema.Schema.Type<
  typeof CodexReasoningEffort
>;

/**
 * Provider-native effort values accepted at the shared adapter boundary.
 *
 * Thinking being disabled is deliberately not an effort value. Providers model
 * it independently, and treating "off" as the bottom rung made it possible to
 * send incompatible combinations such as disabled thinking with maximum effort.
 */
export const ReasoningSetting = Schema.Struct({
  enabled: Schema.Boolean,
  effort: Schema.optional(ReasoningEffort),
});
export type ReasoningSetting = Schema.Schema.Type<typeof ReasoningSetting>;

/** Concrete permission modes that can execute an approved plan. */
export const ExecutionMode = Schema.Literal("ask", "accept-edits", "auto");
export type ExecutionMode = Schema.Schema.Type<typeof ExecutionMode>;

/**
 * The mode a fresh session should start in: the operator's configured default
 * when they set one in settings, otherwise `auto`. pi owns the permission
 * contract for every provider model, so this policy is not provider-dependent.
 */
export const defaultModeFor = (
  configuredDefault?: PermissionMode,
): PermissionMode => configuredDefault ?? "auto";

/**
 * Automations for a session linked to a GitHub issue (design I2 toggles).
 * Defined before `Session` so it can be referenced inline below.
 */
export const IssueAutomations = Schema.Struct({
  /** Post agent progress comments back to the linked issue as work happens. */
  progressComments: Schema.Boolean,
  /** Close the linked issue automatically when the session's PR merges. */
  closeOnMerge: Schema.Boolean,
});
export type IssueAutomations = Schema.Schema.Type<typeof IssueAutomations>;

/** A provider-neutral label attached to an issue. */
export const IssueLabel = Schema.Struct({
  name: Schema.String,
  /** Provider colour metadata, without a leading `#`, when one exists. */
  color: Schema.NullOr(Schema.String),
});
export type IssueLabel = Schema.Schema.Type<typeof IssueLabel>;

const IssueReferenceFields = {
  /** Stable manifest-declared provider id, e.g. `github` or `linear`. */
  providerId: Schema.String,
  /** Provider-owned opaque id. Consumers must never parse this value. */
  id: Schema.String,
  /** Optional provider-local account/profile needed to resolve this issue later. */
  providerAccountId: Schema.optional(Schema.String),
  /** Human-readable provider identifier, e.g. `#128` or `ENG-123`. */
  identifier: Schema.String,
  url: Schema.String,
  title: Schema.String,
  labels: Schema.Array(IssueLabel),
};

/** The durable provider-neutral issue identity persisted on a session. */
export const IssueReference = Schema.Struct(IssueReferenceFields);
export type IssueReference = Schema.Schema.Type<typeof IssueReference>;

/** Provider-scoped identity used to select or remove one durable issue link. */
export const IssueIdentity = Schema.Struct({
  providerId: Schema.String,
  id: Schema.String,
});
export type IssueIdentity = Schema.Schema.Type<typeof IssueIdentity>;

/** A single agent session shown in the sidebar and opened in the main pane. */
/** One isolated conversation inside a session's shared worktree. */
export const Chat = Schema.Struct({
  id: Schema.String,
  /** Null until the first message provides an automatic title. */
  title: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  /** Permission choices are restored independently for each chat. */
  mode: Schema.optional(PermissionMode),
  reasoning: Schema.optional(ReasoningSetting),
  allowlist: Schema.optional(Schema.Array(Schema.String)),
  contextTokens: Schema.optional(Schema.Number),
  /** Canonical runtime endpoint, provider model, and owned continuation. */
  runtimeId: Schema.optional(AgentRuntimeId),
  endpointId: Schema.optional(AgentEndpointId),
  connectionId: Schema.optional(ProviderConnectionId),
  providerId: Schema.optional(ProviderId),
  modelId: Schema.optional(ProviderModelId),
  continuation: Schema.optional(RuntimeContinuation),
  modelSelectionRequired: Schema.optional(Schema.Boolean),
  connectionSelectionRequired: Schema.optional(Schema.Boolean),
  legacyModel: Schema.optional(Schema.String),
  legacyResumeId: Schema.optional(Schema.String),
});
export type Chat = Schema.Schema.Type<typeof Chat>;
export type ChatId = Chat["id"];

/** How a session uses its repository checkout. */
export const WorkspaceMode = Schema.Literal("worktree", "direct");
export type WorkspaceMode = Schema.Schema.Type<typeof WorkspaceMode>;

/** Whether a registered project can currently be reached on its owning host. */
export const ProjectAvailability = Schema.Literal(
  "available",
  "missing",
  "offline",
);
export type ProjectAvailability = Schema.Schema.Type<
  typeof ProjectAvailability
>;

export const ProjectRunCommand = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  command: Schema.String,
});
export type ProjectRunCommand = Schema.Schema.Type<typeof ProjectRunCommand>;

/** Machine-local commands and ignored files explicitly approved by the operator. */
export const ProjectWorkflow = Schema.Struct({
  setup: Schema.optional(Schema.String),
  cleanup: Schema.optional(Schema.String),
  runs: Schema.Array(ProjectRunCommand),
  copyFiles: Schema.Array(Schema.String),
  /** SHA-256 of the executable fields above. Missing means configured but not approved. */
  approvedDigest: Schema.optional(Schema.String),
});
export type ProjectWorkflow = Schema.Schema.Type<typeof ProjectWorkflow>;

export const WorkspaceLifecycle = Schema.Struct({
  status: Schema.Literal(
    "ready",
    "setup-running",
    "setup-failed",
    "setup-skipped",
    "cleanup-running",
    "cleanup-failed",
  ),
  updatedAt: Schema.String,
  error: Schema.optional(Schema.String),
  /** Bounded, redacted-by-contract command output for operator diagnosis. */
  output: Schema.optional(Schema.String),
});
export type WorkspaceLifecycle = Schema.Schema.Type<typeof WorkspaceLifecycle>;

export const WorkspaceRunState = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  status: Schema.Literal("running", "exited", "failed"),
  startedAt: Schema.String,
  exitCode: Schema.optional(Schema.Number),
  output: Schema.optional(Schema.String),
});
export type WorkspaceRunState = Schema.Schema.Type<typeof WorkspaceRunState>;

/** A durable repository registration, independent of any workspace/session. */
export const Project = Schema.Struct({
  id: Schema.String,
  /** Explicitly imported or recovered from a session, not directory discovery. */
  imported: Schema.optional(Schema.Boolean),
  /** Stable paired-device identity. Absent means this desktop. */
  environmentId: Schema.optional(Schema.String),
  name: Schema.String,
  path: Schema.String,
  availability: ProjectAvailability,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  /** Approved machine-local workspace commands; absent on legacy projects. */
  workflow: Schema.optional(ProjectWorkflow),
});
export type Project = Schema.Schema.Type<typeof Project>;

/** One directory shown by the in-app project browser. */
export const ProjectDirectoryEntry = Schema.Struct({
  name: Schema.String,
  path: Schema.String,
  isGitRepository: Schema.Boolean,
});
export type ProjectDirectoryEntry = Schema.Schema.Type<
  typeof ProjectDirectoryEntry
>;

/** A single navigable level in the in-app project browser. */
export const ProjectDirectoryListing = Schema.Struct({
  path: Schema.String,
  parentPath: Schema.NullOr(Schema.String),
  directories: Schema.Array(ProjectDirectoryEntry),
});
export type ProjectDirectoryListing = Schema.Schema.Type<
  typeof ProjectDirectoryListing
>;

/** A repository the signed-in user can clone through the GitHub App or CLI. */
export const GitHubCloneRepository = Schema.Struct({
  installationId: Schema.optional(Schema.String),
  repositoryId: Schema.String,
  fullName: Schema.String,
});
export type GitHubCloneRepository = Schema.Schema.Type<
  typeof GitHubCloneRepository
>;

export const PublishStep = Schema.Literal(
  "idle",
  "inspecting",
  "verifying-branch",
  "generating-metadata",
  "staging",
  "committing",
  "authenticating",
  "pushing",
  "resolving-pr",
  "creating-pr",
  "updating-pr",
  "linking",
  "complete",
  "failed",
  "no-changes",
);
export type PublishStep = Schema.Schema.Type<typeof PublishStep>;

/** Model-suggested prose which Jingler validates before any git/GitHub mutation. */
export const PublishMetadata = Schema.Struct({
  commitMessage: Schema.String,
  prTitle: Schema.String,
  prBody: Schema.String,
});
export type PublishMetadata = Schema.Schema.Type<typeof PublishMetadata>;

/** Durable checkpoint for the deterministic session publishing workflow. */
export const PublishCheckpoint = Schema.Struct({
  step: PublishStep,
  completed: Schema.Array(PublishStep),
  metadata: Schema.optional(PublishMetadata),
  branch: Schema.optional(Schema.String),
  commitSha: Schema.optional(Schema.String),
  prNumber: Schema.optional(Schema.Number),
  error: Schema.optional(Schema.String),
  resumeFrom: Schema.optional(PublishStep),
  updatedAt: Schema.String,
});
export type PublishCheckpoint = Schema.Schema.Type<typeof PublishCheckpoint>;

export const Session = Schema.Struct({
  routineOccurrence: Schema.optional(Schema.Struct({ routineId: Schema.String, runId: Schema.String })),
  /** Explicit opt-in: quiescent workspace-wide checkpoints before turns; no delegated children. */
  checkpointSafeMode: Schema.optional(Schema.Boolean),
  /** Absent means legacy/unknown, never proven clean. Persist before any unowned launch. */
  checkpointExecutionHistory: Schema.optional(Schema.Literal("clean", "unprovable")),
  /** An interactive terminal may leave descendants after its leader or the app exits. */
  checkpointPtyHistory: Schema.optional(Schema.Boolean),
  id: Schema.String,
  /** Durable project identity. Absent on sessions created before Projects existed. */
  projectId: Schema.optional(Schema.String),
  /** Stable paired-device identity. Absent means this desktop (legacy-safe). */
  environmentId: Schema.optional(Schema.String),
  /** Display/grouping name of the repository. */
  repo: Schema.String,
  /** Canonical owner/repository identity for GitHub operations without a local checkout. */
  githubSlug: Schema.optional(Schema.String),
  branch: Schema.String,
  /** Agent-proposed semantic task branch; persisted once Jingler validates and creates it. */
  semanticBranchProposal: Schema.optional(
    Schema.Struct({
      type: Schema.Literal(
        "feat",
        "fix",
        "refactor",
        "docs",
        "test",
        "chore",
        "perf",
        "build",
        "ci",
        "style",
        "revert",
      ),
      slug: Schema.String,
    }),
  ),
  /** True while a fresh isolated task worktree is detached and awaiting its branch. */
  semanticBranchPending: Schema.optional(Schema.Boolean),
  title: Schema.String,
  status: SessionStatus,
  /** Canonical execution identity mirrored from the active chat. */
  runtimeId: Schema.optional(AgentRuntimeId),
  endpointId: Schema.optional(AgentEndpointId),
  connectionId: Schema.optional(ProviderConnectionId),
  providerId: Schema.optional(ProviderId),
  modelId: Schema.optional(ProviderModelId),
  continuation: Schema.optional(RuntimeContinuation),
  modelSelectionRequired: Schema.optional(Schema.Boolean),
  connectionSelectionRequired: Schema.optional(Schema.Boolean),
  legacyCli: Schema.optional(Schema.String),
  legacyModel: Schema.optional(Schema.String),
  legacyResumeId: Schema.optional(Schema.String),
  /** Restart-safe mutation outcomes that require operator inspection. */
  runtimeRecovery: Schema.optional(RuntimeRecoveryState),
  /**
   * Where the runtime process runs. Desktop-created sessions are local; remote
   * session importers set `cloud`. Optional so older sessions decode as local.
   */
  executionLocation: Schema.optional(Schema.Literal("local", "cloud")),
  diff: DiffStat,
  /** Optional linked pull-request number. */
  prNumber: Schema.NullOr(Schema.Number),
  /** Immutable GitHub App installation owning the linked repository. */
  githubInstallationId: Schema.optional(Schema.String),
  /** Immutable GitHub repository database id used for webhook/session routing. */
  githubRepositoryId: Schema.optional(Schema.String),
  /** Bounded exactly-once ledger persisted before realtime feedback dispatch. */
  githubFeedbackDeliveryIds: Schema.optional(Schema.Array(Schema.String)),
  /** Suppresses edited webhook deliveries whose actionable content did not change. */
  githubFeedbackSemanticKeys: Schema.optional(Schema.Array(Schema.String)),
  /** Resumable deterministic commit/push/PR publication state. */
  publish: Schema.optional(PublishCheckpoint),
  /** Optional linked GitHub issue number (drives the sidebar badge + banner). */
  issueNumber: Schema.optional(Schema.Number),
  /** Linked issue web URL (the banner "Open" link). */
  issueUrl: Schema.optional(Schema.String),
  /** Linked issue title (banner). */
  issueTitle: Schema.optional(Schema.String),
  /** Linked issue label chips (banner). Same shape as `PrLabel`. */
  issueLabels: Schema.optional(
    Schema.Array(
      Schema.Struct({
        name: Schema.String,
        color: Schema.NullOr(Schema.String),
      }),
    ),
  ),
  /** Legacy provider-neutral singleton written before sessions supported multiple links. */
  linkedIssue: Schema.optional(IssueReference),
  /** Canonical ordered provider-neutral issue links. */
  linkedIssues: Schema.optional(Schema.Array(IssueReference)),
  /** The issue currently shown by issue-aware session surfaces. */
  selectedIssue: Schema.optional(IssueIdentity),
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
  /** Durable setup/cleanup gate for machine-local workspace automation. */
  workspaceLifecycle: Schema.optional(WorkspaceLifecycle),
  /** Legacy single-chat mode and allowlist aliases retained during rolling migration. */
  mode: Schema.optional(PermissionMode),
  allowlist: Schema.optional(Schema.Array(Schema.String)),
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
  archivedAt: Schema.optional(Schema.String),
});
export type Session = Schema.Schema.Type<typeof Session>;

/** The persisted fields needed to resolve canonical and historical issue links. */
export type SessionIssueLinks = Pick<
  Session,
  | "linkedIssues"
  | "selectedIssue"
  | "linkedIssue"
  | "issueNumber"
  | "issueUrl"
  | "issueTitle"
  | "issueLabels"
>;

/** Provider-scoped equality; provider-owned ids are not globally unique. */
export const sameIssueIdentity = (
  left: Pick<IssueIdentity, "providerId" | "id">,
  right: Pick<IssueIdentity, "providerId" | "id">,
): boolean => left.providerId === right.providerId && left.id === right.id;

const historicalGithubIssueOf = (
  session: SessionIssueLinks,
): IssueReference | undefined =>
  session.issueNumber == null
    ? undefined
    : {
        providerId: "github",
        id: String(session.issueNumber),
        identifier: `#${session.issueNumber}`,
        url: session.issueUrl ?? "",
        title: session.issueTitle ?? `Issue #${session.issueNumber}`,
        labels: session.issueLabels ?? [],
      };

/**
 * Resolve every provider-neutral issue link without rewriting legacy data.
 *
 * The presence of `linkedIssues` marks the canonical representation, including
 * an explicitly empty array. Older singleton and GitHub-specific fields are
 * adapted only when that canonical field is absent.
 */
export const issueReferencesOf = (
  session: SessionIssueLinks,
): ReadonlyArray<IssueReference> => {
  if (session.linkedIssues !== undefined) return session.linkedIssues;
  if (session.linkedIssue) return [session.linkedIssue];
  const historical = historicalGithubIssueOf(session);
  return historical ? [historical] : [];
};

/** Resolve the selected issue, falling back to the newest canonical link. */
export const issueReferenceOf = (
  session: SessionIssueLinks,
): IssueReference | undefined => {
  const issues = issueReferencesOf(session);
  const requested = session.selectedIssue;
  if (requested) {
    const selected = issues.find((issue) =>
      sameIssueIdentity(issue, requested),
    );
    if (selected) return selected;
  }
  return issues.at(-1);
};

/** Find one provider's link without changing the session's visible selection. */
export const issueReferenceForProvider = (
  session: SessionIssueLinks,
  providerId: string,
): IssueReference | undefined =>
  issueReferencesOf(session).find((issue) => issue.providerId === providerId);

/** A missing environment id is deliberately the local desktop. */
export const executionTargetOf = (
  session: Pick<Session, "environmentId">,
):
  | { readonly kind: "local" }
  | { readonly kind: "remote"; readonly environmentId: string } =>
  session.environmentId === undefined
    ? { kind: "local" }
    : { kind: "remote", environmentId: session.environmentId };

/** Backward-compatible workspace ownership for persisted sessions. */
export const workspaceModeOf = (
  session: Pick<Session, "workspaceMode">,
): WorkspaceMode => session.workspaceMode ?? "worktree";

/** Backward-compatible persistence status for persisted sessions. */
export const persistentOf = (session: Pick<Session, "persistent">): boolean =>
  session.persistent ?? false;

/** Why a session was archived — matches `Session.archiveReason`. */
export const ArchiveReason = Schema.Literal("merged", "closed");
export type ArchiveReason = Schema.Schema.Type<typeof ArchiveReason>;

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
  /** Post minor/nit adversarial findings to the PR. Off keeps every finding local. */
  postAdversarialReviewComments: Schema.optional(Schema.Boolean),
  /** Desktop runtime and model used for adversarial reviews. The session model is the legacy fallback. */
  adversarialReviewModel: Schema.optional(AgentModelSelection),
});
export type GithubConfig = Schema.Schema.Type<typeof GithubConfig>;

/** The user's git behaviour preferences. Persisted inside `WorkspaceConfig`. */
export const GitConfig = Schema.Struct({
  /**
   * Allow opening a session from a PR whose head branch is already checked out
   * in another worktree (e.g. your main repo). When on, the session's worktree
   * shares the branch ref (`git checkout --ignore-other-worktrees`); when off,
   * git's safeguard is respected and the create fails with a clear error.
   */
  shareCheckedOutBranches: Schema.Boolean,
});
export type GitConfig = Schema.Schema.Type<typeof GitConfig>;

/**
 * What a desktop notification can be about.
 *
 * These are the moments a parallel operator cannot afford to miss while looking
 * at another session: the agent is BLOCKED on them, or it has stopped. Progress
 * is deliberately not among them — a notification per tool call would train the
 * operator to ignore the channel entirely.
 */
export const NotificationKind = Schema.Literal(
  "needs-input",
  "done",
  "failed",
  "pr",
);
export type NotificationKind = Schema.Schema.Type<typeof NotificationKind>;

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
  sound: Schema.Boolean,
});
export type NotificationsConfig = Schema.Schema.Type<
  typeof NotificationsConfig
>;

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
  sound: false,
};

/**
 * The global auto-compaction levers, persisted at `WorkspaceConfig.context`.
 *
 * Lives here rather than beside the policy in `context.ts` because it is
 * persisted configuration rather than compaction policy.
 */
export const ContextConfig = Schema.Struct({
  /** Master switch. Off returns the app to exactly its pre-feature behaviour. */
  auto: Schema.Boolean,
  /** Working-set budget in tokens, constrained to the usable quality band. */
  budgetTokens: Schema.Number.pipe(
    Schema.between(BUDGET_RANGE.min, BUDGET_RANGE.max),
  ),
});
export type ContextConfig = Schema.Schema.Type<typeof ContextConfig>;

/** The shipped defaults — auto ON, maximum quality-band budget. */
export const DEFAULT_CONTEXT_CONFIG: ContextConfig = {
  auto: true,
  budgetTokens: DEFAULT_BUDGET_TOKENS,
};

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
  /** Canonical provider defaults. Legacy settings are handled before schema decoding. */
  defaultConnectionId: Schema.optional(ProviderConnectionId),
  defaultProviderId: Schema.optional(ProviderId),
  defaultModelId: Schema.optional(ProviderModelId),
  /** Permission mode used for new chats across every provider model. */
  defaultMode: Schema.optional(ExecutionMode),
  /** @deprecated Migrated lazily into provider-scoped assignments. */
  subagentModels: Schema.optional(SubagentModelAssignments),
  /** Persistent provider-specific role-to-model overrides for managed subagents. */
  subagentModelsByProvider: Schema.optional(SubagentProviderModelAssignments),
  /** Default-on master switch for orchestrator delegation. */
  subagentDelegationEnabled: Schema.optional(Schema.Boolean),
  connectionSelectionRequired: Schema.optional(Schema.Boolean),
  /** First-run provider authentication was completed or explicitly skipped. */
  providerSetupCompleted: Schema.optional(Schema.Boolean),
  /** Custom PRD/MDX structure injected into every native planning turn. */
  planTemplate: Schema.optional(PlanTemplateConfig),
  /** @deprecated Retained only so older config files continue to decode. Plan mode now runs like Auto. */
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
   * Secret-free WebSearch setup choice. API keys live only in encrypted
   * credential storage and never cross this persistence boundary.
   */
  webSearch: Schema.optional(WebSearchConfig),
  /**
   * Automatic Cloudflare compute routing. Absent on older configs and therefore
   * disabled; explicit command allowlists contain argv only and never secrets.
   */
  offloadCompute: Schema.optional(OffloadComputeSettings),
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
  disabledPlugins: Schema.optional(Schema.Array(Schema.String)),
});
export type WorkspaceConfig = Schema.Schema.Type<typeof WorkspaceConfig>;

/** @deprecated Plan mode always uses Auto permissions. */
export const PLAN_AUTO_RUN_DEFAULT = true;

/** ADHD response shaping is opt-in — it rewrites the voice of every session. */
export const ADHD_MODE_DEFAULT = false;

/** Conversation + code text is unscaled (1×) unless the operator picks a size. */
export const FONT_SCALE_DEFAULT = 1;

/**
 * The usable band for the conversation text-size multiplier. The contract
 * enforces it on the write path (`Config.setFontScale`); `clampFontScale` guards
 * the READ path, where a hand-edited `config.json` can carry anything.
 */
export const FONT_SCALE_RANGE = { min: 0.5, max: 2 } as const;

/**
 * Coerce a stored/incoming multiplier into the usable band, mapping anything
 * non-finite (a hand-edited `NaN`, a missing value) back to the default. The one
 * place the range is applied, so a bad value can never scale the transcript to
 * zero or off-screen — on read or on write.
 */
export const clampFontScale = (value: number | null | undefined): number =>
  value !== null && value !== undefined && Number.isFinite(value)
    ? Math.min(FONT_SCALE_RANGE.max, Math.max(FONT_SCALE_RANGE.min, value))
    : FONT_SCALE_DEFAULT;

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
  githubSlug: Schema.NullOr(Schema.String),
});
export type Repo = Schema.Schema.Type<typeof Repo>;

/** An isolated git worktree created for a session. */
export const Worktree = Schema.Struct({
  /** Absolute path to the worktree, under `~/jingler/worktrees/…`. */
  path: Schema.String,
  /** The new branch checked out in the worktree (e.g. "refactor/auth-store"). */
  branch: Schema.String,
  /** The branch the worktree was forked from. */
  baseBranch: Schema.String,
  /** Absolute path to the origin repo the worktree belongs to. */
  repoPath: Schema.String,
});
export type Worktree = Schema.Schema.Type<typeof Worktree>;

// ── Pull requests / code review ──────────────────────────────────────────────

/** Overall state of a pull request. "draft" is synthesized from `isDraft`. */
export const PrState = Schema.Literal("open", "closed", "merged", "draft");
export type PrState = Schema.Schema.Type<typeof PrState>;

/** Normalized CI check status (mapped from GitHub checks and commit statuses). */
export const PrCheckStatus = Schema.Literal(
  "pass",
  "fail",
  "running",
  "pending",
);
export type PrCheckStatus = Schema.Schema.Type<typeof PrCheckStatus>;

/**
 * A session's linked PR, reduced to the two facts a sidebar row can show in one
 * glyph: where the PR is in its life, and whether CI is happy.
 *
 * Deliberately NOT the full `PullRequest`. This is polled for every session with
 * a PR, on a timer, forever — so it carries only what the row renders, and its
 * API read asks only for lifecycle/check fields. Anything richer belongs in
 * the Pull Request tab, which is fetched once, on demand, for one session.
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
  checks: Schema.NullOr(PrCheckStatus),
});
export type SessionPrStatus = Schema.Schema.Type<typeof SessionPrStatus>;

/** How a reviewer/timeline review resolved. "pending" = requested, not yet done. */
export const PrReviewKind = Schema.Literal(
  "commented",
  "approved",
  "changes_requested",
  "pending",
);
export type PrReviewKind = Schema.Schema.Type<typeof PrReviewKind>;

/** The kind of review a composer submits back to GitHub. */
export const ReviewSubmitKind = Schema.Literal(
  "comment",
  "approve",
  "request-changes",
);
export type ReviewSubmitKind = Schema.Schema.Type<typeof ReviewSubmitKind>;

/** The strategy the GitHub merge API uses when merging a pull request. */
export const PrMergeMethod = Schema.Literal("merge", "squash", "rebase");
export type PrMergeMethod = Schema.Schema.Type<typeof PrMergeMethod>;

/** A GitHub account reference (author / reviewer). */
export const GithubUser = Schema.Struct({
  login: Schema.String,
  avatarUrl: Schema.NullOr(Schema.String),
});
export type GithubUser = Schema.Schema.Type<typeof GithubUser>;

// ── Shared GitHub App connection ────────────────────────────────────────────

/** GitHub identity authorized for product access (not a BetterAuth login account). */
export const GitHubAppUser = Schema.Struct({
  id: Schema.String,
  login: Schema.String,
  name: Schema.NullOr(Schema.String),
  avatarUrl: Schema.NullOr(Schema.String),
});
export type GitHubAppUser = Schema.Schema.Type<typeof GitHubAppUser>;

/** One app installation visible to the authorized GitHub user. */
export const GitHubAppRepository = Schema.Struct({
  /** Immutable GitHub database id. */
  id: Schema.String,
  /** Canonical owner/repository name, retained for display and legacy lookup. */
  fullName: Schema.String,
});
export type GitHubAppRepository = Schema.Schema.Type<
  typeof GitHubAppRepository
>;

/** One app installation visible to the authorized GitHub user. */
export const GitHubAppInstallation = Schema.Struct({
  id: Schema.String,
  account: Schema.Struct({
    id: Schema.String,
    login: Schema.String,
    type: Schema.String,
    avatarUrl: Schema.NullOr(Schema.String),
  }),
  repositorySelection: Schema.Literal("all", "selected"),
  /**
   * Repositories proven visible through this installation. Optional so status
   * snapshots persisted by pre-migration desktop builds remain decodable.
   */
  repositories: Schema.optional(Schema.Array(GitHubAppRepository)),
  permissions: Schema.Record({ key: Schema.String, value: Schema.String }),
  status: Schema.Literal("active", "suspended"),
  suspendedAt: Schema.NullOr(Schema.String),
});
export type GitHubAppInstallation = Schema.Schema.Type<
  typeof GitHubAppInstallation
>;

/** Renderer-safe connection view. No user, refresh, or installation token fields. */
export const GitHubAppConnectionStatus = Schema.Struct({
  enabled: Schema.Boolean,
  connected: Schema.Boolean,
  /** Authenticated host GitHub CLI; supports product operations but not realtime webhooks. */
  cliAvailable: Schema.optional(Schema.Boolean),
  user: Schema.NullOr(GitHubAppUser),
  installations: Schema.Array(GitHubAppInstallation),
  lastRefreshedAt: Schema.NullOr(Schema.String),
});
export type GitHubAppConnectionStatus = Schema.Schema.Type<
  typeof GitHubAppConnectionStatus
>;

/** Installation-aware mode shown by onboarding, Settings, and recovery states. */
export const GitHubConnectionMode = Schema.Literal(
  "disconnected",
  "connecting",
  "connected",
  "partial-access",
  "suspended",
  "error",
);
export type GitHubConnectionMode = Schema.Schema.Type<
  typeof GitHubConnectionMode
>;

/**
 * Renderer-facing GitHub App state. This deliberately remains separate from
 * BetterAuth's GitHub social identity and from any local command discovery.
 */
export const GitHubConnection = Schema.Struct({
  mode: GitHubConnectionMode,
  enabled: Schema.Boolean,
  connected: Schema.Boolean,
  cliAvailable: Schema.optional(Schema.Boolean),
  user: Schema.NullOr(GitHubAppUser),
  installations: Schema.Array(GitHubAppInstallation),
  lastRefreshedAt: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
});
export type GitHubConnection = Schema.Schema.Type<typeof GitHubConnection>;

/** Whether one local repository can use the live GitHub App installation. */
export const GitHubRepositoryAccess = Schema.Struct({
  status: Schema.Literal("accessible", "partial", "suspended", "unavailable"),
  installationId: Schema.NullOr(Schema.String),
  accountLogin: Schema.NullOr(Schema.String),
  reason: Schema.String,
});
export type GitHubRepositoryAccess = Schema.Schema.Type<
  typeof GitHubRepositoryAccess
>;

/** Authorization the desktop main process can exchange with the configured relay. */
export const GitHubDesktopGrantClaims = Schema.Struct({
  version: Schema.Literal(1),
  issuer: Schema.Literal("jingler"),
  audience: Schema.Literal("jingler-github-relay"),
  subject: Schema.String,
  installationId: Schema.String,
  issuedAt: Schema.Number,
  expiresAt: Schema.Number,
  grantId: Schema.String,
});
export type GitHubDesktopGrantClaims = Schema.Schema.Type<
  typeof GitHubDesktopGrantClaims
>;

export const GitHubDesktopGrantResponse = Schema.Struct({
  relayUrl: Schema.String,
  grant: Schema.String,
  claims: GitHubDesktopGrantClaims,
});
export type GitHubDesktopGrantResponse = Schema.Schema.Type<
  typeof GitHubDesktopGrantResponse
>;

/** Server-owned lifecycle for one exact local-session to pull-request relay route. */
export const GitHubSessionRouteState = Schema.Literal(
  "active",
  "archived",
  "removed",
);
export type GitHubSessionRouteState = Schema.Schema.Type<
  typeof GitHubSessionRouteState
>;

/**
 * Renderer-safe route metadata. `sessionId` never enters relay registration or
 * grant payloads; the relay sees only the opaque, unguessable `relaySessionId`.
 */
export const GitHubSessionRoute = Schema.Struct({
  sessionId: Schema.String,
  relaySessionId: Schema.String,
  installationId: Schema.String,
  repositoryId: Schema.String,
  pullRequestNumber: Schema.Number,
  state: GitHubSessionRouteState,
  updatedAt: Schema.String,
});
export type GitHubSessionRoute = Schema.Schema.Type<typeof GitHubSessionRoute>;

/** Five-minute relay credential scoped to exactly one SessionEventsObject. */
export const GitHubSessionRelayGrantClaims = Schema.Struct({
  version: Schema.Literal(1),
  issuer: Schema.Literal("jingler"),
  audience: Schema.Literal("jingler-github-relay"),
  subject: Schema.String,
  installationId: Schema.String,
  relaySessionId: Schema.String,
  issuedAt: Schema.Number,
  expiresAt: Schema.Number,
  grantId: Schema.String,
});
export type GitHubSessionRelayGrantClaims = Schema.Schema.Type<
  typeof GitHubSessionRelayGrantClaims
>;

export const GitHubSessionRelayGrantResponse = Schema.Struct({
  relayUrl: Schema.String,
  grant: Schema.String,
  claims: GitHubSessionRelayGrantClaims,
});
export type GitHubSessionRelayGrantResponse = Schema.Schema.Type<
  typeof GitHubSessionRelayGrantResponse
>;

export const GitHubRelayEventName = Schema.Literal(
  "pull_request_review",
  "pull_request_review_comment",
  "issue_comment",
  "pull_request",
  "check_run",
  "check_suite",
  "status",
);
export type GitHubRelayEventName = Schema.Schema.Type<
  typeof GitHubRelayEventName
>;

/** Renderer-safe, versioned event produced only after webhook verification. */
export const GitHubRelayEvent = Schema.Struct({
  version: Schema.Literal(1),
  deliveryId: Schema.String,
  semanticKey: Schema.String,
  event: GitHubRelayEventName,
  action: Schema.String,
  installationId: Schema.String,
  repository: Schema.Struct({
    id: Schema.String,
    owner: Schema.String,
    name: Schema.String,
    fullName: Schema.String,
  }),
  pullRequest: Schema.NullOr(
    Schema.Struct({
      id: Schema.String,
      number: Schema.Number,
      title: Schema.String,
      url: Schema.String,
      headSha: Schema.String,
      baseSha: Schema.String,
    }),
  ),
  actor: Schema.Struct({
    id: Schema.String,
    login: Schema.String,
    type: Schema.String,
  }),
  feedback: Schema.NullOr(
    Schema.Struct({
      kind: Schema.Literal("review", "review-comment", "issue-comment"),
      id: Schema.String,
      body: Schema.String,
      state: Schema.NullOr(Schema.String),
      path: Schema.NullOr(Schema.String),
      line: Schema.NullOr(Schema.Number),
      side: Schema.NullOr(Schema.String),
    }),
  ),
  actionable: Schema.Boolean,
  occurredAt: Schema.String,
});
export type GitHubRelayEvent = Schema.Schema.Type<typeof GitHubRelayEvent>;

export const GitHubFeedbackOutboxStatus = Schema.Literal(
  "pending",
  "dispatched",
);
export type GitHubFeedbackOutboxStatus = Schema.Schema.Type<
  typeof GitHubFeedbackOutboxStatus
>;

/** Durable exact-session instruction written before any conversation dispatch. */
export const GitHubFeedbackOutboxEntry = Schema.Struct({
  sessionId: Schema.String,
  chatId: Schema.String,
  installationId: Schema.String,
  repositoryId: Schema.String,
  prNumber: Schema.Number,
  event: GitHubRelayEvent,
  status: GitHubFeedbackOutboxStatus,
  createdAt: Schema.String,
  dispatchedAt: Schema.NullOr(Schema.String),
});
export type GitHubFeedbackOutboxEntry = Schema.Schema.Type<
  typeof GitHubFeedbackOutboxEntry
>;

export const GitHubFeedbackClaimStatus = Schema.Literal(
  "pending",
  "dispatched",
  "rejected",
);
export type GitHubFeedbackClaimStatus = Schema.Schema.Type<
  typeof GitHubFeedbackClaimStatus
>;

/** One relay frame awaiting durable renderer routing and cursor acknowledgement. */
export const GitHubRelayDelivery = Schema.Struct({
  clientId: Schema.String,
  cursor: Schema.Number,
  event: GitHubRelayEvent,
  relaySessionId: Schema.String,
  sessionId: Schema.String,
  chatId: Schema.String,
});
export type GitHubRelayDelivery = Schema.Schema.Type<
  typeof GitHubRelayDelivery
>;

/** Recoverable main-process relay supervision state, safe for renderer display. */
export const GitHubRelayConnectionUpdate = Schema.Struct({
  installationId: Schema.NullOr(Schema.String),
  relaySessionId: Schema.NullOr(Schema.String),
  sessionId: Schema.NullOr(Schema.String),
  mode: Schema.Literal(
    "connecting",
    "connected",
    "reconnecting",
    "error",
    "stopped",
  ),
  error: Schema.NullOr(Schema.String),
});
export type GitHubRelayConnectionUpdate = Schema.Schema.Type<
  typeof GitHubRelayConnectionUpdate
>;

export const GitHubRelayStreamMessage = Schema.Union(
  GitHubRelayDelivery,
  GitHubRelayConnectionUpdate,
);
export type GitHubRelayStreamMessage = Schema.Schema.Type<
  typeof GitHubRelayStreamMessage
>;

/** Rate-limit metadata captured from every GitHub API response. */
export const GitHubRateLimit = Schema.Struct({
  limit: Schema.NullOr(Schema.Number),
  remaining: Schema.NullOr(Schema.Number),
  used: Schema.NullOr(Schema.Number),
  resetAt: Schema.NullOr(Schema.String),
});
export type GitHubRateLimit = Schema.Schema.Type<typeof GitHubRateLimit>;

/** A PR label chip. */
export const PrLabel = Schema.Struct({
  name: Schema.String,
  color: Schema.NullOr(Schema.String),
});
export type PrLabel = Schema.Schema.Type<typeof PrLabel>;

/** A requested/actual reviewer and their current state. */
export const PrReviewer = Schema.Struct({
  login: Schema.String,
  state: PrReviewKind,
});
export type PrReviewer = Schema.Schema.Type<typeof PrReviewer>;

/** One CI check on a PR. */
export const PrCheck = Schema.Struct({
  name: Schema.String,
  status: PrCheckStatus,
  /** Link to the run's details page, or null. */
  detailsUrl: Schema.NullOr(Schema.String),
  /** Duration in milliseconds when known, or null (still running / not reported). */
  durationMs: Schema.NullOr(Schema.Number),
});
export type PrCheck = Schema.Schema.Type<typeof PrCheck>;

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
  line: Schema.NullOr(Schema.Number),
});
export type PrTimelineItem = Schema.Schema.Type<typeof PrTimelineItem>;

/** GitHub's relationship between a commenter and the repo (drives the chips). */
export const PrAuthorAssociation = Schema.Literal(
  "OWNER",
  "MEMBER",
  "COLLABORATOR",
  "CONTRIBUTOR",
  "FIRST_TIME_CONTRIBUTOR",
  "FIRST_TIMER",
  "MANNEQUIN",
  "NONE",
);
export type PrAuthorAssociation = Schema.Schema.Type<
  typeof PrAuthorAssociation
>;

/** A reaction tally on a comment — e.g. `THUMBS_UP` × 1. Zero-counts are dropped. */
export const PrReaction = Schema.Struct({
  content: Schema.String,
  count: Schema.Number,
});
export type PrReaction = Schema.Schema.Type<typeof PrReaction>;

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
  reactions: Schema.Array(PrReaction),
});
export type PrThreadComment = Schema.Schema.Type<typeof PrThreadComment>;

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
  comments: Schema.Array(PrThreadComment),
});
export type PrReviewThread = Schema.Schema.Type<typeof PrReviewThread>;

/** A changed file in a PR, for the Code Review file list. */
export const PrFileChange = Schema.Struct({
  path: Schema.String,
  additions: Schema.Number,
  deletions: Schema.Number,
  /** Inline-comment count on this file. */
  commentCount: Schema.Number,
  /** Whether the reviewer marked the file viewed (false in v1). */
  viewed: Schema.Boolean,
});
export type PrFileChange = Schema.Schema.Type<typeof PrFileChange>;

/** One commit in a pull request's commit history. */
export const PrCommit = Schema.Struct({
  sha: Schema.String,
  message: Schema.String,
  author: Schema.String,
  committedAt: Schema.String,
  url: Schema.String,
  verified: Schema.Boolean,
});
export type PrCommit = Schema.Schema.Type<typeof PrCommit>;

/**
 * A pull request linked to a session, assembled from GitHub REST and GraphQL
 * responses. Read-only view model for the Pull Request tab.
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
  commitItems: Schema.optional(Schema.Array(PrCommit)),
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
  mergeBlockers: Schema.Array(Schema.String),
});
export type PullRequest = Schema.Schema.Type<typeof PullRequest>;

/**
 * A lightweight PR list-item for the "new session from a PR" picker. Distinct
 * from the full `PullRequest` view model —
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
  updatedAt: Schema.String,
});
export type PrSummary = Schema.Schema.Type<typeof PrSummary>;

/** One row in the global pull-request inbox. */
export const PullRequestListItem = Schema.extend(
  PrSummary,
  Schema.Struct({
    repository: Schema.String,
    labels: Schema.Array(PrLabel),
    comments: Schema.Number,
    assignedToViewer: Schema.Boolean,
    reviewRequestedFromViewer: Schema.Boolean,
  }),
);
export type PullRequestListItem = Schema.Schema.Type<typeof PullRequestListItem>;

/** CLI account identity: stable GitHub user id, never credentials. */
export const GitHubCliAccount = Schema.Struct({ id: Schema.String, login: Schema.String });
export type GitHubCliAccount = Schema.Schema.Type<typeof GitHubCliAccount>;

export const GitHubTeam = Schema.Struct({
  id: Schema.String,
  organization: Schema.String,
  slug: Schema.String,
  name: Schema.String,
});
export type GitHubTeam = Schema.Schema.Type<typeof GitHubTeam>;

export const GitHubTeamQueue = Schema.Literal("reviews", "authored", "repositories");
export type GitHubTeamQueue = Schema.Schema.Type<typeof GitHubTeamQueue>;

export const GitHubTeamDiscovery = Schema.Struct({
  account: GitHubCliAccount,
  teams: Schema.Array(GitHubTeam),
});
export type GitHubTeamDiscovery = Schema.Schema.Type<typeof GitHubTeamDiscovery>;

export const GitHubTeamPrResult = Schema.Struct({
  prs: Schema.Array(PullRequestListItem),
  /** Nonempty when any discovery/search portion was incomplete. */
  warnings: Schema.Array(Schema.String),
});
export type GitHubTeamPrResult = Schema.Schema.Type<typeof GitHubTeamPrResult>;

/** A provider-neutral person reference used by issue metadata. */
export const IssueActor = Schema.Struct({
  /** Provider-owned opaque id. */
  id: Schema.String,
  /** Display name or handle suitable for UI. */
  name: Schema.String,
  avatarUrl: Schema.NullOr(Schema.String),
});
export type IssueActor = Schema.Schema.Type<typeof IssueActor>;

const IssueSummaryFields = {
  ...IssueReferenceFields,
  /** Normalized lifecycle state; provider-specific states stay in the host. */
  state: Schema.Literal("open", "closed"),
  /** Markdown body used to seed the session task. */
  body: Schema.String,
  author: Schema.NullOr(IssueActor),
  assignees: Schema.Array(IssueActor),
  /** ISO-8601 last-updated timestamp. */
  updatedAt: Schema.String,
};

/** A normalized issue list item returned by any issue provider. */
export const IssueSummary = Schema.Struct(IssueSummaryFields);
export type IssueSummary = Schema.Schema.Type<typeof IssueSummary>;

/** A normalized comment on an issue. */
export const IssueComment = Schema.Struct({
  /** Provider-owned opaque id. */
  id: Schema.String,
  author: Schema.NullOr(IssueActor),
  body: Schema.String,
  createdAt: Schema.String,
  url: Schema.optional(Schema.String),
});
export type IssueComment = Schema.Schema.Type<typeof IssueComment>;

/** The normalized rich issue payload returned by any issue provider. */
export const IssueDetail = Schema.Struct({
  ...IssueSummaryFields,
  createdAt: Schema.String,
  comments: Schema.Array(IssueComment),
});
export type IssueDetail = Schema.Schema.Type<typeof IssueDetail>;

/** @deprecated Use {@link IssueDetail}. */
export const Issue = IssueDetail;
/** @deprecated Use {@link IssueDetail}. */
export type Issue = IssueDetail;

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
  body: Schema.String,
});
export type ReviewComment = Schema.Schema.Type<typeof ReviewComment>;

// ── Adversarial review ───────────────────────────────────────────────────────

/**
 * How bad a finding is, as argued by the reviewer. The reviewer is asked for
 * COVERAGE (report everything, tag it honestly) rather than to self-filter —
 * a model told "only report high-severity issues" silently drops findings it
 * judges below the bar, which reads as a recall regression. Filtering is the
 * UI's job, which is why this field exists.
 */
export const ReviewSeverity = Schema.Literal(
  "critical",
  "major",
  "minor",
  "nit",
);
export type ReviewSeverity = Schema.Schema.Type<typeof ReviewSeverity>;

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
  at: Schema.String,
});
export type ReviewResolution = Schema.Schema.Type<typeof ReviewResolution>;

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
  resolvedBy: Schema.optionalWith(Schema.NullOr(ReviewResolution), {
    default: () => null,
  }),
});
export type ReviewFinding = Schema.Schema.Type<typeof ReviewFinding>;

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
  /** Canonical runtime identity. Null only for reviews migrated from harness-era storage. */
  connectionId: Schema.NullOr(ProviderConnectionId),
  providerId: Schema.NullOr(ProviderId),
  modelId: Schema.NullOr(ProviderModelId),
  /** Decoder-only display provenance for a review written before provider model ids. */
  legacyModel: Schema.optional(Schema.String),
  /** ISO-8601 timestamp of the run. */
  createdAt: Schema.String,
  findings: Schema.Array(ReviewFinding),
  /** Whether low-severity findings from this run may be published to GitHub. */
  postToPr: Schema.optional(Schema.Boolean),
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
  routedAt: Schema.optionalWith(Schema.NullOr(Schema.String), {
    default: () => null,
  }),
  /**
   * ISO-8601 stamp of when this review's minor/nit findings were posted to the
   * PR as inline comments, or null when they weren't (none to post, or the post
   * failed — `postError` distinguishes the two).
   */
  postedAt: Schema.optionalWith(Schema.NullOr(Schema.String), {
    default: () => null,
  }),
  /**
   * Why posting the minor/nit half to the PR failed, or null.
   *
   * Posting is best-effort: a review costs real tokens and its verdict is useful
   * whether or not GitHub accepted the comments, so an API failure lands here
   * instead of failing the run and throwing the findings away.
   */
  postError: Schema.optionalWith(Schema.NullOr(Schema.String), {
    default: () => null,
  }),
});
export type AdversarialReview = Schema.Schema.Type<typeof AdversarialReview>;

/** Human-readable model attribution for current and migrated reviews. */
export const adversarialReviewModelLabel = (
  review: AdversarialReview,
): string => review.modelId ?? review.legacyModel ?? "Unknown model";

/** Parameters for creating a new session. */
export const CreateSessionInput = Schema.Struct({
  routineOccurrence: Schema.optional(Schema.Struct({ routineId: Schema.String, runId: Schema.String })),
  /** Explicit consent to edit/inspect-only managed Pi checkpoint execution. */
  checkpointSafeMode: Schema.optional(Schema.Boolean),
  /** Internal remote provision fence; omitted by renderer-originated requests. */
  requestedSessionId: Schema.optional(
    Schema.String.pipe(Schema.pattern(/^s_[A-Za-z0-9_-]{8,120}$/u)),
  ),
  /** Paired execution device. Omitted means this desktop. */
  environmentId: Schema.optional(Schema.String),
  /** Registered project to resolve at the execution boundary. */
  projectId: Schema.optional(Schema.String),
  /** Absolute path to the origin repo. */
  repoPath: Schema.String,
  /** The repo's folder name, used for grouping + the worktree directory. */
  repoName: Schema.String,
  /** Canonical owner/repository identity when known at creation time. */
  githubSlug: Schema.optional(Schema.String),
  /**
   * Optional session title. When omitted/blank the session is auto-named by the
   * agent; when provided it seeds and pins the display title. A fresh worktree
   * with an initial prompt gets its validated semantic branch before creation
   * returns; a promptless session stays detached until task understanding runs.
   */
  title: Schema.optional(Schema.String),
  /** Optional first task, opened as the new workspace's initial composer draft. */
  initialPrompt: Schema.optional(Schema.String),
  /** Canonical, explicitly authenticated runtime route. */
  runtimeId: Schema.optional(AgentRuntimeId),
  endpointId: Schema.optional(AgentEndpointId),
  connectionId: Schema.optional(ProviderConnectionId),
  providerId: ProviderId,
  modelId: ProviderModelId,
  /** Optional permission mode selected in the new-session composer. */
  mode: Schema.optional(PermissionMode),
  /**
   * Optional reasoning override selected in the new-session composer. `null`
   * explicitly preserves the provider default; omission keeps compatibility with
   * callers that expect the configured provider default to be applied.
   */
  reasoning: Schema.optional(Schema.NullOr(ReasoningSetting)),
  /** The branch to fork the worktree from, or check out for a direct session. */
  baseBranch: Schema.String,
  /**
   * Whether to create an isolated linked worktree. Omitted defaults to true so
   * existing callers and persisted RPC requests retain the current behaviour.
   */
  useWorktree: Schema.optional(Schema.Boolean),
  /** Continue the selected branch instead of creating a fresh semantic task branch. */
  continueBranch: Schema.optional(Schema.Boolean),
});
export type CreateSessionInput = Schema.Schema.Type<typeof CreateSessionInput>;

/**
 * Parameters for creating a session from an *existing* pull request. Unlike
 * `CreateSessionInput` (which starts detached before creating a semantic branch), this
 * checks out the PR's head branch into the worktree so the agent's commits
 * update the PR directly. Title + base come from the PR itself.
 */
export const CreateSessionFromPrInput = Schema.Struct({
  projectId: Schema.optional(Schema.String),
  /** Initial team-inbox checkout must use this CLI identity; never persisted on the session. */
  githubCliAccountId: Schema.optional(Schema.String),
  requestedSessionId: Schema.optional(
    Schema.String.pipe(Schema.pattern(/^s_[A-Za-z0-9_-]{8,120}$/u)),
  ),
  /** Paired execution device. Omitted means this desktop. */
  environmentId: Schema.optional(Schema.String),
  /** Absolute path to the origin repo. */
  repoPath: Schema.String,
  /** The repo's folder name, used for grouping + the worktree directory. */
  repoName: Schema.String,
  /** Canonical owner/repository identity when known at creation time. */
  githubSlug: Schema.optional(Schema.String),
  /** Canonical, explicitly authenticated runtime route. */
  runtimeId: Schema.optional(AgentRuntimeId),
  endpointId: Schema.optional(AgentEndpointId),
  connectionId: Schema.optional(ProviderConnectionId),
  providerId: ProviderId,
  modelId: ProviderModelId,
  mode: Schema.optional(PermissionMode),
  reasoning: Schema.optional(Schema.NullOr(ReasoningSetting)),
  initialPrompt: Schema.optional(Schema.String),
  /** The pull request to base the session on. */
  pr: Schema.Struct({
    number: Schema.Number,
    title: Schema.String,
    headRefName: Schema.String,
    baseRefName: Schema.String,
  }),
});
export type CreateSessionFromPrInput = Schema.Schema.Type<
  typeof CreateSessionFromPrInput
>;

/**
 * Parameters for creating a session from a provider-normalized issue. Unlike
 * `CreateSessionFromPrInput` (which checks out an existing PR branch), this
 * starts detached from `baseBranch` like a blank session,
 * links the issue, and seeds the task from the issue title + body.
 */
export const CreateSessionFromIssueInput = Schema.Struct({
  projectId: Schema.optional(Schema.String),
  requestedSessionId: Schema.optional(
    Schema.String.pipe(Schema.pattern(/^s_[A-Za-z0-9_-]{8,120}$/u)),
  ),
  /** Paired execution device. Omitted means this desktop. */
  environmentId: Schema.optional(Schema.String),
  /** Absolute path to the origin repo. */
  repoPath: Schema.String,
  /** The repo's folder name, used for grouping + the worktree directory. */
  repoName: Schema.String,
  /** Canonical owner/repository identity when known at creation time. */
  githubSlug: Schema.optional(Schema.String),
  /** Canonical, explicitly authenticated runtime route. */
  runtimeId: Schema.optional(AgentRuntimeId),
  endpointId: Schema.optional(AgentEndpointId),
  connectionId: Schema.optional(ProviderConnectionId),
  providerId: ProviderId,
  modelId: ProviderModelId,
  mode: Schema.optional(PermissionMode),
  reasoning: Schema.optional(Schema.NullOr(ReasoningSetting)),
  /** The branch to fork the worktree from. */
  baseBranch: Schema.String,
  /** The issue to link + seed the task from. */
  issue: IssueSummary,
  /**
   * The (editable) task to seed the composer with — prefilled from the issue in
   * the dialog. Empty falls back to the issue title + body.
   */
  task: Schema.String,
  /** GitHub-only automations. Other providers omit this field. */
  automations: Schema.optional(IssueAutomations),
});
export type CreateSessionFromIssueInput = Schema.Schema.Type<
  typeof CreateSessionFromIssueInput
>;

// ── Terminal ─────────────────────────────────────────────────────────────────

/** Lifecycle of a PTY-backed terminal. */
export const TerminalStatus = Schema.Literal("running", "exited");
export type TerminalStatus = Schema.Schema.Type<typeof TerminalStatus>;

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
  exitCode: Schema.NullOr(Schema.Number),
});
export type TerminalInfo = Schema.Schema.Type<typeof TerminalInfo>;

/**
 * One frame on a terminal's `attach` stream. Output frames carry a
 * *coalesced* run of PTY bytes (the service batches raw `onData` chunks on a
 * short tick / size threshold so throughput events stay bounded — the crux of
 * the perf story). An `exit` frame is emitted once, last, when the shell dies.
 */
export const TerminalChunk = Schema.Union(
  Schema.Struct({ _tag: Schema.Literal("data"), data: Schema.String }),
  Schema.Struct({ _tag: Schema.Literal("exit"), exitCode: Schema.Number }),
);
export type TerminalChunk = Schema.Schema.Type<typeof TerminalChunk>;

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
  height: Schema.Number,
});
export type BrowserBounds = Schema.Schema.Type<typeof BrowserBounds>;

// The conversation/transcript model (Message, ToolCall, ApprovalGate) and the
// normalized StreamEvent seam live in ./conversation.ts.
