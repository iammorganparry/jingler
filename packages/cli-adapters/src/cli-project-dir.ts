import { homedir } from "node:os"
import { join } from "node:path"
import { FileSystem } from "@effect/platform"
import { Effect } from "effect"

/**
 * The agent CLIs' own conversation stores, and keeping them attached to a
 * session whose directory has moved.
 *
 * Claude Code does not store a conversation next to the code it is about. It
 * files every transcript under `~/.claude/projects/<slug>`, where the slug is
 * derived from the ABSOLUTE working directory the session ran in. Move that
 * directory — rename the repo, rename `~/jingler`, relocate a worktree — and
 * the CLI computes a different slug, finds nothing, and `--resume` fails with
 * "No conversation found with session ID".
 *
 * That store sits outside both the repo and `~/jingler`, so neither
 * `git worktree repair` nor anything Jingler owns reaches it. It has to be
 * migrated explicitly, which is what this module is for.
 */

/** Where Claude Code keeps its per-directory conversation store. */
export const defaultCliProjectsDir = (): string => join(homedir(), ".claude", "projects")

/**
 * The directory name Claude Code derives from an absolute path.
 *
 * Every character outside `[A-Za-z0-9-]` becomes a dash, and case is preserved.
 * Verified against 169 real directories on a live machine: `/` and `.` and a
 * literal space all collapse to a dash, which is why `/Users/me/.config`
 * becomes `-Users-me--config` (the slash AND the dot each contribute one).
 *
 * This mirrors a rule Jingler does not own. If Claude Code changes it, the
 * worst case is that a migration finds nothing and does nothing — the failure
 * mode is the status quo, not corruption.
 */
export const cliProjectSlug = (absolutePath: string): string =>
  absolutePath.replace(/[^A-Za-z0-9-]/g, "-")

/**
 * Re-file a session's CLI transcripts after its working directory moved.
 *
 * Best-effort by construction: every failure leaves the old directory exactly
 * where it was, because a missing transcript degrades to "this session starts a
 * fresh conversation" while a half-moved one loses history outright.
 *
 * Returns whether anything was moved, which is what makes this testable — the
 * effect itself never fails.
 *
 * The merge case is real rather than theoretical: rename a directory to a name
 * some earlier session already used and both slugs exist. Files present at the
 * destination always win, so a merge can add history but never overwrite it.
 */
export const migrateCliProjectDir = (
  oldWorktreePath: string,
  newWorktreePath: string,
  projectsDir: string = defaultCliProjectsDir()
): Effect.Effect<boolean, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    if (oldWorktreePath === newWorktreePath) return false
    if (oldWorktreePath.length === 0 || newWorktreePath.length === 0) return false

    const fs = yield* FileSystem.FileSystem
    const from = join(projectsDir, cliProjectSlug(oldWorktreePath))
    const to = join(projectsDir, cliProjectSlug(newWorktreePath))
    if (from === to) return false

    const fromExists = yield* fs.exists(from).pipe(Effect.orElseSucceed(() => false))
    if (!fromExists) return false

    const toExists = yield* fs.exists(to).pipe(Effect.orElseSucceed(() => false))
    if (!toExists) {
      // The common case: a plain rename, which also carries the `subagents/`
      // subtrees without having to know they exist.
      const renamed = yield* fs
        .rename(from, to)
        .pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false)
        )
      return renamed
    }

    // Destination already has history of its own. Move across only what is not
    // already there, and leave the source in place if anything remains.
    const entries = yield* fs.readDirectory(from).pipe(Effect.orElseSucceed(() => [] as Array<string>))
    let moved = false
    for (const entry of entries) {
      const target = join(to, entry)
      const occupied = yield* fs.exists(target).pipe(Effect.orElseSucceed(() => false))
      if (occupied) continue
      const ok = yield* fs
        .rename(join(from, entry), target)
        .pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false)
        )
      moved = moved || ok
    }
    // `remove` without `recursive` fails on a non-empty directory, which is
    // exactly the guard wanted: anything left behind was a collision we chose
    // not to clobber, and deleting it would discard the history we preserved.
    yield* fs.remove(from).pipe(Effect.ignore)
    return moved
  })

/**
 * The worktree path a session should actually be using, migrating its CLI
 * transcripts if that turns out not to be the one on record.
 *
 * `Session.worktreePath` is stored ABSOLUTE and nothing rewrites it, so it goes
 * stale the moment `~/jingler` or the repo directory is renamed — the rename
 * that shipped this app's own name change moved the home directory and carried
 * no migration at all.
 *
 * Recovery works because the stale value still names the worktree's own
 * directory, and `worktreesDir`/`repo` are both live: `repo` is re-derived from
 * `repoPath` on every read (see `migrateRepoName`), so the expected location is
 * computable even when both the home directory AND the repo were renamed.
 *
 * A stored path that still exists is returned untouched after a single `stat` —
 * the overwhelmingly common case. A stale path whose expected location does NOT
 * exist is also returned untouched: that worktree is genuinely missing rather
 * than moved, and inventing a path would turn a clear failure into a confusing
 * one.
 */
export const healedWorktreePath = (
  storedWorktreePath: string,
  repo: string,
  worktreesDir: string,
  projectsDir: string = defaultCliProjectsDir()
): Effect.Effect<string, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    if (storedWorktreePath.length === 0 || repo.length === 0) return storedWorktreePath
    const fs = yield* FileSystem.FileSystem

    const stillThere = yield* fs.exists(storedWorktreePath).pipe(Effect.orElseSucceed(() => false))
    if (stillThere) return storedWorktreePath

    // The worktree's own directory name is the one part a rename never touches:
    // it is the session's slug, and it lives BELOW the renamed segments.
    const slug = storedWorktreePath.split("/").filter((s) => s.length > 0).pop() ?? ""
    if (slug.length === 0) return storedWorktreePath

    const expected = join(worktreesDir, repo, slug)
    if (expected === storedWorktreePath) return storedWorktreePath
    const moved = yield* fs.exists(expected).pipe(Effect.orElseSucceed(() => false))
    if (!moved) return storedWorktreePath

    yield* migrateCliProjectDir(storedWorktreePath, expected, projectsDir)
    return expected
  })
