import { join } from "node:path"
import { FileSystem } from "@effect/platform"
import { Effect } from "effect"

/** Recover a renamed session worktree without inventing a path for a deleted one. */
export const healedWorktreePath = (
  storedWorktreePath: string,
  repo: string,
  worktreesDir: string
): Effect.Effect<string, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    if (storedWorktreePath.length === 0 || repo.length === 0) return storedWorktreePath
    const fs = yield* FileSystem.FileSystem
    if (yield* fs.exists(storedWorktreePath).pipe(Effect.orElseSucceed(() => false))) {
      return storedWorktreePath
    }

    const slug = storedWorktreePath.split("/").filter(Boolean).at(-1)
    if (slug === undefined) return storedWorktreePath

    const expected = join(worktreesDir, repo, slug)
    if (expected === storedWorktreePath) return storedWorktreePath
    return (yield* fs.exists(expected).pipe(Effect.orElseSucceed(() => false)))
      ? expected
      : storedWorktreePath
  })
