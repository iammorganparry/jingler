import { CommandExecutor, FileSystem, Path } from "@effect/platform"
import { Effect } from "effect"
import { AppPaths } from "../../app-paths.js"
import { runGit } from "../../command.js"
import { GitService } from "../../git.js"
import type { CreateChildWorktree } from "../agent/native-subagent-tool.js"

type Paths = typeof AppPaths.Service

/**
 * Isolated child checkout: reuses GitService.createDetachedWorktree (managed
 * worktrees root), pinned to the parent's HEAD sha, then names branch jingler/sub/<childId>.
 */
export const createChildWorktree = (
  paths: Paths,
  fs: FileSystem.FileSystem,
  path: Path.Path,
  executor: CommandExecutor.CommandExecutor
): CreateChildWorktree => (parentCwd, childId) =>
  Effect.runPromise(Effect.gen(function* () {
    const repoPath = yield* runGit(parentCwd, ["rev-parse", "--show-toplevel"])
    const head = yield* runGit(repoPath, ["rev-parse", "HEAD"])
    const worktree = yield* GitService.createDetachedWorktree({
      repoPath, repoName: path.basename(repoPath), slug: `sub-${childId}`, baseBranch: head
    })
    yield* runGit(worktree.path, ["switch", "-c", `jingler/sub/${childId}`])
    return worktree.path
  }).pipe(
    Effect.provide(GitService.Default),
    Effect.provideService(AppPaths, paths),
    Effect.provideService(FileSystem.FileSystem, fs),
    Effect.provideService(Path.Path, path),
    Effect.provideService(CommandExecutor.CommandExecutor, executor)
  ))
