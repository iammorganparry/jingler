import type {
  Chat,
  ChatRole,
  CliKind,
  CreateSessionFromIssueInput,
  CreateSessionFromPrInput,
  CreateSessionInput,
  GitHubFeedbackClaimStatus,
  GitHubFeedbackOutboxEntry,
  GitHubRelayEvent,
  IssueAutomations,
  PermissionMode,
  ReasoningEffort,
  ReasoningSetting,
  Session,
  SettledSessionStatus,
  WorkspaceMode
} from "@jingler/core"
import {
  GitHubApiError,
  GitError,
  semanticBranchProposalFromName,
  SessionNotFoundError,
  supportsPlanMode,
  UNTITLED_SESSION,
  workspaceModeOf
} from "@jingler/core"
import { Session as SessionSchema } from "@jingler/core"
import { GitHubFeedbackOutboxEntry as GitHubFeedbackOutboxEntrySchema } from "@jingler/core"
import { basename } from "node:path"
import { FileSystem, Path } from "@effect/platform"
import type { CommandExecutor } from "@effect/platform"
import { Effect, Either, Schema } from "effect"
import { AppPaths } from "./app-paths.js"
import { freeCreativeName } from "./creative-name.js"
import { GitHubApi } from "./github-api.js"
import { GitService } from "./git.js"

const SessionArray = Schema.Array(SessionSchema)
const GitHubFeedbackOutbox = Schema.Array(GitHubFeedbackOutboxEntrySchema)

type JsonRecord = Record<string, unknown>

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const chatIdFor = (sessionId: string, suffix: string): string => `c_${sessionId}_${suffix}`

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

const persistedChatRole = (value: unknown): ChatRole | undefined =>
  value === "direct" || value === "orchestrator" ? value : undefined

const initialChat = (
  sessionId: string,
  now: string,
  legacy: JsonRecord = {}
): Chat => ({
  id: chatIdFor(sessionId, "1"),
  title: null,
  createdAt: now,
  updatedAt: now,
  ...(persistedChatRole(legacy.role) === undefined
    ? {}
    : { role: persistedChatRole(legacy.role) }),
  ...(typeof legacy.resumeId === "string" ? { resumeId: legacy.resumeId } : {}),
  ...(persistedMode(legacy.mode) === undefined ? {} : { mode: persistedMode(legacy.mode) }),
  ...(Array.isArray(legacy.allowlist) &&
  legacy.allowlist.every((entry) => typeof entry === "string")
    ? { allowlist: legacy.allowlist }
    : {}),
  ...(typeof legacy.model === "string" ? { model: legacy.model } : {}),
  ...(typeof legacy.contextTokens === "number" &&
  Number.isFinite(legacy.contextTokens) &&
  legacy.contextTokens >= 0
    ? { contextTokens: legacy.contextTokens }
    : {})
})

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

/**
 * Upgrade the old one-session/one-transcript shape before schema decoding.
 * The transformation is deterministic, so a legacy file can be read repeatedly
 * before the next mutation persists the upgraded representation.
 */
export const migrateSessionChats = (value: unknown): unknown => {
  if (!isRecord(value) || typeof value.id !== "string") return value
  const now = typeof value.updatedAt === "string" ? value.updatedAt : new Date(0).toISOString()
  const rawChats =
    Array.isArray(value.chats) && value.chats.length > 0
      ? value.chats
      : [initialChat(value.id, now, value)]
  const chats = rawChats.map((chat) =>
    isRecord(chat)
      ? {
          ...chat,
          ...(persistedMode(chat.mode) === undefined ? {} : { mode: persistedMode(chat.mode) })
        }
      : chat
  )
  const chatIds = new Set(
    chats.flatMap((chat) =>
      isRecord(chat) && typeof chat.id === "string" ? [chat.id] : []
    )
  )
  const activeChatId =
    typeof value.activeChatId === "string" && chatIds.has(value.activeChatId)
      ? value.activeChatId
      : (chatIds.values().next().value ?? chatIdFor(value.id, "1"))
  const key = reasoningKey(value.cli)
  const migratedReasoning = migrateReasoning(value.reasoningEffort)
  const reasoning =
    isRecord(value.reasoning)
      ? value.reasoning
      : key !== null && migratedReasoning !== undefined
        ? { [key]: migratedReasoning }
        : undefined
  const {
    resumeId: _resumeId,
    mode: _mode,
    allowlist: _allowlist,
    model: _model,
    reasoningEffort: _reasoningEffort,
    ...session
  } = value
  return {
    ...session,
    chats,
    activeChatId,
    ...(reasoning === undefined ? {} : { reasoning })
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
  if (!isRecord(value)) return value
  const repoPath = typeof value.repoPath === "string" ? value.repoPath.trim() : ""
  if (repoPath.length === 0) return value
  const derived = basename(repoPath)
  // `basename` yields "" for "/" and for a path that is only separators. An
  // empty group heading is worse than a stale one, so keep what was stored.
  if (derived.length === 0 || derived === value.repo) return value
  return { ...value, repo: derived }
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
      const atomically = <A, E, R>(
        effect: Effect.Effect<A, E, R>
      ): Effect.Effect<A, E, R> => lock.withPermits(1)(effect)
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
          const paths = yield* AppPaths
          const exists = yield* fs
            .exists(paths.sessionsFile)
            .pipe(Effect.orElseSucceed(() => false))
          if (!exists) return []
          const raw = yield* fs
            .readFileString(paths.sessionsFile)
            .pipe(Effect.orElseSucceed(() => ""))
          if (raw.trim().length === 0) return []
          const parsed = yield* Schema.decodeUnknown(Schema.parseJson(Schema.Unknown))(raw).pipe(
            Effect.orElseSucceed(() => null)
          )
          if (!Array.isArray(parsed)) return []
          const sessions: Array<Session> = []
          for (const value of parsed) {
            const decoded = Schema.decodeUnknownEither(SessionSchema)(
              migrateRepoName(migrateSessionChats(value))
            )
            if (Either.isRight(decoded)) sessions.push(decoded.right)
          }
          return sessions
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
          const encoded = yield* Schema.encode(SessionArray)(sessions).pipe(
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

      const create = (
        input: CreateSessionInput,
        /** Provider defaults (from config) to stamp onto the new session. */
        options: {
          chatRole?: ChatRole
          defaultMode?: PermissionMode
          defaultModel?: string
          defaultReasoning?: ReasoningSetting
        } = {}
      ): Effect.Effect<
        Session,
        GitError,
        | GitService
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
          const title = explicit || UNTITLED_SESSION
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
            slug = freeCreativeName(usedSlugs, seed, `${taskSlug(title)}-${stamp}`)
          }
          const id = `s_${slug}`
          const chat = initialChat(id, now, {
            role: options.chatRole,
            mode: options.defaultMode,
            model: options.defaultModel
          })
          const providerKey = reasoningKey(input.cli)
          const makeSession = (
            workspace: { path: string; branch: string; repoPath: string },
            workspaceMode: WorkspaceMode
          ): Session => ({
            id,
            ...(input.environmentId === undefined ? {} : { environmentId: input.environmentId }),
            repo: input.repoName,
            branch: workspace.branch,
            ...(workspaceMode === "worktree" ? { semanticBranchPending: true } : {}),
            title,
            autoTitle: explicit.length === 0,
            status: "idle",
            cli: input.cli,
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
            ...(providerKey !== null && options.defaultReasoning
              ? {
                  reasoning: {
                    [providerKey]: options.defaultReasoning
                  }
                }
              : {})
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
          const worktreePath = yield* GitService.worktreePathFor(input.repoName, slug)
          if (existing.some((s) => s.worktreePath === worktreePath)) {
            return yield* Effect.fail(
              new GitError({ message: "A session already exists for this branch name." })
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
          const session = makeSession(worktree, "worktree")
          // `existing` was read above (for the friendly-name collision check).
          // Re-read INSIDE the lock rather than reusing the list read before
          // the worktree fork: that read is now seconds stale, and appending to
          // it would drop any session created — or any deps status written — in
          // the meantime.
          yield* atomically(
            Effect.gen(function* () {
              const current = yield* readAll()
              yield* writeAll([session, ...current])
            })
          )
          // AFTER the write: the fibre patches this session by id, so the record
          // it patches has to exist before it can run.
          return session
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
          chatRole?: ChatRole
          defaultMode?: PermissionMode
          defaultModel?: string
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
          const now = yield* Effect.sync(() => new Date().toISOString())
          const stamp = yield* Effect.sync(() => Date.now().toString(36))
          const id = `s_${slug}_${stamp}`
          const chat = initialChat(id, now, {
            role: opts.chatRole,
            mode: opts.defaultMode,
            model: opts.defaultModel
          })
          const providerKey = reasoningKey(input.cli)
          const session: Session = {
            id,
            ...(input.environmentId === undefined ? {} : { environmentId: input.environmentId }),
            repo: input.repoName,
            branch,
            title: input.pr.title,
            status: "idle",
            cli: input.cli,
            diff: { added: 0, removed: 0 },
            prNumber: input.pr.number,
            githubInstallationId: repository.installationId,
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
            ...(providerKey !== null && opts.defaultReasoning
              ? {
                  reasoning: {
                    [providerKey]: opts.defaultReasoning
                  }
                }
              : {})
          }
          const existing = yield* readAll()
          // Re-read INSIDE the lock rather than reusing the list read before
          // the worktree fork: that read is now seconds stale, and appending to
          // it would drop any session created — or any deps status written — in
          // the meantime.
          yield* atomically(
            Effect.gen(function* () {
              const current = yield* readAll()
              yield* writeAll([session, ...current])
            })
          )
          return session
        })

      /**
       * Create a session from a GitHub issue. Like `create` it starts DETACHED
       * from a fresh `baseBranch` (the issue number still keys the worktree path),
       * enables the chosen automations, and seeds `initialPrompt` from the issue
       * title + body (the composer pre-fills it once; HITL — the user sends it).
       */
      const createFromIssue = (
        input: CreateSessionFromIssueInput,
        options: {
          chatRole?: ChatRole
          defaultMode?: PermissionMode
          defaultModel?: string
          defaultReasoning?: ReasoningSetting
        } = {}
      ): Effect.Effect<
        Session,
        GitError,
        | GitService
        | FileSystem.FileSystem
        | Path.Path
        | CommandExecutor.CommandExecutor
        | AppPaths
      > =>
        Effect.gen(function* () {
          const now = yield* Effect.sync(() => new Date().toISOString())
          const stamp = yield* Effect.sync(() => Date.now().toString(36))
          const slug = `${input.issue.number}-${taskSlug(input.issue.title)}`
          // Guard: one session per issue worktree (the slug is deterministic).
          const worktreePath = yield* GitService.worktreePathFor(input.repoName, slug)
          const prior = yield* readAll()
          if (prior.some((s) => s.worktreePath === worktreePath)) {
            return yield* Effect.fail(
              new GitError({ message: "A session already exists for this issue." })
            )
          }
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
          const id = `s_${slug}_${stamp}`
          const chat = initialChat(id, now, {
            role: options.chatRole,
            mode: options.defaultMode,
            model: options.defaultModel
          })
          const providerKey = reasoningKey(input.cli)
          const session: Session = {
            // Stamp the id (like `createFromPr`) so a delete-then-recreate of the
            // same issue can't collide with the old session's persisted data; the
            // worktree slug stays deterministic for the one-session-per-issue guard.
            id,
            ...(input.environmentId === undefined ? {} : { environmentId: input.environmentId }),
            repo: input.repoName,
            branch: worktree.branch,
            semanticBranchPending: true,
            // Seed (and pin) the title from the issue.
            title: input.issue.title,
            autoTitle: false,
            status: "idle",
            cli: input.cli,
            diff: { added: 0, removed: 0 },
            prNumber: null,
            issueNumber: input.issue.number,
            issueUrl: input.issue.url,
            issueTitle: input.issue.title,
            issueLabels: input.issue.labels.map((l) => ({ name: l.name, color: l.color })),
            automations: input.automations,
            ...(task.length > 0 ? { initialPrompt: task } : {}),
            costUsd: 0,
            tokens: 0,
            updatedAt: now,
            chats: [chat],
            activeChatId: chat.id,
            worktreePath: worktree.path,
            workspaceMode: "worktree",
            repoPath: worktree.repoPath,
            baseBranch: input.baseBranch,
            ...(providerKey !== null && options.defaultReasoning
              ? {
                  reasoning: {
                    [providerKey]: options.defaultReasoning
                  }
                }
              : {})
          }
          // Re-read INSIDE the lock rather than reusing the list read before
          // the worktree fork: that read is now seconds stale, and appending to
          // it would drop any session created — or any deps status written — in
          // the meantime.
          yield* atomically(
            Effect.gen(function* () {
              const current = yield* readAll()
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
              ...(source?.role === undefined ? {} : { role: source.role }),
              ...(source?.orchestratorEnabled === undefined
                ? {}
                : { orchestratorEnabled: source.orchestratorEnabled }),
              ...(source?.mode === undefined ? {} : { mode: source.mode }),
              ...(source?.model === undefined ? {} : { model: source.model }),
              ...(source?.allowlist === undefined ? {} : { allowlist: source.allowlist })
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

      const closeChat = (sessionId: string, chatId: string) =>
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
              ...(closed?.role === undefined ? {} : { role: closed.role }),
              ...(closed?.orchestratorEnabled === undefined
                ? {}
                : { orchestratorEnabled: closed.orchestratorEnabled }),
              ...(closed?.mode === undefined ? {} : { mode: closed.mode }),
              ...(closed?.model === undefined ? {} : { model: closed.model }),
              ...(closed?.allowlist === undefined ? {} : { allowlist: closed.allowlist })
            }
            const chats = remaining.length > 0 ? remaining : [replacement]
            const activeChatId =
              session.activeChatId === chatId
                ? chats[Math.min(index, chats.length - 1)]!.id
                : session.activeChatId
            return {
              ...session,
              chats,
              closedChats: [
                closed!,
                ...(session.closedChats ?? []).filter((chat) => chat.id !== chatId)
              ],
              activeChatId,
              updatedAt: now
            }
          })
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

      /** Persist one orchestrator chat's Jingler-mode choice. */
      const setOrchestratorEnabled = (
        id: string,
        chatId: string,
        orchestratorEnabled: boolean
      ) =>
        Effect.gen(function* () {
          const session = yield* get(id)
          if (!session.chats.some((chat) => chat.id === chatId)) {
            return yield* Effect.fail(
              new GitError({
                message: `Chat "${chatId}" does not exist in session "${id}".`
              })
            )
          }
          yield* updateChat(id, chatId, (chat) => ({
            ...chat,
            orchestratorEnabled
          }))
          return yield* get(id)
        })

      /** Persist one chat's harness model. */
      const setModel = (id: string, chatIdOrModel: string, maybeModel?: string) =>
        update(id, (session) => {
          const chatId = maybeModel === undefined ? session.activeChatId : chatIdOrModel
          const model = maybeModel ?? chatIdOrModel
          return {
            ...session,
            model,
            chats: session.chats.map((chat) =>
              chat.id === chatId ? { ...chat, model } : chat
            )
          }
        })

      /** Persist a provider-native session reasoning choice. */
      const setReasoning = (
        id: string,
        cli: "claude" | "codex" | "opencode",
        reasoning: ReasoningSetting | undefined
      ) =>
        update(id, (session) => ({
          ...session,
          reasoning: {
            ...session.reasoning,
            [cli]: reasoning
          }
        }))

      /** Temporary compatibility shim for callers being migrated to `setReasoning`. */
      const setReasoningEffort = (
        id: string,
        reasoningEffort:
          | ReasoningEffort
          | "off"
          | "think"
          | "think-hard"
          | "ultrathink"
          | undefined
      ) =>
        update(id, (session) => {
          const key = reasoningKey(session.cli)
          const migrated = migrateReasoning(reasoningEffort)
          return {
            ...session,
            reasoningEffort,
            ...(key === null
              ? {}
              : {
                  reasoning: {
                    ...session.reasoning,
                    [key]: migrated
                  }
                })
          }
        })

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

      /**
       * Switch the session's harness and model together.
       *
       * When `cli` actually changes, `resumeId` MUST be dropped: it holds the
       * *previous* harness's thread id, and handing a Codex thread id to Claude
       * (or vice versa) would either error or resume something unrelated. The new
       * harness therefore starts a fresh thread — the transcript on screen is
       * unaffected, but the agent won't recall earlier turns.
       *
       * `plan` mode survives a switch between harnesses that can hold it (see
       * `supportsPlanMode`) and coerces back to `ask` on one that can't, rather
       * than handing the runner a mode the new harness cannot honour — which on
       * Codex would have meant a "planning" turn with write access.
       */
      const setHarness = (
        id: string,
        chatIdOrCli: string,
        cliOrModel: CliKind | string,
        maybeModel?: string
      ) =>
        update(id, (s) =>
          {
            const chatId = maybeModel === undefined ? s.activeChatId : chatIdOrCli
            const cli = (maybeModel === undefined ? chatIdOrCli : cliOrModel) as CliKind
            const model = maybeModel ?? cliOrModel
            return (
          s.cli === cli
            ? {
                ...s,
                model,
                chats: s.chats.map((chat) =>
                  chat.id === chatId ? { ...chat, model } : chat
                )
              }
            : {
                ...s,
                cli,
                model,
                resumeId: undefined,
                chats: s.chats.map((chat) =>
                  ({
                    ...chat,
                    model: chat.id === chatId ? model : undefined,
                    resumeId: undefined,
                    mode:
                      chat.mode === "plan" && !supportsPlanMode(cli)
                        ? "ask"
                        : chat.mode
                  })
                )
              }
            )
          }
        )

      /** Persist the harness session id so the conversation resumes after a restart. */
      const setResumeId = (id: string, chatIdOrResumeId: string, maybeResumeId?: string) =>
        update(id, (session) => {
          const chatId = maybeResumeId === undefined ? session.activeChatId : chatIdOrResumeId
          const resumeId = maybeResumeId ?? chatIdOrResumeId
          return {
            ...session,
            resumeId,
            chats: session.chats.map((chat) =>
              chat.id === chatId ? { ...chat, resumeId } : chat
            )
          }
        })

      /**
       * Drop the harness session id so the NEXT turn starts a fresh conversation.
       *
       * This is how compaction reseeds: the transcript on disk is untouched, but
       * the harness is asked to begin again from a summary. `undefined` rather
       * than null because `resumeId` is `optional` — writing null would persist a
       * key the schema rejects on the next read.
       */
      const clearResumeId = (id: string, chatId?: string) =>
        update(id, (session) => {
          const target = chatId ?? session.activeChatId
          return {
            ...session,
            resumeId: undefined,
            chats: session.chats.map((chat) =>
              chat.id === target ? { ...chat, resumeId: undefined } : chat
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
          ...(semanticBranchProposal === undefined ? {} : { semanticBranchProposal }),
          semanticBranchPending: false
        }))

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

      /** Link (or clear) the session's pull-request number. */
      const setPrNumber = (id: string, prNumber: number | null) =>
        update(id, (s) => ({ ...s, prNumber }))

      /** Persist immutable GitHub routing identity alongside the linked PR. */
      const setGitHubLink = (
        id: string,
        link: { readonly installationId: string; readonly repositoryId: string; readonly prNumber: number }
      ) =>
        update(id, (session) => ({
          ...session,
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
                entry.event.deliveryId === input.deliveryId ||
                entry.event.semanticKey === input.semanticKey
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

      /** Link (or, with `null`, unlink) a GitHub issue on a live session. */
      const setIssue = (
        id: string,
        issue: {
          number: number
          url: string
          title: string
          labels: ReadonlyArray<{ name: string; color: string | null }>
          automations: IssueAutomations
        } | null
      ) =>
        update(id, (s) =>
          issue
            ? {
                ...s,
                issueNumber: issue.number,
                issueUrl: issue.url,
                issueTitle: issue.title,
                issueLabels: issue.labels,
                automations: issue.automations
              }
            : {
                ...s,
                issueNumber: undefined,
                issueUrl: undefined,
                issueTitle: undefined,
                issueLabels: undefined,
                automations: undefined
              }
        )

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
        GitService | FileSystem.FileSystem | Path.Path | CommandExecutor.CommandExecutor | AppPaths
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
        createChat,
        selectChat,
        renameChat,
        closeChat,
        reopenChat,
        setMode,
        setOrchestratorEnabled,
        setModel,
        setReasoning,
        setReasoningEffort,
        addUsage,
        setHarness,
        setResumeId,
        clearResumeId,
        setContextTokens,
        setChatContextTokens,
        setAutoCompact,
        setPersistent,
        setEnvironment,
        setTitle,
        setSemanticBranchProposal,
        setTitleAndBranch,
        renameTitle,
        setStatus,
        addAllowlist,
        setPrNumber,
        setGitHubLink,
        claimGitHubFeedback,
        markGitHubFeedbackDispatched,
        setPublishCheckpoint,
        setWorktreePath,
        setIssue,
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
