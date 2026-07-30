import type { ResolvingCommit, Worktree } from "@jingler/core"
import { GitError } from "@jingler/core"
import { FileSystem, Path } from "@effect/platform"
import type { CommandExecutor } from "@effect/platform"
import { Effect } from "effect"
import { AppPaths } from "./app-paths.js"
import { gitLine, runGit, runString } from "./command.js"

/** Parameters for forking an isolated worktree from a repo. */
export interface CreateWorktreeInput {
  /** Absolute path to the origin repo. */
  readonly repoPath: string
  /** The repo's folder name (namespaces the worktree directory). */
  readonly repoName: string
  /** Kebab slug for the branch/worktree (branch becomes `jingler/<slug>`). */
  readonly slug: string
  /** The branch to fork from. */
  readonly baseBranch: string
}

export interface RepositoryIdentity {
  /** Canonical primary checkout path used as the direct session cwd. */
  readonly repoPath: string
  /** Canonical Git common directory shared by every alias/worktree of the repo. */
  readonly commonDir: string
}

type GitEnv =
  | AppPaths
  | FileSystem.FileSystem
  | Path.Path
  | CommandExecutor.CommandExecutor

/** The current branch name checked out at `cwd`, or null (detached / error). */
export const branchAt = (
  cwd: string
): Effect.Effect<string | null, never, CommandExecutor.CommandExecutor> =>
  gitLine(cwd, "rev-parse", "--abbrev-ref", "HEAD").pipe(
    Effect.map((branch) => (branch === null || branch === "HEAD" ? null : branch))
  )

/**
 * Worktree paths whose link to their repo has already been checked this run.
 *
 * The check costs a `git rev-parse` subprocess and the answer cannot change
 * while the app runs, so it is worth paying once per worktree rather than once
 * per turn. A FAILED repair is recorded too: re-attempting a repair that cannot
 * succeed would spawn two subprocesses on every message, forever.
 *
 * Module-level rather than per-service so this stays a plain function — it needs
 * nothing from `GitService`, and threading that service into `AgentRunner` just
 * to reach it would add a dependency to eighteen unrelated test layer sets.
 */
const linkChecked = new Set<string>()

/** Test seam: forget what has been checked, so a case can observe the first call. */
export const resetWorktreeLinkCache = (): void => linkChecked.clear()

/**
 * Re-point a worktree at its repo after the repo directory moved.
 *
 * A linked worktree does not contain a repository. It contains a `.git` FILE
 * holding an ABSOLUTE path to `<repo>/.git/worktrees/<name>`, and the repo holds
 * an absolute path back to the worktree in that directory's `gitdir` file.
 * Renaming the repo directory breaks the pair in both directions, and every git
 * command run inside the worktree then fails with "not a git repository".
 *
 * For a session that means no diff, no commit, and an agent that edits files
 * happily right up until the moment anything touches git — with nothing
 * anywhere naming the rename as the cause.
 *
 * `git worktree repair` is git's own remedy and rewrites both ends. It is run
 * FROM the repo, which knows where it is, and pointed at the worktree.
 *
 * Best-effort throughout: a healthy worktree costs one `rev-parse` and changes
 * nothing, so this is safe to call before any use of a worktree. A worktree
 * that is broken for some OTHER reason — deleted, or never registered — is left
 * exactly as it was for the caller to fail on, rather than being quietly
 * re-created here, which would hand an agent an empty tree wearing the right
 * name.
 */
export const ensureWorktreeLinked = (
  repoPath: string,
  worktreePath: string
): Effect.Effect<void, never, FileSystem.FileSystem | CommandExecutor.CommandExecutor> =>
  Effect.gen(function* () {
    if (worktreePath.length === 0 || repoPath.length === 0) return
    if (linkChecked.has(worktreePath)) return
    const fs = yield* FileSystem.FileSystem
    // A worktree that is not on disk is a different failure with a different
    // fix. `repair` would do nothing for it, and recording an attempt invites
    // the caller to read "checked" as "recoverable".
    const exists = yield* fs.exists(worktreePath).pipe(Effect.orElseSucceed(() => false))
    if (!exists) return
    linkChecked.add(worktreePath)
    const linked = yield* runGit(worktreePath, ["rev-parse", "--git-dir"]).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false)
    )
    if (linked) return
    yield* runGit(repoPath, ["worktree", "repair", worktreePath]).pipe(Effect.ignore)
  })

/** Switch a detached worktree, or return the branch a concurrent switch activated. */
const switchTaskBranch = (
  cwd: string,
  branch: string
): Effect.Effect<string, GitError, CommandExecutor.CommandExecutor> =>
  runGit(cwd, ["switch", "-c", branch]).pipe(
    Effect.as(branch),
    Effect.catchAll((error) =>
      branchAt(cwd).pipe(
        Effect.flatMap((winner) =>
          winner === null ? Effect.fail(error) : Effect.succeed(winner)
        )
      )
    )
  )

const claimTaskBranch = (
  cwd: string,
  slug: string,
  suffix: number
): Effect.Effect<string, GitError, CommandExecutor.CommandExecutor> => {
  const branch = `jingler/${slug}${suffix === 1 ? "" : `-${suffix}`}`
  return gitLine(cwd, "show-ref", "--verify", `refs/heads/${branch}`).pipe(
    Effect.flatMap((existing) => {
      if (existing !== null) return claimTaskBranch(cwd, slug, suffix + 1)
      return branchAt(cwd).pipe(
        Effect.flatMap((active) =>
          active === null ? switchTaskBranch(cwd, branch) : Effect.succeed(active)
        )
      )
    })
  )
}

/**
 * Name a detached session from its task without moving its HEAD.
 *
 * `git switch -c` creates the ref at the current detached commit and keeps both
 * uncommitted changes and detached commits in place. Existing names receive a
 * deterministic numeric suffix. Concurrent activations converge on the branch
 * that first became live instead of creating another suffix.
 */
const createTaskBranch = (
  cwd: string,
  slug: string
): Effect.Effect<string, GitError, CommandExecutor.CommandExecutor> =>
  branchAt(cwd).pipe(
    Effect.flatMap((active) =>
      active === null ? claimTaskBranch(cwd, slug, 1) : Effect.succeed(active)
    )
  )

/**
 * Whether `branch` is checked out in the repo's MAIN working tree, per the
 * output of `git worktree list --porcelain`.
 *
 * Records are blank-line separated and the FIRST record is always the main
 * working tree — the developer's own checkout. That asymmetry is the whole
 * point: sharing a branch ref between two SESSION worktrees is recoverable
 * noise, but sharing one with the main checkout means an agent's commits
 * silently move the branch the developer is standing on. That is how sessions
 * ended up appearing to "commit to main".
 *
 * Pure, so the decision is testable without a real repo.
 */
export const mainTreeHoldsBranch = (porcelain: string, branch: string): boolean => {
  const [mainRecord] = porcelain.trim().split(/\n\s*\n/)
  if (mainRecord === undefined) return false
  return mainRecord
    .split("\n")
    .some((line) => line.trim() === `branch refs/heads/${branch}`)
}

/**
 * Creates isolated git worktrees for sessions. A worktree is added under
 * `~/jingler/worktrees/<repo>/<slug>` on a fresh `jingler/<slug>` branch forked
 * from `baseBranch`.
 *
 * Dependencies are NOT mirrored here. This service used to build the worktree a
 * `node_modules` out of symlinks into the origin repo's, to avoid duplicating
 * them on disk. Two measurements retired that:
 *
 *  - It did not survive. The first `pnpm install` an agent ran inside a session
 *    replaced the mirror with a real tree — true of 33 of 39 live worktrees when
 *    this was removed, so the mirror was doing nothing in ~85% of cases.
 *  - It was not saving what it appeared to. `du` reports a worktree's
 *    `node_modules` at its full logical size, but package managers on APFS
 *    import via `clonefile`, so the blocks are already shared copy-on-write.
 *    Deleting a "1.7 GB" worktree tree returned ~310 MB of real disk.
 *
 * So a worktree now starts as a plain checkout with no `node_modules`, and the
 * agent installs when it needs to — which is what it was already doing. That is
 * also cheaper than it sounds: package managers import from a shared
 * content-addressed store, and on APFS with copy-on-write clones, so the second
 * worktree of a repo costs a fraction of the first in real blocks.
 */
export class GitService extends Effect.Service<GitService>()(
  "@jingler/GitService",
  {
    accessors: true,
    sync: () => {
      /** The `~/jingler/worktrees/<repo>/<slug>` path (pure — no side effects). */
      const worktreePathFor = (
        repoName: string,
        slug: string
      ): Effect.Effect<string, never, AppPaths | Path.Path> =>
        Effect.gen(function* () {
          const paths = yield* AppPaths
          const path = yield* Path.Path
          return path.join(paths.worktreesDir, repoName, slug)
        })

      /** Resolve the worktree path and ensure its parent directory exists. */
      const resolveWorktreePath = (
        input: CreateWorktreeInput
      ): Effect.Effect<string, GitError, AppPaths | Path.Path | FileSystem.FileSystem> =>
        Effect.gen(function* () {
          const path = yield* Path.Path
          const fs = yield* FileSystem.FileSystem
          const worktreePath = yield* worktreePathFor(input.repoName, input.slug)
          yield* fs
            .makeDirectory(path.dirname(worktreePath), { recursive: true })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new GitError({ message: "Failed to create worktrees directory", cause })
              )
            )
          return worktreePath
        })

      /**
       * Reclaim a leftover worktree directory at `worktreePath` before adding a
       * new one there — an earlier attempt may have created the worktree but
       * failed before persisting a session, orphaning the directory. Unregister
       * it (`git worktree remove --force` + `prune`) and delete any remainder.
       * All best-effort: a clean path is a no-op. The caller is responsible for
       * not calling this on a path a live session still owns.
       */
      const reclaimStaleWorktree = (
        repoPath: string,
        worktreePath: string
      ): Effect.Effect<void, never, FileSystem.FileSystem | CommandExecutor.CommandExecutor> =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const exists = yield* fs.exists(worktreePath).pipe(Effect.orElseSucceed(() => false))
          if (!exists) return
          yield* runGit(repoPath, ["worktree", "remove", "--force", worktreePath]).pipe(Effect.ignore)
          yield* runGit(repoPath, ["worktree", "prune"]).pipe(Effect.ignore)
          yield* fs.remove(worktreePath, { recursive: true }).pipe(Effect.ignore)
        })


      /**
       * Best-effort refresh of `baseBranch` from origin so a new worktree forks
       * from the up-to-date remote tip rather than a stale local ref. MUST NOT
       * fail creation: offline, no `origin`, or a local-only base branch all fold
       * to a no-op (the caller then forks from the local ref). Single-branch,
       * `--no-tags` to keep the cost bounded on large repos.
       */
      const fetchBase = (
        repoPath: string,
        baseBranch: string
      ): Effect.Effect<void, never, CommandExecutor.CommandExecutor> =>
        runGit(repoPath, ["fetch", "--no-tags", "origin", baseBranch]).pipe(Effect.ignore)

      /**
       * The start-point to fork the session branch from: the fresh
       * remote-tracking `origin/<baseBranch>` when it exists, else the local
       * `baseBranch`. `gitLine` folds a missing ref (rev-parse exits non-zero) to
       * null, so a local-only base or a repo without `origin` falls back cleanly.
       */
      const resolveStartPoint = (
        repoPath: string,
        baseBranch: string
      ): Effect.Effect<string, never, CommandExecutor.CommandExecutor> =>
        gitLine(repoPath, "rev-parse", "--verify", "--quiet", `refs/remotes/origin/${baseBranch}`).pipe(
          Effect.map((sha) => (sha ? `origin/${baseBranch}` : baseBranch))
        )

      /** Fork an isolated worktree on a fresh `jingler/<slug>` branch. */
      const createWorktree = (
        input: CreateWorktreeInput
      ): Effect.Effect<Worktree, GitError, GitEnv> =>
        Effect.gen(function* () {
          const branch = `jingler/${input.slug}`
          const worktreePath = yield* resolveWorktreePath(input)
          yield* reclaimStaleWorktree(input.repoPath, worktreePath)
          // Freshen the base from origin, then fork off the remote tip when we have
          // one — so a session always starts from an up-to-date base (e.g. main).
          yield* fetchBase(input.repoPath, input.baseBranch)
          const startPoint = yield* resolveStartPoint(input.repoPath, input.baseBranch)
          yield* runGit(input.repoPath, [
            "worktree",
            "add",
            "-b",
            branch,
            worktreePath,
            startPoint
          ])
          // Report the logical base the user picked, not the start-point ref.
          return { path: worktreePath, branch, baseBranch: input.baseBranch, repoPath: input.repoPath }
        })

      /**
       * Add a worktree with a DETACHED HEAD at the fresh base tip (no new
       * branch). Used both for unnamed sessions awaiting their generated task
       * name and as the landing pad for a "session from PR" flow.
       */
      const createDetachedWorktree = (
        input: CreateWorktreeInput
      ): Effect.Effect<Worktree, GitError, GitEnv> =>
        Effect.gen(function* () {
          const worktreePath = yield* resolveWorktreePath(input)
          yield* reclaimStaleWorktree(input.repoPath, worktreePath)
          yield* fetchBase(input.repoPath, input.baseBranch)
          const startPoint = yield* resolveStartPoint(input.repoPath, input.baseBranch)
          yield* runGit(input.repoPath, [
            "worktree",
            "add",
            "--detach",
            worktreePath,
            startPoint
          ])
          // `branch` is a placeholder — the caller overwrites it with the real
          // head branch after `gh pr checkout` moves this worktree's HEAD.
          return {
            path: worktreePath,
            branch: input.baseBranch,
            baseBranch: input.baseBranch,
            repoPath: input.repoPath
          }
        })

      /**
       * Switch the repository's primary checkout to an existing local branch.
       *
       * Direct sessions deliberately use the checkout the developer already
       * owns: no fetch, task branch, or linked worktree is created here.
       */
      const switchBranch = (
        repoPath: string,
        branch: string
      ): Effect.Effect<string, GitError, CommandExecutor.CommandExecutor> =>
        runGit(repoPath, ["switch", branch]).pipe(Effect.as(branch))

      /**
       * Resolve aliases to one physical repository identity.
       *
       * `realPath` collapses symlinks, `..`, and filesystem case aliases while
       * Git's common directory collapses linked-worktree paths back to the same
       * repository. Direct-session exclusion is keyed by `commonDir`, not by
       * whichever spelling a caller happened to choose.
       */
      const repositoryIdentity = (
        repoPath: string
      ): Effect.Effect<
        RepositoryIdentity,
        GitError,
        FileSystem.FileSystem | Path.Path | CommandExecutor.CommandExecutor
      > =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const path = yield* Path.Path
          const canonicalRepo = yield* fs.realPath(repoPath).pipe(
            Effect.mapError(
              (cause) =>
                new GitError({
                  message: `Could not resolve repository path ${repoPath}`,
                  cause
                })
            )
          )
          const reported = yield* runGit(canonicalRepo, [
            "rev-parse",
            "--path-format=absolute",
            "--git-common-dir"
          ])
          const commonPath = path.isAbsolute(reported)
            ? reported
            : path.resolve(canonicalRepo, reported)
          const commonDir = yield* fs.realPath(commonPath).pipe(
            Effect.orElseSucceed(() => path.resolve(commonPath))
          )
          return { repoPath: canonicalRepo, commonDir }
        })

      /**
       * Keep commits made on a detached session reachable before its worktree is
       * removed. A detached HEAD already contained by any local or remote ref is
       * safe; otherwise create a collision-safe `jingler/<slug>` branch at HEAD.
       */
      const preserveDetachedHead = (
        cwd: string,
        slug: string
      ): Effect.Effect<string | null, GitError, CommandExecutor.CommandExecutor> =>
        Effect.gen(function* () {
          if ((yield* branchAt(cwd)) !== null) return null
          const containingRefs = yield* runString(
            "git",
            "-C",
            cwd,
            "for-each-ref",
            "--contains",
            "HEAD",
            "--format=%(refname)",
            "refs/heads",
            "refs/remotes"
          )
          if (containingRefs?.trim()) return null
          return yield* createTaskBranch(cwd, slug)
        })

      /**
       * Check out an existing local `branch` into the worktree at `cwd`, even
       * when that branch is already checked out in ANOTHER SESSION's worktree.
       * `--ignore-other-worktrees` bypasses git's safeguard so a PR whose branch
       * you already have checked out locally can still be opened as a session —
       * the two worktrees then share the branch ref.
       *
       * REFUSES when the holder is the repo's MAIN working tree. Sharing a ref
       * with the developer's own checkout is not a milder version of the same
       * trade-off, it is a different one: every commit the agent lands moves the
       * branch under the developer's feet, with no indication in either place
       * that it happened. The user-facing "share checked-out branches" lever
       * opts into sharing with other SESSIONS; it was never a request to have an
       * agent write into the checkout you are standing in.
       *
       * The caller (`createFromPr`) already treats a failure here as "this PR
       * cannot be opened as a session", which is the correct outcome — the fix
       * is to check the PR out in your main repo yourself, or move it off the
       * shared branch.
       */
      const checkoutBranch = (
        cwd: string,
        branch: string
      ): Effect.Effect<void, GitError, CommandExecutor.CommandExecutor> =>
        Effect.gen(function* () {
          const porcelain = yield* runString("git", "-C", cwd, "worktree", "list", "--porcelain")
          if (porcelain !== null && mainTreeHoldsBranch(porcelain, branch)) {
            return yield* Effect.fail(
              new GitError({
                message:
                  `Branch "${branch}" is checked out in this repo's main working tree. ` +
                  `Opening it as a session would share the branch ref, so the agent's ` +
                  `commits would move your own checkout. Switch your main checkout to ` +
                  `another branch first.`
              })
            )
          }
          yield* runGit(cwd, ["checkout", "--ignore-other-worktrees", branch])
        })

      /**
       * Remove the worktree at `worktreePath` (deleting a session). Resolves the
       * owning repo from the worktree list — `git worktree remove` must run from
       * the main working tree, not from inside the worktree being removed — then
       * `--force`s the removal. Best-effort: a missing/dirty worktree is ignored.
       */
      const removeWorktreeAt = (
        worktreePath: string,
        /**
         * The origin repo, when the caller knows it.
         *
         * Only needed for the case this function could not previously handle at
         * all: the worktree DIRECTORY is already gone (deleted by hand, or by a
         * cleanup that did not tell git). Locating the main tree normally means
         * asking git from inside the worktree, which a missing directory makes
         * impossible — so the old code silently did nothing and left the
         * registration behind forever.
         */
        repoPath?: string
      ): Effect.Effect<void, GitError, CommandExecutor.CommandExecutor> =>
        Effect.gen(function* () {
          // The first `worktree <path>` line of the porcelain list is the main tree.
          // Returns null when the directory is gone — git cannot run there.
          const listRaw = yield* runString(
            "git",
            "-C",
            worktreePath,
            "worktree",
            "list",
            "--porcelain"
          )
          const discovered = listRaw?.split("\n")[0]?.replace(/^worktree\s+/, "").trim() ?? null
          const mainPath = discovered !== worktreePath ? discovered : null
          if (mainPath) {
            yield* runGit(mainPath, ["worktree", "remove", "--force", worktreePath]).pipe(
              Effect.ignore
            )
          }
          // Prune ONLY when the directory was already gone.
          //
          // `worktree remove` handles the normal case completely, and prune is
          // not scoped to one worktree: it drops the registration of EVERY
          // worktree of the repo whose directory is not currently present. Run
          // unconditionally that reaches beyond this session — a developer's own
          // worktree of the same repo on an unmounted volume would be
          // unregistered by deleting an unrelated session, and orphaned when the
          // volume came back.
          //
          // When `mainPath` is null the directory is gone, `worktree remove`
          // cannot run at all, and prune is the only thing that clears the
          // registration. That is the case worth its blast radius, because a
          // vanished directory is exactly what prune is defined to collect.
          if (mainPath === null && repoPath) {
            yield* runGit(repoPath, ["worktree", "prune"]).pipe(Effect.ignore)
          }
        })

      /**
       * The commits landed at `cwd` since `sinceSha`, OLDEST FIRST, each with the
       * files it touched. Feeds `resolveFindings`, which credits the first commit
       * touching a finding's file with fixing it — so the order is contractual,
       * hence the explicit `--reverse`.
       *
       * Folds to `[]` rather than failing on ANY git error, and the common error
       * here is not exotic: `sinceSha` is the PR head the review ran against, and
       * a force-push or a fresh clone can leave that object absent from this
       * worktree. There is nothing to do about that but decline to attribute —
       * an unresolved finding is the safe direction, a crashed review pane is not.
       *
       * Parsing: `%H<US>%s` marks a commit header (US = 0x1f, which cannot appear
       * in a subject), and `--name-only` lists that commit's paths beneath it. A
       * merge commit lists no paths under this format and simply contributes
       * nothing, which is correct — a merge fixes nothing on its own.
       */
      const commitsSince = (
        cwd: string,
        sinceSha: string
      ): Effect.Effect<ReadonlyArray<ResolvingCommit>, never, CommandExecutor.CommandExecutor> =>
        runString(
          "git",
          "-C",
          cwd,
          "log",
          `${sinceSha}..HEAD`,
          "--reverse",
          "--name-only",
          "--pretty=format:%H\x1f%s"
        ).pipe(
          Effect.map((out) => {
            if (out === null) return []
            const commits: Array<{ sha: string; subject: string; files: Array<string> }> = []
            for (const line of out.split("\n")) {
              const sep = line.indexOf("\x1f")
              if (sep !== -1) {
                commits.push({
                  sha: line.slice(0, sep),
                  subject: line.slice(sep + 1).trim(),
                  files: []
                })
                continue
              }
              const path = line.trim()
              // A path before any header cannot be attributed to a commit; drop it
              // rather than guessing (this shouldn't happen, but the parse must not
              // reach into `commits[-1]`).
              if (path.length > 0 && commits.length > 0) commits[commits.length - 1]!.files.push(path)
            }
            return commits
          })
        )

      return {
        worktreePathFor,
        createWorktree,
        createDetachedWorktree,
        switchBranch,
        repositoryIdentity,
        branchAt,
        createTaskBranch,
        preserveDetachedHead,
        checkoutBranch,
        commitsSince,
        removeWorktreeAt
      }
    }
  }
) {}
