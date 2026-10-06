import { setWorkspaceCheckpointMode } from "./workspace-admission.js"
import { closeWorkspaceAdmission, reopenWorkspaceAdmission, workspaceActivityCount, setWorkspaceAdmissionReadiness } from "./workspace-admission.js"
import { allocateWorkspacePorts } from "./workspace-ports.js"
import { ProjectService } from "./projects.js"
import { approvedWorkflow } from "./project-workflow.js"
import { createHash } from "node:crypto"
import type {
  AgentEndpointId,
  AgentRuntimeId,
  Chat,
  CreateSessionFromIssueInput,
  CreateSessionFromPrInput,
  CreateSessionInput,
  GitHubFeedbackClaimStatus,
  GitHubFeedbackOutboxEntry,
  GitHubRelayEvent,
  IssueAutomations,
  IssueIdentity,
  IssueReference,
  PermissionMode,
  ProviderConnectionId,
  ProviderId,
  ProviderModelId,
  RuntimeContinuation,
  Session,
  SettledSessionStatus,
  WorkspaceLifecycle,
  WorkspaceMode
} from "@jingler/core"
import {
  type GitHubApiError,
  GitError,
  issueReferenceOf,
  piEndpointId,
  issueReferencesOf,
  sameIssueIdentity,
  ReasoningSetting,
  semanticBranchProposalFromName,
  SessionNotFoundError,
  UNTITLED_SESSION,
  workspaceModeOf
} from "@jingler/core"
import { Session as SessionSchema } from "@jingler/core"
import { GitHubFeedbackOutboxEntry as GitHubFeedbackOutboxEntrySchema } from "@jingler/core"
import { basename } from "node:path"
import { FileSystem, type Path } from "@effect/platform"
import type { CommandExecutor } from "@effect/platform"
import { Effect, Either, Schema } from "effect"
import { AppPaths } from "./app-paths.js"
import { displayNameFromCreativeSlug, freeCreativeName } from "./creative-name.js"
import { GitHubApi } from "./github-api.js"
import { GitService } from "./git.js"
import { migrateLegacyRuntimeIdentity } from "./runtime/migration/legacy-runtime-identity.js"

const updateWorkspaceReadiness = (session: Session): void => {
  setWorkspaceCheckpointMode(session.id, session.checkpointSafeMode === true)
  const status = session.workspaceLifecycle?.status
  const reason = session.archived ? "the workspace is archived" :
    status && status !== "ready" && status !== "setup-skipped" ? `workspace ${status}` : undefined
  setWorkspaceAdmissionReadiness(session.id, reason)
}

const SessionArray = Schema.Array(SessionSchema)
const GitHubFeedbackOutbox = Schema.Array(GitHubFeedbackOutboxEntrySchema)

// These migration adapters deliberately accept historical JSON and return invalid
// representations unchanged for the canonical Effect Schema decoder below. The
// runtime discriminator checks are the parser at this persistence boundary.
/* oxlint-disable anti-slop/no-known-value-widening, anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-unsafe-dictionary-type */
type JsonRecord = Record<string, unknown>
const LegacyReasoningMap = Schema.Record({ key: Schema.String, value: Schema.Unknown })
const LegacyChatObject = Schema.Struct({
  id: Schema.optional(Schema.Unknown),
  providerId: Schema.optional(Schema.Unknown),
  mode: Schema.optional(Schema.Unknown),
  reasoning: Schema.optional(Schema.Unknown)
})
const LegacyChatWithId = Schema.Struct({ id: Schema.String })
const LegacySessionWithChats = Schema.Struct({
  id: Schema.String,
  updatedAt: Schema.optional(Schema.Unknown),
  chats: Schema.optional(Schema.Unknown),
  closedChats: Schema.optional(Schema.Unknown),
  activeChatId: Schema.optional(Schema.Unknown),
  providerId: Schema.optional(Schema.Unknown),
  legacyCli: Schema.optional(Schema.Unknown),
  reasoning: Schema.optional(Schema.Unknown),
  reasoningEffort: Schema.optional(Schema.Unknown),
  resumeId: Schema.optional(Schema.Unknown),
  mode: Schema.optional(Schema.Unknown),
  allowlist: Schema.optional(Schema.Unknown),
  model: Schema.optional(Schema.Unknown)
})
const LegacySessionWithRepo = Schema.Struct({
  repoPath: Schema.optional(Schema.Unknown),
  environmentId: Schema.optional(Schema.Unknown),
  repo: Schema.optional(Schema.Unknown)
})

const propertiesWhen = <T extends object>(condition: boolean, properties: T) =>
  condition ? properties : {}

const chatIdFor = (sessionId: string, suffix: string): string => `c_${sessionId}_${suffix}`

const closedChatsAfter = (
  chat: Chat,
  existing: ReadonlyArray<Chat>,
  discard: boolean
): ReadonlyArray<Chat> => {
  const others = existing.filter((candidate) => candidate.id !== chat.id)
  return discard ? others : [chat, ...others]
}

const runtimeMode = (value: unknown): PermissionMode | undefined => {
  switch (value) {
    case "ask":
    case "accept-edits":
    case "auto":
    case "plan":
      return value
    default:
      return undefined
  }
}

const persistedMode = (value: unknown): PermissionMode | undefined =>
  runtimeMode(value) ?? (typeof value === "string" ? "ask" : undefined)

const initialChat = (
  sessionId: string,
  now: string,
  legacy: JsonRecord = {},
  runtime: {
    readonly runtimeId?: AgentRuntimeId
    readonly endpointId?: AgentEndpointId
    readonly connectionId?: ProviderConnectionId
    readonly providerId?: ProviderId
    readonly modelId?: ProviderModelId
    readonly reasoning?: ReasoningSetting
  } = {}
): Chat => {
  const mode = persistedMode(legacy.mode)
  const allowlist =
    Array.isArray(legacy.allowlist) &&
    legacy.allowlist.every((entry) => typeof entry === "string")
      ? legacy.allowlist
      : undefined
  const contextTokens =
    typeof legacy.contextTokens === "number" &&
    Number.isFinite(legacy.contextTokens) &&
    legacy.contextTokens >= 0
      ? legacy.contextTokens
      : undefined
  return {
    id: chatIdFor(sessionId, "1"),
    title: null,
    createdAt: now,
    updatedAt: now,
    ...propertiesWhen(mode !== undefined, { mode }),
    ...propertiesWhen(allowlist !== undefined, { allowlist }),
    ...propertiesWhen(contextTokens !== undefined, { contextTokens }),
    ...runtime
  }
}

const legacyInitialChat = (sessionId: string, now: string, legacy: JsonRecord): JsonRecord => ({
  ...initialChat(sessionId, now, legacy),
  ...propertiesWhen(typeof legacy.resumeId === "string", { resumeId: legacy.resumeId }),
  ...propertiesWhen(typeof legacy.model === "string", { model: legacy.model })
})

const runtimeSelection = (input: {
  readonly environmentId?: string
  readonly runtimeId?: AgentRuntimeId
  readonly endpointId?: AgentEndpointId
  readonly connectionId?: ProviderConnectionId
  readonly providerId?: ProviderId
  readonly modelId?: ProviderModelId
}) => {
  const connectionId = input.connectionId
  const runtimeId = input.runtimeId ?? "pi"
  const endpointId = input.endpointId ?? (
    runtimeId === "pi" && connectionId !== undefined
      ? piEndpointId(input.environmentId ?? "desktop", connectionId)
      : undefined
  )
  return {
    runtimeId,
    ...(endpointId === undefined ? {} : { endpointId }),
    ...(connectionId === undefined ? {} : { connectionId }),
    ...propertiesWhen(input.providerId !== undefined, { providerId: input.providerId }),
    ...propertiesWhen(input.modelId !== undefined, { modelId: input.modelId })
  }
}

const migrateReasoning = (value: unknown): ReasoningSetting | undefined => {
  switch (value) {
    case "off":
      return { enabled: false }
    case "think":
      return { enabled: true, effort: "low" }
    case "think-hard":
      return { enabled: true, effort: "high" }
    case "ultrathink":
      return { enabled: true, effort: "xhigh" }
    case "minimal":
    case "low":
    case "medium":
    case "high":
    case "xhigh":
    case "max":
      return { enabled: true, effort: value }
    case undefined:
      return undefined
    default:
      return { enabled: true }
  }
}

const reasoningKey = (cli: unknown): "claude" | "codex" | "opencode" | null =>
  cli === "claude" || cli === "codex" || cli === "opencode" ? cli : null

const reasoningKeyForProvider = (providerId: unknown) =>
  providerId === "anthropic"
    ? "claude" as const
    : providerId === "openai" || providerId === "openai-codex"
      ? "codex" as const
      : null

const legacyReasoningFor = (
  session: JsonRecord,
  chat: JsonRecord
): ReasoningSetting | undefined => {
  const stored = Schema.is(LegacyReasoningMap)(session.reasoning) ? session.reasoning : {}
  const key =
    reasoningKeyForProvider(chat.providerId) ??
    reasoningKeyForProvider(session.providerId) ??
    reasoningKey(session.legacyCli)
  const candidate = key === null ? undefined : stored[key]
  const decoded = Schema.decodeUnknownEither(ReasoningSetting)(candidate)
  if (Either.isRight(decoded)) return decoded.right
  return migrateReasoning(session.reasoningEffort)
}

/**
 * Upgrade the old one-session/one-transcript shape before schema decoding.
 * The transformation is deterministic, so a legacy file can be read repeatedly
 * before the next mutation persists the upgraded representation.
 */
export const migrateSessionChats = (value: unknown): unknown => {
  if (!Schema.is(LegacySessionWithChats)(value)) return value
  const now = typeof value.updatedAt === "string" ? value.updatedAt : new Date(0).toISOString()
  const migrateChat = (chat: unknown): unknown => {
    if (!Schema.is(LegacyChatObject)(chat)) return chat
    const reasoning = legacyReasoningFor(value, chat)
    return {
      ...chat,
      ...propertiesWhen(persistedMode(chat.mode) !== undefined, { mode: persistedMode(chat.mode) }),
      ...propertiesWhen(chat.reasoning === undefined && reasoning !== undefined, { reasoning })
    }
  }
  const rawChats =
    Array.isArray(value.chats) && value.chats.length > 0
      ? value.chats
      : [legacyInitialChat(value.id, now, value)]
  const chats = rawChats.map(migrateChat)
  const closedChats = Array.isArray(value.closedChats)
    ? value.closedChats.map(migrateChat)
    : value.closedChats
  const chatIds = new Set(
    chats.flatMap((chat) =>
      Schema.is(LegacyChatWithId)(chat) ? [chat.id] : []
    )
  )
  const activeChatId =
    typeof value.activeChatId === "string" && chatIds.has(value.activeChatId)
      ? value.activeChatId
      : (chatIds.values().next().value ?? chatIdFor(value.id, "1"))
  const {
    resumeId: _resumeId,
    mode: _mode,
    allowlist: _allowlist,
    model: _model,
    reasoning: _reasoning,
    reasoningEffort: _reasoningEffort,
    ...session
  } = value
  return {
    ...session,
    chats,
    ...propertiesWhen(closedChats !== undefined, { closedChats }),
    activeChatId
  }
}

/**
 * Re-derive `repo` from `repoPath` so renaming a repo directory does not strand
 * every existing session in a phantom sidebar group.
 *
 * `repo` is a DENORMALISED copy of the repo's folder name, snapshotted when the
 * session is created and never revisited — while the sidebar groups on exactly
 * that string (`session-filters.ts`, `groupSessions`). Rename
 * `~/repos/starbase` to `~/repos/jingler` and every session created before the
 * rename keeps grouping under "starbase": a heading naming a directory that no
 * longer exists, sitting next to a "jingler" group holding only the sessions
 * created since. The two are the same repo.
 *
 * `repoPath` is the identity and stays correct across a rename, so the display
 * name is recomputed on every read rather than trusted. Like
 * `migrateSessionChats` this is deterministic, so a stale file can be read
 * repeatedly and the corrected name is persisted by the next mutation.
 *
 * Sessions predating `repoPath` (it is `Schema.optional`) keep their stored
 * name — there is nothing better to derive one from, and a wrong group beats no
 * group.
 */
export const migrateRepoName = (value: unknown): unknown => {
  if (!Schema.is(LegacySessionWithRepo)(value)) return value
  const repoPath = typeof value.repoPath === "string" ? value.repoPath.trim() : ""
  if (repoPath.length === 0) return value
  // Managed sandboxes deliberately mount every repository at /workspace. That
  // path is runtime plumbing, not repository identity; the server-resolved
  // `repo` field remains canonical for remote sessions.
  if (repoPath === "/workspace" && typeof value.environmentId === "string") return value
  const derived = basename(repoPath)
  // `basename` yields "" for "/" and for a path that is only separators. An
  // empty group heading is worse than a stale one, so keep what was stored.
  if (derived.length === 0 || derived === value.repo) return value
  return { ...value, repo: derived }
}
/* oxlint-enable anti-slop/no-known-value-widening, anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-unsafe-dictionary-type */

/** Build the canonical multi-link fields while removing every historical alias. */
const withCanonicalIssues = (
  session: Session,
  linkedIssues: ReadonlyArray<IssueReference>,
  selectedIssue: IssueIdentity | undefined,
  automations: IssueAutomations | undefined = session.automations
): Session => {
  const {
    issueNumber: _issueNumber,
    issueUrl: _issueUrl,
    issueTitle: _issueTitle,
    issueLabels: _issueLabels,
    linkedIssue: _linkedIssue,
    linkedIssues: _linkedIssues,
    selectedIssue: _selectedIssue,
    automations: _automations,
    ...current
  } = session
  const selection = selectedIssue && linkedIssues.some((issue) =>
    sameIssueIdentity(issue, selectedIssue)
  )
    ? selectedIssue
    : linkedIssues.at(-1)
  return {
    ...current,
    ...propertiesWhen(linkedIssues.length > 0, { linkedIssues: [...linkedIssues] }),
    ...propertiesWhen(selection !== undefined, {
      selectedIssue: selection && { providerId: selection.providerId, id: selection.id }
    }),
    ...propertiesWhen(
      linkedIssues.some((issue) => issue.providerId === "github") && automations !== undefined,
      { automations }
    )
  }
}

/** Merge references by provider-scoped identity, preserving first-link order. */
export const mergeIssueReferences = (
  current: ReadonlyArray<IssueReference>,
  incoming: ReadonlyArray<IssueReference>
): ReadonlyArray<IssueReference> => {
  const merged: IssueReference[] = []
  for (const issue of [...current, ...incoming]) {
    const index = merged.findIndex((candidate) => sameIssueIdentity(candidate, issue))
    if (index === -1) merged.push(issue)
    else merged[index] = issue
  }
  return merged
}

/**
 * Migrate historical singleton aliases only when a session file is next written.
 * Reads remain side-effect free; every ordinary mutation upgrades the document.
 */
export const migrateSessionIssue = (session: Session): Session => {
  const linkedIssues = mergeIssueReferences([], issueReferencesOf(session))
  const selected = issueReferenceOf(session)
  return withCanonicalIssues(session, linkedIssues, selected)
}

/**
 * The longest slug we will put on disk.
 *
 * A slug becomes a DIRECTORY NAME (`~/jingler/worktrees/<repo>/<slug>`) and a
 * branch name, and most filesystems cap a single name at 255 bytes. Slugs are
 * derived from PR and issue titles, which have no such limit — a long issue
 * title produced a path `git worktree add` rejected with ENAMETOOLONG, failing
 * session creation outright.
 *
 * 100 leaves generous headroom for the `-<number>` and `-<stamp>` suffixes
 * appended after truncation, and for multi-byte characters surviving `kebab`.
 */
const MAX_SLUG = 100

/** Lowercase, collapse non-alphanumeric runs to single dashes, trim; fallback "session". */
export const taskSlug = (input: string): string =>
  input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG)
    // Truncation can land mid-word and leave a trailing dash; trim again so the
    // slug never ends in one.
    .replace(/-+$/g, "") || "session"

/** Keep the opaque issue identity intact when a human-readable slug collides. */
const disambiguateIssueSlug = (
  slug: string,
  issue: Pick<IssueReference, "providerId" | "id">
): string => {
  const suffix = createHash("sha256")
    .update(issue.providerId)
    .update("\0")
    .update(issue.id)
    .digest("hex")
    .slice(0, 12)
  const prefix = slug.slice(0, MAX_SLUG - suffix.length - 1).replace(/-+$/g, "")
  return `${prefix || "issue"}-${suffix}`
}

const sessionBelongsToRepository = (
  session: Session,
  repository: { readonly path: string; readonly name: string }
): boolean =>
  session.repoPath === undefined
    ? session.repo === repository.name
    : session.repoPath === repository.path

const sessionLinksIssue = (
  session: Session,
  repository: { readonly path: string; readonly name: string },
  issue: Pick<IssueReference, "providerId" | "id">
): boolean => {
  if (!sessionBelongsToRepository(session, repository)) return false
  return issueReferencesOf(session).some((linked) => sameIssueIdentity(linked, issue))
}

/**
 * Publish-readiness for the live branch, including persisted sessions created
 * before semantic proposals existed. The explicit pending marker is the
 * durable proof that a fresh task still needs branch creation; metadata absence
 * alone identifies neither freshness nor an error because historical and PR
 * sessions intentionally have established non-semantic branches.
 */
export const isSessionPublishBranchReady = (
  session: Pick<
    Session,
    "branch" | "semanticBranchPending" | "semanticBranchProposal" | "workspaceMode"
  >,
  liveBranch: string | null
): boolean => {
  if (workspaceModeOf(session) !== "worktree") return false
  if (session.semanticBranchPending === true) return false
  if (liveBranch === null || liveBranch !== session.branch) return false
  return session.semanticBranchProposal === undefined ||
    semanticBranchProposalFromName(liveBranch) !== null
}

type PersistEnv = FileSystem.FileSystem | AppPaths

/**
 * A process-wide monotonic counter, used wherever `Date.now()` is too coarse to
 * distinguish two operations. Two things happening in the same millisecond are
 * routine here — session creation is driven by the UI and by automation.
 */
let opSeq = 0
const nextOpId = (): number => ++opSeq

/**
 * The session store, persisted to `~/jingler/sessions.json`. Starts empty — real
 * sessions are created via `create`, which either forks an isolated git
 * worktree or records a guarded direct checkout before saving the session.
 * Reads are best-effort: a missing or malformed file yields an empty list so
 * the app still boots.
 */
export class SessionStore extends Effect.Service<SessionStore>()(
  "@jingler/SessionStore",
  {
    accessors: true,
    sync: () => {
    /**
     * Serialises every read-modify-write of `sessions.json`.
     *
     * The whole store is one JSON file rewritten wholesale, so any two
     * concurrent mutations race: each reads the array, edits its own session,
     * and writes the WHOLE thing back — and the later write silently discards
     * the earlier one's change.
     *
     * Two sessions created at once are enough to hit it: each reads the list,
     * then forks a worktree (seconds), then appends to the list it read — so
     * the second create writes a list that never contained the first session.
     *
     * One permit, held only across read-then-write and never across anything
     * slow (a worktree fork, a network call), so this serialises the file and
     * not the work.
     *
     * In-process only. It orders the app's own writers, which is what exists
     * today; it would not order a second Jingler process against this one.
     */
    const lock = Effect.unsafeMakeSemaphore(1)
    const pendingAgentModels = new Map<string, {
      readonly session: Pick<Session, "runtimeId" | "endpointId" | "connectionId" | "providerId" | "modelId" | "continuation">
      readonly chat: Chat
    }>()
    const pendingAgentModelKey = (sessionId: string, chatId: string) => `${sessionId}:${chatId}`
      const atomically = <A, E, R>(
        effect: Effect.Effect<A, E, R>
      ): Effect.Effect<A, E, R> => lock.withPermits(1)(effect)
      const assignPorts = (session: Session, current: readonly Session[]) => Effect.gen(function* () {
        if (session.environmentId || session.workspaceMode === "direct" || !session.worktreePath || session.workspacePorts) return session
        const projectService = yield* Effect.serviceOption(ProjectService)
        const project = session.projectId && projectService._tag === "Some" ? yield* projectService.value.get(session.projectId).pipe(Effect.mapError((cause) => new GitError({ message: "Could not read project port configuration", cause }))) : undefined
        const config = approvedWorkflow(project?.workflow)?.ports
        const workspacePorts = yield* Effect.tryPromise({ try: () => allocateWorkspacePorts(current, config), catch: (cause) => new GitError({ message: "Could not allocate workspace ports", cause }) })
        return { ...session, workspacePorts }
      })
      const repositoryLocks = new Map<string, Effect.Semaphore>()
      const repositoryLock = (identity: string): Effect.Semaphore => {
        const existing = repositoryLocks.get(identity)
        if (existing !== undefined) return existing
        const created = Effect.unsafeMakeSemaphore(1)
        repositoryLocks.set(identity, created)
        return created
      }

      const readAll = (): Effect.Effect<ReadonlyArray<Session>, never, PersistEnv> =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
        return yield* readPersistedSessions(fs)
      })

      const writeAll = (
        sessions: ReadonlyArray<Session>
      ): Effect.Effect<void, GitError, PersistEnv> =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const paths = yield* AppPaths
          yield* fs
            .makeDirectory(paths.root, { recursive: true })
            .pipe(Effect.mapError((cause) => new GitError({ message: "Failed to create ~/jingler", cause })))
          const encoded = yield* Schema.encode(SessionArray)(sessions.map(migrateSessionIssue)).pipe(
            Effect.mapError((cause) => new GitError({ message: "Failed to encode sessions", cause }))
          )
          // Write-then-RENAME, never write in place.
          //
          // `sessions.json` is the only record of which worktrees exist, and
          // `readAll` deliberately folds a parse error to `[]` so a corrupt file
          // cannot stop the app booting. Together those turn ANY partial write
          // into total, silent loss of every session — the file survives, reads
          // as empty, and the next write makes it so.
          //
          // `rename` within a directory is atomic, so a reader sees either the
          // whole previous file or the whole new one, never a prefix of either.
          //
          // The temp name must be UNIQUE per write, not a fixed
          // `sessions.json.tmp`. Two writers sharing one temp path both write
          // it, the first rename moves it away, and the second fails ENOENT —
          // which is a corrupted write dressed up as a missing file. The store
          // lock orders writers within a process; this keeps the scheme correct
          // even when it does not (a second Jingler instance, a stray fibre).
          const tempFile = `${paths.sessionsFile}.${process.pid}.${nextOpId()}.tmp`
          yield* fs
            .writeFileString(tempFile, JSON.stringify(encoded, null, 2))
            .pipe(Effect.mapError((cause) => new GitError({ message: "Failed to persist session", cause })))
          yield* fs
            .rename(tempFile, paths.sessionsFile)
            .pipe(
              Effect.mapError((cause) => new GitError({ message: "Failed to persist session", cause })),
              // A failed rename leaves the temp file behind; drop it rather than
              // accumulating one per failure next to the real store.
              Effect.tapError(() => fs.remove(tempFile).pipe(Effect.ignore))
            )
        })

      const outboxFile = (paths: { readonly root: string }): string =>
        `${paths.root}/github-feedback-outbox.json`

      const readFeedbackOutbox = (): Effect.Effect<
        ReadonlyArray<GitHubFeedbackOutboxEntry>,
        never,
        PersistEnv
      > =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const paths = yield* AppPaths
          const file = outboxFile(paths)
          const raw = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""))
          if (raw.trim().length === 0) return []
          return yield* Schema.decodeUnknown(Schema.parseJson(GitHubFeedbackOutbox))(raw).pipe(
            Effect.orElseSucceed(() => [])
          )
        })

      const writeFeedbackOutbox = (
        entries: ReadonlyArray<GitHubFeedbackOutboxEntry>
      ): Effect.Effect<void, GitError, PersistEnv> =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const paths = yield* AppPaths
          const file = outboxFile(paths)
          const temporary = `${file}.${process.pid}.${nextOpId()}.tmp`
          yield* fs.makeDirectory(paths.root, { recursive: true }).pipe(
            Effect.mapError(
              (cause) => new GitError({ message: "Failed to create ~/jingler", cause })
            )
          )
          const encoded = yield* Schema.encode(GitHubFeedbackOutbox)(entries).pipe(
            Effect.mapError(
              (cause) => new GitError({ message: "Failed to encode GitHub feedback outbox", cause })
            )
          )
          yield* fs.writeFileString(temporary, JSON.stringify(encoded, null, 2)).pipe(
            Effect.mapError(
              (cause) => new GitError({ message: "Failed to persist GitHub feedback outbox", cause })
            )
          )
          yield* fs.rename(temporary, file).pipe(
            Effect.mapError(
              (cause) => new GitError({ message: "Failed to persist GitHub feedback outbox", cause })
            ),
            Effect.tapError(() => fs.remove(temporary).pipe(Effect.ignore))
          )
        })

      const list = (): Effect.Effect<ReadonlyArray<Session>, never, PersistEnv> => readAll()

      const get = (id: string): Effect.Effect<Session, SessionNotFoundError, PersistEnv> =>
        Effect.gen(function* () {
          const found = (yield* readAll()).find((s) => s.id === id)
          return found ?? (yield* Effect.fail(new SessionNotFoundError({ sessionId: id })))
        })

      const ensureSessionIdAvailable = (
        sessions: readonly Session[],
        sessionId: string
      ): Effect.Effect<void, GitError> =>
        sessions.some((session) => session.id === sessionId)
          ? Effect.fail(
              new GitError({ message: `A session with id ${sessionId} already exists.` })
            )
          : Effect.void

      const create = (
        input: CreateSessionInput,
        /** Provider defaults (from config) to stamp onto the new session. */
        options: {
          defaultMode?: PermissionMode
          defaultReasoning?: ReasoningSetting
        } = {}
      ): Effect.Effect<
        Session,
        GitError,
      GitService
        | FileSystem.FileSystem
        | Path.Path
        | CommandExecutor.CommandExecutor
        | AppPaths
      > =>
        Effect.gen(function* () {
          const now = yield* Effect.sync(() => new Date().toISOString())
          const stamp = yield* Effect.sync(() => Date.now().toString(36))
          // Title is optional now: blank → the agent auto-names it (provisional
          // "Untitled session"); an explicit title is pinned (autoTitle false).
          const explicit = input.title?.trim() ?? ""
          let title = explicit || UNTITLED_SESSION
          const existing = yield* readAll()
          // A titled session slugs from its title (+ a stamp so identical titles
          // never collide). An UNTITLED session gets a Docker-style friendly name
          // (e.g. "hopeful-einstein") instead of "untitled-session-<stamp>" — read
          // nicer as a branch/worktree, and picked to be unique within this repo.
          let slug: string
          if (explicit.length > 0) {
            slug = `${taskSlug(explicit)}-${stamp}`
          } else {
            const usedSlugs = new Set(
              existing
                .filter((s) => s.repo === input.repoName && s.worktreePath)
                // `basename`, not `split("/")`. Worktree paths are built with
                // `path.join`, so on Windows they are backslash-separated and a
                // "/" split returns the WHOLE path — the used-slug set then
                // never matches a candidate, `freeCreativeName` always believes
                // its first pick is free, and every untitled session in a repo
                // collides on one name.
                .map((s) => basename(s.worktreePath!))
            )
            // `Date.now()` ALONE is not a distinct seed. Two untitled sessions
            // created in the same millisecond get the same clock reading and the
            // same (still empty) used-set, so `freeCreativeName` hands both the
            // same name — and the second create's reclaim step would then
            // `rm -rf` the first's worktree. Mixing in a per-process counter
            // makes the seed differ even when the clock does not.
            const seed = yield* Effect.sync(() => Date.now() + nextOpId() * 7919)
            const stampedFallback = `${taskSlug(title)}-${stamp}`
            slug = freeCreativeName(usedSlugs, seed, stampedFallback)
            // The provisional sidebar name IS the creative slug ("hopeful-einstein"
            // → "Hopeful Einstein") — never a literal "Untitled session" while the
            // task-understanding pass is still naming the work. `autoTitle` stays
            // true, so the first retitle replaces it like any provisional title.
            if (slug !== stampedFallback) title = displayNameFromCreativeSlug(slug)
          }
          const id = input.requestedSessionId ?? `s_${slug}`
          yield* ensureSessionIdAvailable(existing, id)
          const selection = runtimeSelection(input)
          const chat = initialChat(id, now, { mode: options.defaultMode }, {
            ...selection,
            ...propertiesWhen(options.defaultReasoning !== undefined, { reasoning: options.defaultReasoning })
          })
          const makeSession = (
            workspace: { path: string; branch: string; repoPath: string },
            workspaceMode: WorkspaceMode
          ): Session => ({
            id,
            checkpointExecutionHistory: "clean",
            ...propertiesWhen(input.projectId !== undefined, { projectId: input.projectId }),
            ...propertiesWhen(input.environmentId !== undefined, { environmentId: input.environmentId }),
            repo: input.repoName,
            ...propertiesWhen(input.githubSlug !== undefined, { githubSlug: input.githubSlug }),
            branch: workspace.branch,
            ...propertiesWhen(workspaceMode === "worktree" && input.continueBranch !== true, { semanticBranchPending: true }),
            title,
            ...propertiesWhen(Boolean(input.initialPrompt?.trim()), {
              initialPrompt: input.initialPrompt?.trim()
            }),
            autoTitle: explicit.length === 0,
            status: "idle",
            ...selection,
            diff: { added: 0, removed: 0 },
            prNumber: null,
            costUsd: 0,
            tokens: 0,
            updatedAt: now,
            chats: [chat],
            activeChatId: chat.id,
            worktreePath: workspace.path,
            workspaceMode,
            repoPath: workspace.repoPath,
            baseBranch: input.baseBranch,
            ...propertiesWhen(
              workspaceMode === "worktree" && input.projectId !== undefined && input.environmentId === undefined,
              { workspaceLifecycle: { status: "setup-running" as const, updatedAt: now } }
            )
          })

          if (input.useWorktree === false) {
            const identity = yield* GitService.repositoryIdentity(input.repoPath)
            const reservation = makeSession(
              {
                path: identity.repoPath,
                branch: input.baseBranch,
                repoPath: identity.repoPath
              },
              "direct"
            )
            // Serialize only creations that target this physical repository.
            // The process-wide sessions.json lock remains limited to its actual
            // read-modify-write; checkout hooks can take seconds and must not
            // stall unrelated session usage/status/chat persistence.
            return yield* repositoryLock(identity.commonDir).withPermits(1)(
              Effect.gen(function* () {
                const current = yield* readAll()
                const directIdentities = yield* Effect.forEach(
                  current.filter(
                    (session) =>
                      workspaceModeOf(session) === "direct" &&
                      session.repoPath !== undefined
                  ),
                  (session) =>
                    GitService.repositoryIdentity(session.repoPath!).pipe(
                      Effect.map((candidate) => candidate.commonDir),
                      // A missing legacy checkout cannot race this live one.
                      Effect.orElseSucceed(() => session.repoPath!)
                    )
                )
                if (directIdentities.includes(identity.commonDir)) {
                  return yield* Effect.fail(
                    new GitError({
                      message:
                        "A direct session already uses this repository. Delete it or create this session with an isolated worktree."
                    })
                  )
                }
                // Persist the recoverable reservation BEFORE changing the
                // developer's checkout. A failed write leaves Git untouched; a
                // process crash after the switch still leaves a visible session
                // record whose branch guard explains how to recover.
                yield* atomically(
                  Effect.gen(function* () {
                    const latest = yield* readAll()
                    yield* ensureSessionIdAvailable(latest, reservation.id)
                    yield* writeAll([reservation, ...latest])
                  })
                )
                const branch = yield* GitService.switchBranch(
                  identity.repoPath,
                  input.baseBranch
                ).pipe(
                  Effect.tapError(() =>
                    atomically(
                      Effect.gen(function* () {
                        const latest = yield* readAll()
                        yield* writeAll(
                          latest.filter((session) => session.id !== reservation.id)
                        )
                      })
                    ).pipe(Effect.ignore)
                  )
                )
                return branch === reservation.branch
                  ? reservation
                  : { ...reservation, branch }
              })
            )
          }

        // Refuse if a live session already owns this path — the same guard
        // `createFromPr` and `createFromIssue` carry, and for the same reason:
        // `createDetachedWorktree` reclaims whatever is at the target path with an
        // `rm -rf`, so without this a slug collision DELETES a working
        // session's worktree and everything uncommitted in it.
        //
        // The stamp makes a collision unlikely, not impossible:
        // `freeCreativeName` falls back to an unstamped name after enough
        // collisions, and two creates in the same millisecond share a stamp.
        // Unlikely is the wrong bar for an unrecoverable outcome.
        return yield* createIsolatedSession(
          input,
            slug,
          existing,
          makeSession,
          atomically,
          readAll,
          ensureSessionIdAvailable,
          writeAll,
          assignPorts
        )
            })

    /**
     * Create a session from an *existing* PR. Lands a detached worktree on the
     * PR's base, resolves the immutable head repository/ref through GitHub,
     * then fetches and checks it out with ordinary git. The worktree tracks the
     * PR's fork/branch and agent commits update that PR directly. `prNumber` is
     * linked up front, so the sidebar badge + PR/Code-Review tabs light up.
     */
    const createFromPr = (
        input: CreateSessionFromPrInput,
        opts: {
          allowSharedCheckout?: boolean
          defaultMode?: PermissionMode
          defaultReasoning?: ReasoningSetting
        } = {}
      ): Effect.Effect<
        Session,
        GitError | GitHubApiError,
        | GitService
        | GitHubApi
        | FileSystem.FileSystem
        | Path.Path
        | CommandExecutor.CommandExecutor
        | AppPaths
      > =>
        Effect.gen(function* () {
          // Key the slug on the PR number (unique per repo), not the title alone —
          // otherwise two different PRs that happen to share a title would resolve
          // to the same worktree path and the second would be refused. Including
          // the number keeps the slug stable per PR (so re-opening the same PR is
          // idempotent — see the guard below) while staying unique across PRs.
          const slug = `${taskSlug(input.pr.title)}-${input.pr.number}`
          // Refuse if a live session already owns this worktree path — otherwise
          // the reclaim step below would delete its worktree. (A leftover dir
          // from a failed attempt is NOT a live session, so retries still work.)
          const worktreePath = yield* GitService.worktreePathFor(input.repoName, slug)
          const priorSessions = yield* readAll()
          const now = yield* Effect.sync(() => new Date().toISOString())
          const stamp = yield* Effect.sync(() => Date.now().toString(36))
          const id = input.requestedSessionId ?? `s_${slug}_${stamp}`
          yield* ensureSessionIdAvailable(priorSessions, id)
          if (priorSessions.some((s) => s.worktreePath === worktreePath)) {
            return yield* Effect.fail(
              new GitError({ message: "A session already exists for this pull request." })
            )
          }
          const worktree = yield* GitService.createDetachedWorktree({
            repoPath: input.repoPath,
            repoName: input.repoName,
            slug,
            baseBranch: input.pr.baseRefName
          })
          const repository = yield* GitHubApi.repository(input.repoPath)
          const head = yield* GitHubApi.prCheckout(input.repoPath, input.pr.number)
          yield* GitService.checkoutPullRequestHead(
            worktree.path,
            head,
            opts.allowSharedCheckout ?? false
          )
          // The live branch after checkout is the PR head; fall back to the
          // reported head ref if `rev-parse` can't resolve it.
          const branch = (yield* GitService.branchAt(worktree.path)) ?? input.pr.headRefName
          const selection = runtimeSelection(input)
          const chat = initialChat(id, now, { mode: opts.defaultMode }, {
            ...selection,
            ...propertiesWhen(opts.defaultReasoning !== undefined, { reasoning: opts.defaultReasoning })
          })
          let session: Session = {
            id,
            checkpointExecutionHistory: "clean",
            ...propertiesWhen(input.projectId !== undefined, { projectId: input.projectId }),
            ...propertiesWhen(input.environmentId !== undefined, { environmentId: input.environmentId }),
            repo: input.repoName,
            githubSlug: input.githubSlug ?? repository.fullName,
            branch,
            title: input.pr.title,
            ...propertiesWhen(Boolean(input.initialPrompt?.trim()), {
              initialPrompt: input.initialPrompt?.trim()
            }),
            status: "idle",
            ...selection,
            diff: { added: 0, removed: 0 },
            prNumber: input.pr.number,
            ...propertiesWhen(repository.installationId !== undefined, {
              githubInstallationId: repository.installationId
            }),
            githubRepositoryId: repository.id,
            costUsd: 0,
            tokens: 0,
            updatedAt: now,
            chats: [chat],
            activeChatId: chat.id,
            worktreePath: worktree.path,
            workspaceMode: "worktree",
            repoPath: worktree.repoPath,
            baseBranch: input.pr.baseRefName,
            ...propertiesWhen(
              input.projectId !== undefined && input.environmentId === undefined,
              { workspaceLifecycle: { status: "setup-running" as const, updatedAt: now } }
            )
          }
          // Re-read INSIDE the lock rather than reusing the list read before
          // the worktree fork: that read is now seconds stale, and appending to
          // it would drop any session created — or any deps status written — in
          // the meantime.
          yield* atomically(
            Effect.gen(function* () {
              const current = yield* readAll()
              yield* ensureSessionIdAvailable(current, session.id)
              session = yield* assignPorts(session, current)
              yield* writeAll([session, ...current])
            })
          )
          return session
        })

    /**
     * Create a session from a normalized issue. Like `create` it starts DETACHED
     * from a fresh `baseBranch` (the provider identifier keys the worktree path),
     * retains GitHub automations when supplied, and seeds `initialPrompt` from the issue
     * title + body (the composer pre-fills it once; HITL — the user sends it).
     */
    const createFromIssue = (
        input: CreateSessionFromIssueInput,
        options: {
          defaultMode?: PermissionMode
          defaultReasoning?: ReasoningSetting
        } = {}
      ): Effect.Effect<
        Session,
        GitError,
      GitService
        | FileSystem.FileSystem
        | Path.Path
        | CommandExecutor.CommandExecutor
        | AppPaths
      > =>
        Effect.gen(function* () {
          const now = yield* Effect.sync(() => new Date().toISOString())
          const stamp = yield* Effect.sync(() => Date.now().toString(36))
          const baseSlug = taskSlug(
            `${input.issue.providerId}-${input.issue.identifier}-${input.issue.title}`
          )
          const prior = yield* readAll()
          const requestedId = input.requestedSessionId
          if (requestedId !== undefined) {
            yield* ensureSessionIdAvailable(prior, requestedId)
          }
          const repository = { path: input.repoPath, name: input.repoName }
          if (
            prior.some((session) =>
              sessionLinksIssue(session, repository, input.issue)
            )
          ) {
            return yield* Effect.fail(
              new GitError({ message: "A session already exists for this issue." })
            )
          }
          const baseWorktreePath = yield* GitService.worktreePathFor(
            input.repoName,
            baseSlug
          )
          const slug = prior.some(
            (session) =>
              sessionBelongsToRepository(session, repository) &&
              session.worktreePath === baseWorktreePath
          )
            ? disambiguateIssueSlug(baseSlug, input.issue)
            : baseSlug
          const id = requestedId ?? `s_${slug}_${stamp}`
          const worktree = yield* GitService.createDetachedWorktree({
            repoPath: input.repoPath,
            repoName: input.repoName,
            slug,
            baseBranch: input.baseBranch
          })
          // Prefer the edited task from the dialog; fall back to title + body.
          const task =
            input.task.trim() ||
            [input.issue.title, input.issue.body]
              .map((s) => s.trim())
              .filter((s) => s.length > 0)
              .join("\n\n")
          const selection = runtimeSelection(input)
          const chat = initialChat(id, now, { mode: options.defaultMode }, {
            ...selection,
            ...propertiesWhen(options.defaultReasoning !== undefined, { reasoning: options.defaultReasoning })
          })
          let session: Session = {
            // Stamp the id (like `createFromPr`) so a delete-then-recreate of the
            // same issue can't collide with the old session's persisted data; the
            // worktree slug stays deterministic for the one-session-per-issue guard.
            id,
            checkpointExecutionHistory: "clean",
            ...propertiesWhen(input.projectId !== undefined, { projectId: input.projectId }),
            ...propertiesWhen(input.environmentId !== undefined, { environmentId: input.environmentId }),
            repo: input.repoName,
            ...propertiesWhen(input.githubSlug !== undefined, { githubSlug: input.githubSlug }),
            branch: worktree.branch,
            semanticBranchPending: true,
            checkpointExecutionHistory: "clean",
            // Seed (and pin) the title from the issue.
            title: input.issue.title,
            autoTitle: false,
            status: "idle",
            ...selection,
            diff: { added: 0, removed: 0 },
            prNumber: null,
            linkedIssues: [{
              providerId: input.issue.providerId,
              id: input.issue.id,
              ...propertiesWhen(input.issue.providerAccountId !== undefined, { providerAccountId: input.issue.providerAccountId }),
              identifier: input.issue.identifier,
              url: input.issue.url,
              title: input.issue.title,
              labels: input.issue.labels
            }],
            selectedIssue: {
              providerId: input.issue.providerId,
              id: input.issue.id
            },
            ...propertiesWhen(input.issue.providerId === "github" && Boolean(input.automations), { automations: input.automations }),
            ...propertiesWhen(task.length > 0, { initialPrompt: task }),
            costUsd: 0,
            tokens: 0,
            updatedAt: now,
            chats: [chat],
            activeChatId: chat.id,
            worktreePath: worktree.path,
            workspaceMode: "worktree",
            repoPath: worktree.repoPath,
            baseBranch: input.baseBranch,
            ...propertiesWhen(
              input.projectId !== undefined && input.environmentId === undefined,
              { workspaceLifecycle: { status: "setup-running" as const, updatedAt: now } }
            )
          }
          // Re-read INSIDE the lock rather than reusing the list read before
          // the worktree fork: that read is now seconds stale, and appending to
          // it would drop any session created — or any deps status written — in
          // the meantime.
          yield* atomically(
            Effect.gen(function* () {
              const current = yield* readAll()
              yield* ensureSessionIdAvailable(current, session.id)
              session = yield* assignPorts(session, current)
              yield* writeAll([session, ...current])
            })
          )
          return session
        })

      /** Apply `patch` to the matching session and persist; no-op if absent. */
      const update = (
        id: string,
        patch: (session: Session) => Session
      ): Effect.Effect<void, GitError, PersistEnv> =>
        atomically(
          Effect.gen(function* () {
            const all = yield* readAll()
            if (!all.some((s) => s.id === id)) return
            yield* writeAll(all.map((s) => (s.id === id ? patch(s) : s)))
          })
        )

      const reassignWorkspacePorts = (id: string) => Effect.acquireUseRelease(
        Effect.try({ try: () => {
          const token = closeWorkspaceAdmission(id, "reassigning workspace ports")
          if (workspaceActivityCount(id) !== 0) { reopenWorkspaceAdmission(id, token); throw new Error("Stop all agents, commands and terminals before reassigning ports.") }
          return token
        }, catch: (cause) => new GitError({ message: cause instanceof Error ? cause.message : "Workspace is busy", cause }) }),
        () => atomically(Effect.gen(function* () {
          const current = yield* readAll()
          const session = current.find((item) => item.id === id)
          if (!session || session.environmentId || session.workspaceMode === "direct" || !session.worktreePath) return yield* Effect.fail(new GitError({ message: "Ports require an isolated local workspace." }))
          const unassigned = { ...session, workspacePorts: undefined }
          const next = yield* assignPorts(unassigned, current.filter((item) => item.id !== id))
          yield* writeAll(current.map((item) => item.id === id ? next : item))
          return next
        })),
        (token) => Effect.sync(() => { reopenWorkspaceAdmission(id, token) })
      )

      const updateChat = (
        sessionId: string,
        chatId: string,
        patch: (chat: Chat) => Chat
      ) =>
        update(sessionId, (session) => ({
          ...session,
          chats: session.chats.map((chat) => (chat.id === chatId ? patch(chat) : chat))
        }))

      const createChat = (sessionId: string) =>
        Effect.gen(function* () {
          const now = new Date().toISOString()
          yield* update(sessionId, (session) => {
            const source =
              session.chats.find((chat) => chat.id === session.activeChatId) ??
              session.chats[0]
            const chat: Chat = {
              id: chatIdFor(sessionId, `${Date.now().toString(36)}_${nextOpId()}`),
              title: null,
              createdAt: now,
              updatedAt: now,
              ...propertiesWhen(source?.mode !== undefined, { mode: source?.mode }),
              ...propertiesWhen(source?.reasoning !== undefined, { reasoning: source?.reasoning }),
              ...propertiesWhen(source?.connectionId !== undefined, { connectionId: source?.connectionId }),
              ...propertiesWhen(source?.providerId !== undefined, { providerId: source?.providerId }),
              ...propertiesWhen(source?.modelId !== undefined, { modelId: source?.modelId }),
              ...propertiesWhen(source?.allowlist !== undefined, { allowlist: source?.allowlist })
            }
            return {
              ...session,
              chats: [...session.chats, chat],
              activeChatId: chat.id,
              updatedAt: now
            }
          })
          return yield* get(sessionId)
        })

      const selectChat = (sessionId: string, chatId: string) =>
        Effect.gen(function* () {
          yield* update(sessionId, (session) =>
            session.chats.some((chat) => chat.id === chatId)
              ? { ...session, activeChatId: chatId }
              : session
          )
          return yield* get(sessionId)
        })

      const renameChat = (sessionId: string, chatId: string, title: string) =>
        Effect.gen(function* () {
          const trimmed = title.trim()
          if (trimmed.length > 0) {
            const now = new Date().toISOString()
            yield* updateChat(sessionId, chatId, (chat) => ({
              ...chat,
              title: trimmed,
              updatedAt: now
            }))
          }
          return yield* get(sessionId)
        })

      const closeChat = (sessionId: string, chatId: string, discard = false) =>
        Effect.gen(function* () {
          const now = new Date().toISOString()
          yield* update(sessionId, (session) => {
            const index = session.chats.findIndex((chat) => chat.id === chatId)
            if (index < 0) return session
            const remaining = session.chats.filter((chat) => chat.id !== chatId)
            const closed = session.chats[index]
            const replacement: Chat = {
              id: chatIdFor(session.id, `${Date.now().toString(36)}_${nextOpId()}`),
              title: null,
              createdAt: now,
              updatedAt: now,
              ...propertiesWhen(closed?.mode !== undefined, { mode: closed?.mode }),
              ...propertiesWhen(closed?.reasoning !== undefined, { reasoning: closed?.reasoning }),
              ...propertiesWhen(closed?.connectionId !== undefined, { connectionId: closed?.connectionId }),
              ...propertiesWhen(closed?.providerId !== undefined, { providerId: closed?.providerId }),
              ...propertiesWhen(closed?.modelId !== undefined, { modelId: closed?.modelId }),
              ...propertiesWhen(closed?.allowlist !== undefined, { allowlist: closed?.allowlist })
            }
            const chats = remaining.length > 0 ? remaining : [replacement]
            const activeChatId =
              session.activeChatId === chatId
                ? chats[Math.min(index, chats.length - 1)]!.id
                : session.activeChatId
            return {
              ...session,
              chats,
              closedChats: closedChatsAfter(closed!, session.closedChats ?? [], discard),
              activeChatId,
              updatedAt: now
            }
          })
          return yield* get(sessionId)
        })

      const discardClosedChat = (sessionId: string, chatId: string) =>
        Effect.gen(function* () {
          yield* update(sessionId, (session) => ({
            ...session,
            closedChats: (session.closedChats ?? []).filter((chat) => chat.id !== chatId)
          }))
          return yield* get(sessionId)
        })

      const reopenChat = (sessionId: string, chatId: string) =>
        Effect.gen(function* () {
          const now = new Date().toISOString()
          yield* update(sessionId, (session) => {
            const reopened = (session.closedChats ?? []).find((chat) => chat.id === chatId)
            if (reopened === undefined) return session
            return {
              ...session,
              chats: [...session.chats, reopened],
              closedChats: (session.closedChats ?? []).filter((chat) => chat.id !== chatId),
              activeChatId: reopened.id,
              updatedAt: now
            }
          })
          return yield* get(sessionId)
        })

      /** Persist one chat's HITL permission mode. */
      const setMode = (
        id: string,
        chatIdOrMode: string,
        maybeMode?: PermissionMode
      ) =>
        update(id, (session) => {
          const chatId = maybeMode === undefined ? session.activeChatId : chatIdOrMode
          const mode = maybeMode ?? runtimeMode(chatIdOrMode)
          if (mode === undefined) return session
          return {
            ...session,
            mode,
            chats: session.chats.map((chat) =>
              chat.id === chatId ? { ...chat, mode } : chat
            )
          }
        })

      const setAgentModel = (
        id: string,
        chatId: string,
        runtimeId: AgentRuntimeId,
        endpointId: AgentEndpointId,
        providerId: ProviderId,
        modelId: ProviderModelId
      ) =>
        update(id, (session) => {
          const target = session.chats.find((chat) => chat.id === chatId)
          if (target === undefined) return session
          const endpointChanged =
            target.runtimeId !== runtimeId || target.endpointId !== endpointId
          const changed =
            endpointChanged ||
            target.providerId !== providerId ||
            target.modelId !== modelId
          if (endpointChanged && !pendingAgentModels.has(pendingAgentModelKey(id, chatId))) {
            pendingAgentModels.set(pendingAgentModelKey(id, chatId), {
              session: {
                runtimeId: session.runtimeId,
                endpointId: session.endpointId,
                connectionId: session.connectionId,
                providerId: session.providerId,
                modelId: session.modelId,
                continuation: session.continuation
              },
              chat: target
            })
          }
          return {
            ...session,
            runtimeId,
            endpointId,
            connectionId: runtimeId === "pi" ? session.connectionId : undefined,
            providerId,
            modelId,
            ...propertiesWhen(endpointChanged, { continuation: undefined }),
            connectionSelectionRequired: false,
            modelSelectionRequired: false,
            chats: session.chats.map((chat) =>
              chat.id !== chatId
                ? chat
                : {
                    ...chat,
                    runtimeId,
                    endpointId,
                    connectionId: runtimeId === "pi" ? chat.connectionId : undefined,
                    providerId,
                    modelId,
                    connectionSelectionRequired: false,
                    modelSelectionRequired: false,
                    ...propertiesWhen(endpointChanged, { continuation: undefined }),
                    ...propertiesWhen(changed, { reasoning: undefined })
                  }
            )
          }
        })

      const agentModelMatches = (session: Session, chatId: string, expected: { runtimeId: AgentRuntimeId; endpointId: AgentEndpointId; providerId: ProviderId | undefined; modelId: ProviderModelId }) => {
        const chat = session.chats.find((candidate) => candidate.id === chatId)
        return (chat?.runtimeId ?? session.runtimeId) === expected.runtimeId &&
          (chat?.endpointId ?? session.endpointId) === expected.endpointId &&
          (chat?.providerId ?? session.providerId) === expected.providerId &&
          (chat?.modelId ?? session.modelId) === expected.modelId
      }

      const confirmAgentStart = (
        id: string,
        chatId: string,
        expected: { runtimeId: AgentRuntimeId; endpointId: AgentEndpointId; providerId: ProviderId | undefined; modelId: ProviderModelId },
        continuation?: RuntimeContinuation
      ) => update(id, (session) => {
        if (!agentModelMatches(session, chatId, expected)) return session
        pendingAgentModels.delete(pendingAgentModelKey(id, chatId))
        if (continuation === undefined) return session
        return {
          ...session,
          continuation,
          chats: session.chats.map((candidate) => candidate.id === chatId ? { ...candidate, continuation } : candidate)
        }
      })

      const confirmAgentModel = (id: string, chatId: string) =>
        Effect.sync(() => pendingAgentModels.delete(pendingAgentModelKey(id, chatId))).pipe(
          Effect.asVoid
        )

      const rollbackAgentModel = (
        id: string,
        chatId: string,
        expected?: { runtimeId: AgentRuntimeId; endpointId: AgentEndpointId; providerId: ProviderId | undefined; modelId: ProviderModelId }
      ) => update(id, (session) => {
        if (expected !== undefined && !agentModelMatches(session, chatId, expected)) return session
        const key = pendingAgentModelKey(id, chatId)
        const pending = pendingAgentModels.get(key)
        if (pending === undefined) return session
        pendingAgentModels.delete(key)
        return {
          ...session,
          ...pending.session,
          chats: session.chats.map((chat) => chat.id === chatId ? pending.chat : chat)
        }
      }).pipe(Effect.asVoid)

      /** Persist one exact PI endpoint/model and clear foreign continuation ownership. */
      const setProviderModel = (
        id: string,
        chatId: string,
        connectionId: ProviderConnectionId,
        providerId: ProviderId,
        modelId: ProviderModelId
      ) =>
        update(id, (session) => {
          const target = session.chats.find((chat) => chat.id === chatId)
          if (target === undefined) return session
          const endpointId = piEndpointId(session.environmentId ?? "desktop", connectionId)
          const endpointChanged = target.runtimeId !== "pi" || target.endpointId !== endpointId
          const changed =
            endpointChanged ||
            target.providerId !== providerId ||
            target.modelId !== modelId
          if (endpointChanged && !pendingAgentModels.has(pendingAgentModelKey(id, chatId))) {
            pendingAgentModels.set(pendingAgentModelKey(id, chatId), {
              session: {
                runtimeId: session.runtimeId,
                endpointId: session.endpointId,
                connectionId: session.connectionId,
                providerId: session.providerId,
                modelId: session.modelId,
                continuation: session.continuation
              },
              chat: target
            })
          }
          return {
            ...session,
            runtimeId: "pi",
            endpointId,
            connectionId,
            providerId,
            modelId,
            ...propertiesWhen(endpointChanged, { continuation: undefined }),
            connectionSelectionRequired: false,
            modelSelectionRequired: false,
            // A model change inside one endpoint keeps its continuation. An
            // endpoint change cannot: continuation ownership is endpoint-bound.
            chats: session.chats.map((chat) =>
              chat.id !== chatId
                ? chat
                : {
                    ...chat,
                    runtimeId: "pi",
                    endpointId,
                    connectionId,
                    providerId,
                    modelId,
                    connectionSelectionRequired: false,
                    modelSelectionRequired: false,
                    ...propertiesWhen(endpointChanged, { continuation: undefined }),
                    ...propertiesWhen(changed, { reasoning: undefined })
                  }
            )
          }
        })

      /** Persist restart recovery evidence without replaying the uncertain call. */
      const setRuntimeRecovery = (
        id: string,
        runtimeRecovery: Session["runtimeRecovery"]
      ) =>
        update(id, (session) => ({ ...session, runtimeRecovery }))

      const resolveRuntimeRecovery = (id: string, callId: string) =>
        update(id, (session) => {
          const remaining = session.runtimeRecovery?.uncertainMutations.filter(
            (mutation) => mutation.callId !== callId
          ) ?? []
          return {
            ...session,
            runtimeRecovery:
              remaining.length === 0
                ? undefined
                : { uncertainMutations: remaining }
          }
        })

      /** Persist one chat's provider-neutral reasoning choice. */
      const setReasoning = (
        id: string,
        chatId: string,
        reasoning: ReasoningSetting | undefined
      ) =>
        updateChat(id, chatId, (chat) => ({ ...chat, reasoning }))

    /**
     * Accrue what a finished turn reported, ADDING to the session's running
     * total rather than replacing it — a session is many turns, and the last
     * one's usage is not the session's usage.
     *
     * `costUsd` is the harness's own figure. On subscription auth it is a
     * NOTIONAL api-equivalent price rather than money billed, which is worth
     * knowing before treating it as spend: the billing pane is what says which
     * of the two an operator is actually on. Recorded regardless, because "how
     * expensive was this work" is a useful question either way; it is the
     * interpretation that differs, not the number.
     */
    const addUsage = (id: string, usage: { costUsd: number; tokens: number }) =>
        update(id, (s) => ({
          ...s,
          costUsd: s.costUsd + (Number.isFinite(usage.costUsd) ? usage.costUsd : 0),
          tokens: s.tokens + (Number.isFinite(usage.tokens) ? usage.tokens : 0)
        }))

      /** Persist one chat's runtime-owned continuation identity. */
      const setContinuation = (
        id: string,
        chatId: string,
        continuation: RuntimeContinuation
      ) =>
        update(id, (session) => ({
          ...session,
          continuation,
          chats: session.chats.map((chat) =>
            chat.id === chatId ? { ...chat, continuation } : chat
          )
        }))

      /** Clear one chat's pi continuation before a deliberate context reseed. */
      const clearContinuation = (id: string, chatId?: string) =>
        update(id, (session) => {
          const target = chatId ?? session.activeChatId
          return {
            ...session,
            continuation: undefined,
            chats: session.chats.map((chat) =>
              chat.id === target ? { ...chat, continuation: undefined } : chat
            )
          }
        })

    /**
     * Persist the session's latest context-window OCCUPANCY.
     *
     * Distinct from `addUsage`, which accrues the session's lifetime totals.
     * That number only grows; this one must be able to fall, because a
     * compaction shrinking it is exactly the outcome being recorded. Writing
     * both to `tokens` would make a compaction read as negative usage on the
     * sidebar and make the meter measure a lifetime sum as a working set.
     *
     * It has to be persisted at all because the reading otherwise lived only
     * in renderer state and died on reload — a session reopened at 290k would
     * read as 0 and run to the hard ceiling before anything noticed.
     */
    const setContextTokens = (id: string, contextTokens: number) =>
        update(id, (s) =>
          Number.isFinite(contextTokens) && contextTokens >= 0 ? { ...s, contextTokens } : s
        )

      const setChatContextTokens = (
        id: string,
        chatId: string,
        contextTokens: number
      ) =>
        update(id, (session) =>
          Number.isFinite(contextTokens) && contextTokens >= 0
            ? {
                ...session,
                contextTokens,
                chats: session.chats.map((chat) =>
                  chat.id === chatId ? { ...chat, contextTokens } : chat
                )
              }
            : session
        )

    /**
     * Pin auto-compaction on or off for this session; `null` clears the
     * override so it follows the global setting again.
     *
     * `undefined` on clear, not null — `autoCompact` is `optional`, so writing
     * null would persist a key the schema rejects on the next read, and
     * `TranscriptStore`-style best-effort decoding would then drop the whole
     * session record.
     */
    const setAutoCompact = (id: string, autoCompact: boolean | null) =>
        update(id, (s) => ({ ...s, autoCompact: autoCompact ?? undefined }))

      /** Persist and return a session's lifecycle-retention choice atomically. */
      const setPersistent = (
        id: string,
        persistent: boolean
      ): Effect.Effect<
        Session,
        GitError | SessionNotFoundError,
        PersistEnv
      > =>
        atomically(
          Effect.gen(function* () {
            const all = yield* readAll()
            const current = all.find((session) => session.id === id)
            if (current === undefined) {
              return yield* Effect.fail(
                new SessionNotFoundError({ sessionId: id })
              )
            }
            const updated: Session = { ...current, persistent }
            yield* writeAll(
              all.map((session) => (session.id === id ? updated : session))
            )
            return updated
          })
        )

      /** Persist the execution target for a session that the caller has proved pristine. */
      const setEnvironment = (
        id: string,
        environmentId: string | undefined
      ): Effect.Effect<Session, GitError | SessionNotFoundError, PersistEnv> =>
        atomically(
          Effect.gen(function* () {
            const all = yield* readAll()
            const current = all.find((session) => session.id === id)
            if (current === undefined) {
              return yield* Effect.fail(new SessionNotFoundError({ sessionId: id }))
            }
            const updated: Session = {
              ...current,
              environmentId,
              executionLocation: environmentId === undefined ? "local" : "cloud",
              updatedAt: new Date().toISOString()
            }
            yield* writeAll(all.map((session) => (session.id === id ? updated : session)))
            return updated
          })
        )

      /** Persist an auto-generated title (leaves `autoTitle` untouched). */
      const setTitle = (id: string, title: string) => update(id, (s) => ({ ...s, title }))

      /** Persist validated metadata before the git mutation so a retry reuses it. */
      const setSemanticBranchProposal = (
        id: string,
        proposal: NonNullable<Session["semanticBranchProposal"]>
      ) => update(id, (session) => ({
        ...session,
        semanticBranchProposal: proposal,
        semanticBranchPending: true
      }))

      /** Persist the validated proposal and live branch after a successful switch. */
      const setTitleAndBranch = (
        id: string,
        title: string,
        branch: string,
        semanticBranchProposal?: Session["semanticBranchProposal"]
      ) =>
        update(id, (s) => ({
          ...s,
          title,
          branch,
          ...propertiesWhen(semanticBranchProposal !== undefined, { semanticBranchProposal }),
          semanticBranchPending: false
        }))

    /**
     * Re-point a direct session at the branch its shared checkout has drifted
     * onto — the deliberate operator recovery for a `BranchDrift`. Touches only
     * `branch`; an established branch is live state, so every other section
     * (plans, PR link, GitHub routing) is preserved by `update`'s read-modify-write.
     */
    const setBranch = (id: string, branch: string) =>
        update(id, (s) => ({ ...s, branch }))

      /** Manual rename — pins the title so the agent stops auto-retitling it. */
      const renameTitle = (id: string, title: string) =>
        update(id, (s) => ({ ...s, title, autoTitle: false }))

    /**
     * Record the session's lifecycle status as a turn settles. An archived
     * session is terminal — never drag it back to idle/needs-input, or the
     * sidebar would show a merged session as if it still wanted attention.
     */
    const setStatus = (id: string, status: SettledSessionStatus) =>
        update(id, (s) => (s.archived ? s : { ...s, status }))

      /** Add a command to the session's "always allow" list (deduped). */
      const addAllowlist = (id: string, chatIdOrLabel: string, maybeLabel?: string) =>
        update(id, (session) => {
          const chatId = maybeLabel === undefined ? session.activeChatId : chatIdOrLabel
          const label = maybeLabel ?? chatIdOrLabel
          const allowlist = [...new Set([...(session.allowlist ?? []), label])]
          return {
            ...session,
            allowlist,
            chats: session.chats.map((chat) =>
              chat.id === chatId
                ? {
                    ...chat,
                    allowlist: [...new Set([...(chat.allowlist ?? []), label])]
                  }
                : chat
            )
          }
        })

      /** Link a PR number without App routing; changing PRs clears stale realtime identity. */
      const setPrNumber = (id: string, prNumber: number | null) =>
        update(id, (session) => {
          if (session.prNumber === prNumber) return session
          const {
            githubInstallationId: _installationId,
            githubRepositoryId: _repositoryId,
            githubFeedbackDeliveryIds: _deliveryIds,
            githubFeedbackSemanticKeys: _semanticKeys,
            ...unlinked
          } = session
          return { ...unlinked, prNumber }
        })

      /** Persist the live worktree/PR identity as one routing transition. */
      const setGitHubLink = (
        id: string,
        link: {
          readonly installationId: string
          readonly repositoryId: string
          readonly prNumber: number
          readonly branch?: string
        }
      ) =>
        update(id, (session) => ({
          ...session,
          ...propertiesWhen(link.branch !== undefined, { branch: link.branch }),
          prNumber: link.prNumber,
          githubInstallationId: link.installationId,
          githubRepositoryId: link.repositoryId
        }))

    /**
     * Exactly-once claim, validated and persisted atomically before the
     * renderer dispatches feedback into the conversation actor.
     */
    const claimGitHubFeedback = (
        id: string,
        input: {
          readonly installationId: string
          readonly repositoryId: string
          readonly prNumber: number
          readonly deliveryId: string
          readonly semanticKey: string
          readonly event: GitHubRelayEvent
        }
      ): Effect.Effect<GitHubFeedbackClaimStatus, GitError, PersistEnv> =>
        atomically(
          Effect.gen(function* () {
            const sessions = yield* readAll()
          return yield* claimSessionFeedback(
            sessions,
            id,
            input,
            readFeedbackOutbox,
            writeFeedbackOutbox
          )
        })
        )

    /**
     * Reconcile the durable feedback outbox after a restart, and return the
     * pending entries that still deserve a delivery attempt.
     *
     * A `pending` entry means the delivery was claimed but the renderer never
     * finished routing it — the app quit, the conversation actor discarded the
     * dispatch, or the relay acknowledged the frame down an "ignored" branch
     * that never marks dispatch. Nothing else ever re-reads these entries, so
     * without this pass they are stranded forever: the relay's cursor may
     * already be past the frame, meaning no replay will ever redeliver it.
     *
     * Three cases, decided against the CURRENT session state:
     * - the session ledger already has the delivery → flip to `dispatched`
     *   (the instruction reached the transcript; only the outbox missed it);
     * - the session is gone, archived, or relinked → drop the entry (a fresh
     *   claim would reject it, and keeping it blocks other sessions' claims);
     * - still validly linked → keep it and hand it back for a replay attempt,
     *   retargeted at the session's ACTIVE chat (the recorded chat may have
     *   been closed since the claim).
     */
    const recoverGitHubFeedbackOutbox = (): Effect.Effect<
        ReadonlyArray<GitHubFeedbackOutboxEntry>,
        GitError,
        PersistEnv
      > =>
        atomically(
          Effect.gen(function* () {
            const sessions = yield* readAll()
            const outbox = yield* readFeedbackOutbox()
            const kept: Array<GitHubFeedbackOutboxEntry> = []
            const replay: Array<GitHubFeedbackOutboxEntry> = []
          yield* reconcileFeedbackOutbox(outbox, kept, sessions, replay, writeFeedbackOutbox)
          return replay
          })
        )

      const markGitHubFeedbackDispatched = (
        id: string,
        deliveryId: string,
        semanticKey: string
      ): Effect.Effect<boolean, GitError, PersistEnv> =>
        atomically(
          Effect.gen(function* () {
            const sessions = yield* readAll()
            const session = sessions.find((candidate) => candidate.id === id)
            if (!session) return false
            const deliveries = session.githubFeedbackDeliveryIds ?? []
            const semantics = session.githubFeedbackSemanticKeys ?? []
            if (deliveries.includes(deliveryId) || semantics.includes(semanticKey)) return true
            const outbox = yield* readFeedbackOutbox()
            const index = outbox.findIndex(
              (entry) =>
                entry.sessionId === id &&
                (entry.event.deliveryId === deliveryId || entry.event.semanticKey === semanticKey)
            )
            if (index < 0) return false
            const entry = outbox[index]!
            const updatedOutbox = outbox.map((candidate, candidateIndex) =>
              candidateIndex === index
                ? {
                    ...candidate,
                    status: "dispatched" as const,
                    dispatchedAt: candidate.dispatchedAt ?? new Date().toISOString()
                  }
                : candidate
            )
            const pendingOutbox = updatedOutbox.filter(
              (candidate) => candidate.status === "pending"
            )
            const dispatchedOutbox = updatedOutbox
              .filter((candidate) => candidate.status === "dispatched")
              .slice(-2_048)
            // The outbox status is authoritative. Persist it first so a crash
            // can only leave a dispatched entry missing its compact ledger, not
            // a ledger entry that suppresses an undispatched instruction.
            yield* writeFeedbackOutbox([...pendingOutbox, ...dispatchedOutbox])
            const maximum = 2_048
            yield* writeAll(
              sessions.map((candidate) =>
                candidate.id === id
                  ? {
                      ...candidate,
                      githubFeedbackDeliveryIds: [...deliveries, entry.event.deliveryId].slice(
                        -maximum
                      ),
                      githubFeedbackSemanticKeys: [...semantics, entry.event.semanticKey].slice(
                        -maximum
                      )
                    }
                  : candidate
              )
            )
            return true
          })
        )

      const setCheckpointSafeMode = (id: string, enabled: boolean) =>
        update(id, (session) => ({ ...session, checkpointSafeMode: enabled })).pipe(Effect.tap(() => Effect.sync(() => setWorkspaceCheckpointMode(id, enabled))))
      const markCheckpointExecutionUnprovable = (id: string) => update(id, (session) => ({ ...session, checkpointExecutionHistory: "unprovable" }))

      const setWorkspaceLifecycle = (id: string, lifecycle: WorkspaceLifecycle) =>
        update(id, (session) => ({ ...session, workspaceLifecycle: lifecycle })).pipe(Effect.andThen(get(id).pipe(Effect.mapError((cause) => new GitError({ message: "Could not reload workspace lifecycle", cause })), Effect.tap((session) => Effect.sync(() => updateWorkspaceReadiness(session))), Effect.asVoid)))

      const reconcileInterruptedWorkspaceLifecycles = (): Effect.Effect<void, GitError, PersistEnv> =>
        atomically(Effect.gen(function* () {
          const sessions = yield* readAll()
          const now = new Date().toISOString()
          let changed = false
          const reconciled = sessions.map((session) => {
            const status = session.workspaceLifecycle?.status
            if (status !== "setup-running" && status !== "cleanup-running") return session
            changed = true
            return {
              ...session,
              workspaceLifecycle: {
                status: status === "setup-running" ? "setup-failed" as const : "cleanup-failed" as const,
                updatedAt: now,
                error: `${status === "setup-running" ? "Setup" : "Cleanup"} was interrupted when Jingler stopped. Retry explicitly.`
              }
            }
          })
          if (changed) yield* writeAll(reconciled)
        }))

      /** Persist an authoritative publication checkpoint for restart-safe retries. */
      const setPublishCheckpoint = (id: string, publish: Session["publish"]) =>
        update(id, (s) => ({ ...s, publish }))

    /**
     * Record a worktree that has MOVED — not one that was re-forked.
     *
     * `worktreePath` is stored absolute and nothing else rewrites it, so it
     * goes stale when `~/jingler` or the repo directory is renamed. The caller
     * (`healedWorktreePath`) only produces a new value after confirming the
     * directory is really there, so this never invents a path.
     */
    const setWorktreePath = (id: string, worktreePath: string) =>
        update(id, (s) => ({ ...s, worktreePath }))

      /** Attach a durable project identity without changing checkout/transcript state. */
      const setProject = (id: string, projectId: string) =>
        update(id, (session) => ({ ...session, projectId }))

      /** Replace every link (or, with `null`, clear them) for legacy callers. */
      const setIssue = (
        id: string,
        issue: {
          reference: IssueReference
          automations?: IssueAutomations
        } | null
      ) =>
        update(id, (session) =>
          issue
            ? withCanonicalIssues(
                session,
                [issue.reference],
                issue.reference,
                issue.automations
              )
            : withCanonicalIssues(session, [], undefined)
        )

      /** Add or refresh multiple links, selecting the last touched reference. */
      const addIssues = (id: string, issues: ReadonlyArray<IssueReference>) =>
        issues.length === 0
          ? Effect.void
          : update(id, (session) => {
              const merged = mergeIssueReferences(issueReferencesOf(session), issues)
              return withCanonicalIssues(session, merged, issues.at(-1))
            })

      /** Select one existing provider-scoped link; unknown identities are a no-op. */
      const selectIssue = (id: string, issue: IssueIdentity) =>
        update(id, (session) => {
          const linkedIssues = issueReferencesOf(session)
          return linkedIssues.some((candidate) => sameIssueIdentity(candidate, issue))
            ? withCanonicalIssues(session, linkedIssues, issue)
            : session
        })

      /** Remove one provider-scoped link while preserving every unrelated link. */
      const removeIssue = (id: string, issue: IssueIdentity) =>
        update(id, (session) => {
          const linkedIssues = issueReferencesOf(session)
          const remaining = linkedIssues.filter(
            (candidate) => !sameIssueIdentity(candidate, issue)
          )
          if (remaining.length === linkedIssues.length) return session
          const selected = issueReferenceOf(session)
          return withCanonicalIssues(
            session,
            remaining,
            selected && !sameIssueIdentity(selected, issue) ? selected : remaining.at(-1)
          )
        })

      /** Clear the one-shot `initialPrompt` once the composer has consumed it. */
      const clearInitialPrompt = (id: string) =>
        update(id, (s) => ({ ...s, initialPrompt: undefined }))

      /** Archive a session (its linked PR was merged/closed) — read-only, kept. */
      const archive = (id: string, reason: "merged" | "closed") =>
        Effect.gen(function* () {
          const now = yield* Effect.sync(() => new Date().toISOString())
          yield* update(id, (s) => ({
            ...s,
            archived: true,
            archiveReason: reason,
            archivedAt: now
          }))
        })

      /** Restore an archived session back to an editable state. */
      const restore = (id: string) =>
        update(id, (s) => ({
          ...s,
          archived: false,
          archiveReason: undefined,
          archivedAt: undefined
        }))

    /**
     * Permanently delete a session: remove an owned worktree (best-effort) and
     * drop it from the store. A direct checkout is never removed or unregistered.
     * Irreversible — the UI gates this behind a confirm.
     */
    const remove = (
        id: string
      ): Effect.Effect<
        void,
        GitError,
        | GitService
        | FileSystem.FileSystem
        | Path.Path
        | CommandExecutor.CommandExecutor
        | AppPaths
      > =>
        Effect.gen(function* () {
          const target = (yield* readAll()).find((s) => s.id === id)
          if (!target) return
          if (
            target.worktreePath &&
            workspaceModeOf(target) === "worktree"
          ) {
            const fs = yield* FileSystem.FileSystem
            const worktreeExists = yield* fs
              .exists(target.worktreePath)
              .pipe(Effect.orElseSucceed(() => false))
            // A blank session starts detached until its first generated title.
            // If it committed before that retitle, deleting the worktree would
            // otherwise remove the only reference to those commits.
            if (worktreeExists) {
              yield* GitService.preserveDetachedHead(
                target.worktreePath,
                basename(target.worktreePath)
              )
            }
            yield* GitService.removeWorktreeAt(target.worktreePath, target.repoPath).pipe(
              Effect.ignore
            )
          }
          // Re-read INSIDE the lock rather than filtering the list read above.
          // `removeWorktreeAt` shells out to git (`worktree remove --force`, then
          // a prune) and takes seconds; writing a list captured before that would
          // discard every turn's usage, status and resume-id written in the
          // meantime, and would resurrect any session created in the window.
          yield* atomically(
            Effect.gen(function* () {
              const current = yield* readAll()
              yield* writeAll(current.filter((s) => s.id !== id))
            })
          )
        })

      /** Mirror remote metadata without ever treating its paths as desktop paths. */
      const upsertRemote = (session: Session): Effect.Effect<Session, GitError, PersistEnv> =>
        atomically(
          Effect.gen(function* () {
            if (!session.environmentId) {
              return yield* Effect.fail(new GitError({
                message: "Remote session metadata is missing its environment identity"
              }))
            }
            const current = yield* readAll()
            const index = current.findIndex((candidate) => candidate.id === session.id)
            const next = [...current]
            if (index === -1) next.push(session)
            else next[index] = session
            yield* writeAll(next)
            return session
          })
        )

      /** Remove only the desktop mirror; remote cleanup is owned by the device. */
      const forgetRemote = (id: string): Effect.Effect<void, GitError, PersistEnv> =>
        atomically(
          Effect.gen(function* () {
            const current = yield* readAll()
            yield* writeAll(current.filter((session) => session.id !== id))
          })
        )

      return {
        list,
        get,
        create,
        createFromPr,
        createFromIssue,
        reassignWorkspacePorts,
        createChat,
        selectChat,
        renameChat,
        closeChat,
        discardClosedChat,
        reopenChat,
        setMode,
        setAgentModel,
        confirmAgentStart,
        confirmAgentModel,
        rollbackAgentModel,
        setProviderModel,
        setRuntimeRecovery,
        resolveRuntimeRecovery,
        setReasoning,
        addUsage,
        setContinuation,
        clearContinuation,
        setContextTokens,
        setChatContextTokens,
        setAutoCompact,
        setPersistent,
        setEnvironment,
        setTitle,
        setSemanticBranchProposal,
        setTitleAndBranch,
        setBranch,
        renameTitle,
        setStatus,
        addAllowlist,
        setPrNumber,
        setGitHubLink,
        claimGitHubFeedback,
        markGitHubFeedbackDispatched,
        recoverGitHubFeedbackOutbox,
        setPublishCheckpoint,
        setWorkspaceLifecycle,
        setCheckpointSafeMode,
        markCheckpointExecutionUnprovable,
        reconcileInterruptedWorkspaceLifecycles,
        setWorktreePath,
        setProject,
        setIssue,
        addIssues,
        selectIssue,
        removeIssue,
        clearInitialPrompt,
        archive,
        restore,
        upsertRemote,
        forgetRemote,
        remove
      }
    }
  }
) {}

function* reconcileFeedbackOutbox(
  outbox: ReadonlyArray<GitHubFeedbackOutboxEntry>,
  kept: Array<GitHubFeedbackOutboxEntry>,
  sessions: ReadonlyArray<Session>,
  replay: Array<GitHubFeedbackOutboxEntry>,
  writeFeedbackOutbox: (
    entries: ReadonlyArray<GitHubFeedbackOutboxEntry>
  ) => Effect.Effect<void, GitError, PersistEnv>
) {
  let changed = false
  for (const entry of outbox) {
    if (entry.status !== "pending") {
      kept.push(entry)
      continue
    }
    const session = sessions.find((candidate) => candidate.id === entry.sessionId)
    const linked =
      session !== undefined &&
      !session.archived &&
      session.githubInstallationId === entry.installationId &&
      session.githubRepositoryId === entry.repositoryId &&
      session.prNumber === entry.prNumber
    if (!linked) {
      changed = true
      continue
    }
    const deliveries = session.githubFeedbackDeliveryIds ?? []
    const semantics = session.githubFeedbackSemanticKeys ?? []
    if (
      deliveries.includes(entry.event.deliveryId) ||
      semantics.includes(entry.event.semanticKey)
    ) {
      changed = true
      kept.push({
        ...entry,
        status: "dispatched" as const,
        dispatchedAt: entry.dispatchedAt ?? new Date().toISOString()
      })
      continue
    }
    kept.push(entry)
    replay.push({ ...entry, chatId: session.activeChatId })
  }
  if (changed) {
    const pendingOutbox = kept.filter((candidate) => candidate.status === "pending")
    const dispatchedOutbox = kept
      .filter((candidate) => candidate.status === "dispatched")
      .slice(-2048)
    yield* writeFeedbackOutbox([...pendingOutbox, ...dispatchedOutbox])
  }
}

function* claimSessionFeedback(
  sessions: ReadonlyArray<Session>,
  id: string,
  input: Parameters<SessionStore["claimGitHubFeedback"]>[1],
  readFeedbackOutbox: () => Effect.Effect<
    ReadonlyArray<GitHubFeedbackOutboxEntry>,
    never,
    PersistEnv
  >,
  writeFeedbackOutbox: (
    entries: ReadonlyArray<GitHubFeedbackOutboxEntry>
  ) => Effect.Effect<void, GitError, PersistEnv>
) {
  const session = sessions.find((candidate) => candidate.id === id)
  if (
    !session ||
    session.archived ||
    session.githubInstallationId !== input.installationId ||
    session.githubRepositoryId !== input.repositoryId ||
    session.prNumber !== input.prNumber ||
    input.event.installationId !== input.installationId ||
    input.event.repository.id !== input.repositoryId ||
    input.event.pullRequest?.number !== input.prNumber
  ) {
    return "rejected" as const
  }
  const deliveries = session.githubFeedbackDeliveryIds ?? []
  const semantics = session.githubFeedbackSemanticKeys ?? []
  if (deliveries.includes(input.deliveryId) || semantics.includes(input.semanticKey)) {
    return "dispatched" as const
  }
  const outbox = yield* readFeedbackOutbox()
  const existing = outbox.find(
    (entry) =>
      entry.event.deliveryId === input.deliveryId || entry.event.semanticKey === input.semanticKey
  )
  if (existing) {
    return existing.sessionId === id ? existing.status : ("rejected" as const)
  }
  yield* writeFeedbackOutbox([
    ...outbox,
    {
      sessionId: id,
      chatId: session.activeChatId,
      installationId: input.installationId,
      repositoryId: input.repositoryId,
      prNumber: input.prNumber,
      event: input.event,
      status: "pending",
      createdAt: new Date().toISOString(),
      dispatchedAt: null
    }
  ])
  return "pending" as const
}

function* createIsolatedSession(
  input: CreateSessionInput,
  slug: string,
  existing: ReadonlyArray<Session>,
  makeSession: (
    workspace: { path: string; branch: string; repoPath: string },
    workspaceMode: WorkspaceMode
  ) => Session,
  atomically: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>,
  readAll: () => Effect.Effect<ReadonlyArray<Session>, never, PersistEnv>,
  ensureSessionIdAvailable: (
    sessions: readonly Session[],
    sessionId: string
  ) => Effect.Effect<void, GitError>,
  writeAll: (sessions: ReadonlyArray<Session>) => Effect.Effect<void, GitError, PersistEnv>,
  assignPorts: (session: Session, current: readonly Session[]) => Effect.Effect<Session, GitError, PersistEnv | Path.Path>
) {
  const worktreePath = yield* GitService.worktreePathFor(input.repoName, slug)
  if (existing.some((s) => s.worktreePath === worktreePath)) {
    return yield* Effect.fail(
      new GitError({
        message: "A session already exists for this branch name."
      })
    )
  }
  // Every fresh isolated task starts detached at the fresh base. The
  // first task-understanding/retitle pass proposes a semantic branch and
  // GitService creates it; a user-supplied title pins display text only.
  const worktree = yield* GitService.createDetachedWorktree({
    repoPath: input.repoPath,
    repoName: input.repoName,
    slug,
    baseBranch: input.baseBranch
  })
  if (input.continueBranch === true) {
    yield* GitService.checkoutBranch(worktree.path, input.baseBranch)
  }
  let session = makeSession(
    input.continueBranch === true ? { ...worktree, branch: input.baseBranch } : worktree,
    "worktree"
  )
  // `existing` was read above (for the friendly-name collision check).
  // Re-read INSIDE the lock rather than reusing the list read before
  // the worktree fork: that read is now seconds stale, and appending to
  // it would drop any session created — or any deps status written — in
  // the meantime.
  yield* atomically(
    Effect.gen(function* () {
      const current = yield* readAll()
      yield* ensureSessionIdAvailable(current, session.id)
      session = yield* assignPorts(session, current)
              yield* writeAll([session, ...current])
    })
  )
  // AFTER the write: the fibre patches this session by id, so the record
  // it patches has to exist before it can run.
  return session
}

function* readPersistedSessions(fs: FileSystem.FileSystem) {
  const paths = yield* AppPaths
  const exists = yield* fs.exists(paths.sessionsFile).pipe(Effect.orElseSucceed(() => false))
  if (!exists) return []
  const raw = yield* fs.readFileString(paths.sessionsFile).pipe(Effect.orElseSucceed(() => ""))
  if (raw.trim().length === 0) return []
  const parsed = yield* Schema.decodeUnknown(Schema.parseJson(Schema.Unknown))(raw).pipe(
    Effect.orElseSucceed(() => null)
  )
  if (!Array.isArray(parsed)) return []
  const sessions: Array<Session> = []
  for (const value of parsed) {
    const decoded = Schema.decodeUnknownEither(SessionSchema)(
      migrateLegacyRuntimeIdentity(migrateRepoName(migrateSessionChats(value)))
    )
    if (Either.isRight(decoded)) { updateWorkspaceReadiness(decoded.right); sessions.push(decoded.right) }
  }
  return sessions
}
