import type { Repo } from "@jingler/core"
import { GitError, WorkspaceNotConfiguredError } from "@jingler/core"
import { FileSystem, Path } from "@effect/platform"
import type { CommandExecutor } from "@effect/platform"
import { Effect, Option } from "effect"
import { AppPaths } from "./app-paths.js"
import { ConfigService } from "./config.js"
import { gitLine, runGit, runGitRaw, runGitWithEnv } from "./command.js"

/** How deep to descend from the repos directory before giving up on a branch. */
const MAX_DEPTH = 3

/** Directories never worth descending into while scanning for repos. */
const IGNORE = new Set([
  "node_modules",
  ".git",
  "dist",
  "out",
  ".turbo",
  "Library",
  ".Trash"
])

/** Parse "owner/repo" from a GitHub remote URL (ssh or https), else null. */
const parseGithubSlug = (url: string | null): string | null => {
  if (url === null) return null
  const match = url.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/i)
  return match?.[1] ?? null
}

/**
 * Keep only the hunks of a unified `diff` whose NEW-side line range overlaps
 * [startLine, endLine], reassembled with the file header so it stays a valid
 * patch. Returns null when the diff has no hunks, or none overlap. Pure — used
 * to reverse-apply just the selected lines when reverting a range.
 */
export const filterDiffHunks = (
  diff: string,
  startLine: number,
  endLine: number
): string | null => {
  const lines = diff.split("\n")
  const firstHunk = lines.findIndex((l) => l.startsWith("@@"))
  if (firstHunk === -1) return null
  const header = lines.slice(0, firstHunk)

  const hunks: Array<Array<string>> = []
  let current: Array<string> | null = null
  for (const line of lines.slice(firstHunk)) {
    if (line.startsWith("@@")) {
      if (current) hunks.push(current)
      current = [line]
    } else if (current) {
      current.push(line)
    }
  }
  if (current) hunks.push(current)

  const lo = Math.min(startLine, endLine)
  const hi = Math.max(startLine, endLine)
  const kept = hunks.filter((h) => {
    const m = h[0]!.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/)
    if (!m) return false
    const newStart = Number(m[1])
    const newCount = m[2] === undefined ? 1 : Number(m[2])
    // A zero-line hunk (pure deletion) still anchors at newStart.
    const newEnd = newStart + Math.max(newCount, 1) - 1
    return newStart <= hi && newEnd >= lo
  })
  if (kept.length === 0) return null
  return [...header, ...kept.flat()].join("\n") + "\n"
}

type ScanEnv = FileSystem.FileSystem | Path.Path

/** Bounded-recursive scan for git repos under `rootDir`; stops at the first `.git`. */
const scan = (
  rootDir: string
): Effect.Effect<ReadonlyArray<{ name: string; path: string }>, never, ScanEnv> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const found: Array<{ name: string; path: string }> = []

    const walk = (dir: string, depth: number): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (depth > MAX_DEPTH) return
        const isRepo = yield* fs
          .exists(path.join(dir, ".git"))
          .pipe(Effect.orElseSucceed(() => false))
        if (isRepo) {
          found.push({ name: path.basename(dir), path: dir })
          return
        }
        const entries = yield* fs
          .readDirectory(dir)
          .pipe(Effect.orElseSucceed(() => [] as Array<string>))
        yield* Effect.forEach(
          entries,
          (entry) =>
            Effect.gen(function* () {
              if (entry.startsWith(".") || IGNORE.has(entry)) return
              const child = path.join(dir, entry)
              const info = yield* fs.stat(child).pipe(Effect.option)
              if (Option.isSome(info) && info.value.type === "Directory") {
                yield* walk(child, depth + 1)
              }
            }),
          { concurrency: 8, discard: true }
        )
      })

    yield* walk(rootDir, 0)
    return found.sort((a, b) => a.name.localeCompare(b.name))
  })

/** Gather git metadata (branches, origin) for one discovered repo. */
const repoInfo = (
  entry: { name: string; path: string }
): Effect.Effect<Repo, never, CommandExecutor.CommandExecutor> =>
  Effect.gen(function* () {
    const currentBranch = yield* gitLine(entry.path, "rev-parse", "--abbrev-ref", "HEAD")
    const remoteUrl = yield* gitLine(entry.path, "remote", "get-url", "origin")
    const originHead = yield* gitLine(
      entry.path,
      "symbolic-ref",
      "--short",
      "refs/remotes/origin/HEAD"
    )
    const defaultBranch = originHead ? originHead.replace(/^origin\//, "") : currentBranch
    return {
      name: entry.name,
      path: entry.path,
      defaultBranch,
      currentBranch,
      remoteUrl,
      githubSlug: parseGithubSlug(remoteUrl)
    }
  })

export interface WorkspaceDiffStat {
  readonly added: number
  readonly removed: number
  readonly files: number
}

export type WorkspaceFileDiff =
  | { readonly kind: "patch"; readonly patch: string }
  | {
      readonly kind: "too-large"
      readonly added: number
      readonly removed: number
      readonly reason: "lines" | "bytes"
      readonly lineLimit: number
      readonly byteLimit: number
    }

export const FILE_DIFF_LINE_LIMIT = 20_000
export const FILE_DIFF_BYTE_LIMIT = 2 * 1024 * 1024
/**
 * Cap on the whole review patch. Every file is already bounded, but a session
 * with thousands of changed files must still never hand the renderer an
 * unbounded string: one 790k-line generated changeset took the renderer's V8
 * heap from 300MB to the 4GB limit in eight minutes.
 */
export const REVIEW_DIFF_BYTE_LIMIT = 24 * 1024 * 1024

/** One changed file in a review diff, counted by Git numstat. */
export interface WorkspaceReviewFile {
  readonly path: string
  readonly added: number
  readonly removed: number
  /** Why the file's patch is absent from `patch`; null when it is included. */
  readonly omitted: null | "lines" | "bytes"
}

/**
 * The Code Review pane's worktree diff: every changed file with its counts,
 * plus a unified patch that contains ONLY the files small enough to render.
 */
export interface WorkspaceReviewDiff {
  readonly files: ReadonlyArray<WorkspaceReviewFile>
  readonly patch: string
  readonly lineLimit: number
  readonly byteLimit: number
}

export const EMPTY_REVIEW_DIFF: WorkspaceReviewDiff = {
  files: [],
  patch: "",
  lineLimit: FILE_DIFF_LINE_LIMIT,
  byteLimit: FILE_DIFF_BYTE_LIMIT
}

const NUMSTAT_ENTRY = /^(\d+|-)\t(\d+|-)\t/
const NUMSTAT_FILE_ENTRY = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/
/** Lookahead, not a match: splitting on it keeps each `diff --git` header with its block. */
const PATCH_BLOCK_BOUNDARY = /^(?=diff --git )/m

interface NumstatFile {
  readonly path: string
  /** The source path of a rename, for pathspecs that must name both sides. */
  readonly oldPath: string | null
  readonly added: number
  readonly removed: number
}

/**
 * Parse `git diff --numstat -z`. Entries are `added\tremoved\tpath\0`; a
 * rename leaves the path empty and follows with `old\0new\0`. Binary files
 * count `-\t-` and contribute zero lines.
 */
const numstatFiles = (output: string): ReadonlyArray<NumstatFile> => {
  const tokens = output.split("\0")
  const files: Array<NumstatFile> = []
  for (let index = 0; index < tokens.length; index++) {
    const match = NUMSTAT_FILE_ENTRY.exec(tokens[index] ?? "")
    if (match === null) continue
    let path = match[3] ?? ""
    let oldPath: string | null = null
    if (path === "") {
      oldPath = tokens[++index] ?? ""
      path = tokens[++index] ?? ""
    }
    files.push({
      path,
      oldPath,
      added: match[1] === "-" ? 0 : Number(match[1]),
      removed: match[2] === "-" ? 0 : Number(match[2])
    })
  }
  return files
}

/** Split a unified patch into its per-file `diff --git` blocks, in order. */
const patchBlocks = (patch: string): ReadonlyArray<string> =>
  patch.split(PATCH_BLOCK_BOUNDARY).filter((block) => block.length > 0)

/**
 * Bound a review patch after the per-file line gate: a block above the byte
 * limit, or one that would push the whole patch past the review cap, is
 * dropped and its file marked omitted. Blocks and `included` are both in Git's
 * path order, so they align one-to-one; if they somehow do not, the patch is
 * returned untouched rather than mislabelled.
 */
const boundReviewPatch = (
  patch: string,
  included: ReadonlyArray<WorkspaceReviewFile>
): { readonly patch: string; readonly omittedPaths: ReadonlySet<string> } => {
  const blocks = patchBlocks(patch)
  if (blocks.length !== included.length) return { patch, omittedPaths: new Set() }
  const kept: Array<string> = []
  const omittedPaths = new Set<string>()
  let total = 0
  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index]!
    const file = included[index]!
    if (block.length > FILE_DIFF_BYTE_LIMIT || total + block.length > REVIEW_DIFF_BYTE_LIMIT) {
      omittedPaths.add(file.path)
      continue
    }
    total += block.length
    kept.push(block)
  }
  return { patch: kept.join(""), omittedPaths }
}

const reviewDiffFromIndex = (
  worktreePath: string,
  environment: Readonly<Record<string, string>>
) =>
  Effect.gen(function* () {
    const counted = yield* runGitWithEnv(
      worktreePath,
      ["diff", "--cached", "--find-renames", "--numstat", "-z", "HEAD"],
      environment
    ).pipe(Effect.map(numstatFiles))
    if (counted.length === 0) return EMPTY_REVIEW_DIFF
    const files: ReadonlyArray<WorkspaceReviewFile & { readonly oldPath: string | null }> =
      counted.map((file) => ({
        path: file.path,
        oldPath: file.oldPath,
        added: file.added,
        removed: file.removed,
        omitted: file.added + file.removed > FILE_DIFF_LINE_LIMIT ? "lines" : null
      }))
    const included = files.filter((file) => file.omitted === null)
    if (included.length === 0) {
      return { ...EMPTY_REVIEW_DIFF, files: files.map(({ oldPath: _, ...file }) => file) }
    }
    // Pathspecs only when something is excluded: the common all-small case
    // must not depend on argument-list limits for a repository with thousands
    // of changed files.
    const raw = yield* runGitWithEnv(
      worktreePath,
      included.length === files.length
        ? ["diff", "--cached", "--find-renames", "HEAD"]
        : [
            "--literal-pathspecs",
            "diff",
            "--cached",
            "--find-renames",
            "HEAD",
            "--",
            ...included.flatMap((file) =>
              file.oldPath === null ? [file.path] : [file.oldPath, file.path]
            )
          ],
      environment
    )
    const bounded = boundReviewPatch(raw, included)
    return {
      files: files.map(({ oldPath: _, ...file }) =>
        bounded.omittedPaths.has(file.path) ? { ...file, omitted: "bytes" as const } : file
      ),
      patch: bounded.patch,
      lineLimit: FILE_DIFF_LINE_LIMIT,
      byteLimit: FILE_DIFF_BYTE_LIMIT
    }
  })

const numstat = (output: string): WorkspaceDiffStat => {
  let added = 0
  let removed = 0
  let files = 0
  for (const entry of output.split("\0")) {
    const match = NUMSTAT_ENTRY.exec(entry)
    if (match === null) continue
    added += match[1] === "-" ? 0 : Number(match[1])
    removed += match[2] === "-" ? 0 : Number(match[2])
    files++
  }
  return { added, removed, files }
}

const diffPaths = (nameStatus: string, wanted: string): readonly string[] => {
  const fields = nameStatus.split("\0")
  for (let index = 0; index < fields.length - 1;) {
    const status = fields[index++] ?? ""
    const first = fields[index++] ?? ""
    if (!status.startsWith("R") && !status.startsWith("C")) {
      if (first === wanted) return [wanted]
      continue
    }
    const second = fields[index++] ?? ""
    if (first === wanted || second === wanted) return [first, second]
  }
  return [wanted]
}

const gitObjectSize = (
  worktreePath: string,
  object: string,
  environment: Readonly<Record<string, string>>
) =>
  runGitWithEnv(worktreePath, ["cat-file", "-s", object], environment).pipe(
    Effect.map((output) => Number(output.trim()) || 0),
    Effect.orElseSucceed(() => 0)
  )

const withStagedWorktree = <A, E, R>(
  worktreePath: string,
  stagedPaths: readonly string[] | null,
  use: (environment: Readonly<Record<string, string>>) => Effect.Effect<A, E, R>
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const directory = yield* fs.makeTempDirectoryScoped().pipe(
        Effect.mapError(
          (cause) => new GitError({ message: "Failed to create isolated Git index", cause })
        )
      )
      const objectDirectory = path.join(directory, "objects")
      yield* fs.makeDirectory(objectDirectory).pipe(
        Effect.mapError(
          (cause) => new GitError({ message: "Failed to create isolated Git object store", cause })
        )
      )
      const repositoryObjects = yield* runGit(worktreePath, [
        "rev-parse",
        "--git-path",
        "objects"
      ]).pipe(Effect.map((output) => path.resolve(worktreePath, output.trim())))
      const environment = {
        GIT_INDEX_FILE: path.join(directory, "index"),
        GIT_OBJECT_DIRECTORY: objectDirectory,
        GIT_ALTERNATE_OBJECT_DIRECTORIES: repositoryObjects
      }
      yield* runGitWithEnv(worktreePath, ["read-tree", "HEAD"], environment)
      yield* runGitWithEnv(
        worktreePath,
        ["--literal-pathspecs", "add", "-A", "--", ...(stagedPaths ?? ["."])],
        environment
      )
      return yield* use(environment)
    })
  )

const stagedWorktreeGit = (worktreePath: string, args: readonly string[]) =>
  withStagedWorktree(worktreePath, null, (environment) =>
    runGitWithEnv(worktreePath, [...args], environment)
  )

const stagedPathsForFile = (worktreePath: string, path: string) =>
  runGitRaw(worktreePath, ["diff", "--name-only", "--diff-filter=D", "-z", "HEAD"]).pipe(
    Effect.map((output) => [
      path,
      ...output.split("\0").filter((candidate) => candidate.length > 0)
    ])
  )

const boundedFileDiffFromIndex = (
  worktreePath: string,
  path: string,
  environment: Readonly<Record<string, string>>
) =>
  Effect.gen(function* () {
    const nameStatus = yield* runGitWithEnv(
      worktreePath,
      ["diff", "--cached", "--find-renames", "--name-status", "-z", "HEAD"],
      environment
    )
    const paths = diffPaths(nameStatus, path)
    const stat = yield* runGitWithEnv(
      worktreePath,
      [
        "--literal-pathspecs",
        "diff",
        "--cached",
        "--find-renames",
        "--numstat",
        "-z",
        "HEAD",
        "--",
        ...paths
      ],
      environment
    ).pipe(Effect.map(numstat))
    if (stat.files === 0) return { kind: "patch" as const, patch: "" }
    if (stat.added + stat.removed > FILE_DIFF_LINE_LIMIT) {
      return {
        kind: "too-large" as const,
        added: stat.added,
        removed: stat.removed,
        reason: "lines" as const,
        lineLimit: FILE_DIFF_LINE_LIMIT,
        byteLimit: FILE_DIFF_BYTE_LIMIT
      }
    }
    const [beforeBytes, afterBytes] = yield* Effect.all([
      gitObjectSize(worktreePath, `HEAD:${paths[0]}`, environment),
      gitObjectSize(worktreePath, `:${paths.at(-1)}`, environment)
    ])
    if (beforeBytes + afterBytes > FILE_DIFF_BYTE_LIMIT) {
      return {
        kind: "too-large" as const,
        added: stat.added,
        removed: stat.removed,
        reason: "bytes" as const,
        lineLimit: FILE_DIFF_LINE_LIMIT,
        byteLimit: FILE_DIFF_BYTE_LIMIT
      }
    }
    const patch = yield* runGitWithEnv(
      worktreePath,
      ["--literal-pathspecs", "diff", "--cached", "--find-renames", "HEAD", "--", ...paths],
      environment
    )
    return patch.length > FILE_DIFF_BYTE_LIMIT
      ? {
          kind: "too-large" as const,
          added: stat.added,
          removed: stat.removed,
          reason: "bytes" as const,
          lineLimit: FILE_DIFF_LINE_LIMIT,
          byteLimit: FILE_DIFF_BYTE_LIMIT
        }
      : { kind: "patch" as const, patch }
  })

type WorkspaceEnv =
  | ConfigService
  | FileSystem.FileSystem
  | Path.Path
  | CommandExecutor.CommandExecutor
  | AppPaths

/**
 * Discovers git repos under the configured repos directory and lists branches.
 * A malformed or absent config surfaces as `WorkspaceNotConfiguredError`, which
 * the renderer treats as "run first-run setup".
 */
export class WorkspaceService extends Effect.Service<WorkspaceService>()(
  "@jingler/WorkspaceService",
  {
    accessors: true,
    sync: () => ({
      listRepos: (): Effect.Effect<
        ReadonlyArray<Repo>,
        WorkspaceNotConfiguredError,
        WorkspaceEnv
      > =>
        Effect.gen(function* () {
          const config = yield* ConfigService.get().pipe(
            Effect.catchTag("ConfigError", () => Effect.succeed(null))
          )
          if (config === null || config.reposDir === null) {
            return yield* Effect.fail(new WorkspaceNotConfiguredError())
          }
          const entries = yield* scan(config.reposDir)
          return yield* Effect.forEach(entries, repoInfo, { concurrency: 8 })
        }),

      branches: (
        repoPath: string
      ): Effect.Effect<ReadonlyArray<string>, GitError, CommandExecutor.CommandExecutor> =>
        runGit(repoPath, ["branch", "--format=%(refname:short)"]).pipe(
          Effect.map((out) =>
            out
              .split("\n")
              .map((line) => line.trim())
              .filter((line) => line.length > 0)
          )
        ),

      /**
       * Every file in a repo worth referencing — for the `@` code-reference menu
       * and for deciding whether a path in agent output is worth linking.
       *
       * Tracked files AND untracked-but-not-ignored ones. `git ls-files` alone
       * lists only what git already knows about, which excludes precisely the
       * files the agent just wrote: a file created this turn is untracked until
       * something commits it, so the two features this feeds would both go blind
       * on their most important case. `--exclude-standard` keeps `.gitignore`
       * honoured, so `node_modules` and build output stay out.
       *
       * The two lists are concatenated rather than merged with a Set: `ls-files`
       * and `ls-files --others` are disjoint by definition (a path is tracked or
       * it is not), so deduplicating would only cost a pass over every path in
       * the repo.
       */
      files: (
        repoPath: string
      ): Effect.Effect<ReadonlyArray<string>, GitError, CommandExecutor.CommandExecutor> =>
        Effect.gen(function* () {
          const lines = (out: string): ReadonlyArray<string> =>
            out
              .split("\n")
              .map((line) => line.trim())
              .filter((line) => line.length > 0)
          const tracked = yield* runGit(repoPath, ["ls-files"])
          // Untracked is best-effort: a repo where this fails should still offer
          // its tracked files rather than none at all.
          const untracked = yield* runGit(repoPath, [
            "ls-files",
            "--others",
            "--exclude-standard"
          ]).pipe(Effect.orElseSucceed(() => ""))
          return [...lines(tracked), ...lines(untracked)]
        }),

      /**
       * The Code Review pane's working diff for a worktree, including untracked
       * files, bounded per file and overall (`WorkspaceReviewDiff`).
       *
       * Git only detects a move when both sides are in the same index, but the
       * destination of an ordinary filesystem move is untracked. Build a
       * disposable index from HEAD, add the worktree to that isolated index,
       * then diff it. This lets Git correlate renames while never reading from
       * or writing to the developer's real staging area.
       *
       * Numstat runs first so a generated file with hundreds of thousands of
       * changed lines is listed with its counts but never materialized, never
       * crosses IPC, and never reaches the renderer's diff parser.
       */
      diff: (
        worktreePath: string
      ): Effect.Effect<
        WorkspaceReviewDiff,
        GitError,
        FileSystem.FileSystem | Path.Path | CommandExecutor.CommandExecutor
      > =>
        withStagedWorktree(worktreePath, null, (environment) =>
          reviewDiffFromIndex(worktreePath, environment)
        ),

      /** Count a worktree diff without materializing or transporting its patch. */
      diffStat: (
        worktreePath: string
      ): Effect.Effect<
        WorkspaceDiffStat,
        GitError,
        FileSystem.FileSystem | Path.Path | CommandExecutor.CommandExecutor
      > => stagedWorktreeGit(
        worktreePath,
        ["diff", "--cached", "--find-renames", "--numstat", "-z", "HEAD"]
      ).pipe(Effect.map(numstat)),

      /**
       * Load one selected file's patch. Numstat is checked first so a generated
       * file with hundreds of thousands of changed lines never enters the diff
       * parser or crosses IPC.
       */
      boundedFileDiff: (
        worktreePath: string,
        path: string
      ): Effect.Effect<
        WorkspaceFileDiff,
        GitError,
        FileSystem.FileSystem | Path.Path | CommandExecutor.CommandExecutor
      > =>
        Effect.flatMap(stagedPathsForFile(worktreePath, path), (stagedPaths) =>
          withStagedWorktree(worktreePath, stagedPaths, (environment) =>
            boundedFileDiffFromIndex(worktreePath, path, environment)
          )
        ),

      /** The uncommitted working diff for one file (`git diff HEAD -- <path>`). */
      fileDiff: (
        worktreePath: string,
        path: string
      ): Effect.Effect<string, GitError, CommandExecutor.CommandExecutor> =>
        runGit(worktreePath, ["--literal-pathspecs", "diff", "HEAD", "--", path]),

      /** Discard ALL uncommitted changes to one file (`git checkout HEAD -- <path>`). */
      revertFile: (
        worktreePath: string,
        path: string
      ): Effect.Effect<void, GitError, CommandExecutor.CommandExecutor> =>
        runGit(worktreePath, ["--literal-pathspecs", "checkout", "HEAD", "--", path]).pipe(Effect.asVoid),

      /**
       * Revert just the uncommitted changes in a NEW-file line range: take the
       * file's working diff, keep the hunks overlapping [startLine, endLine], and
       * reverse-apply them to the worktree (`git apply -R`). A no-op when nothing
       * in that range changed. Reverting whole overlapping hunks keeps the patch
       * valid — sub-hunk splitting would corrupt context.
       */
      revertRange: (
        worktreePath: string,
        path: string,
        startLine: number,
        endLine: number
      ): Effect.Effect<void, GitError, FileSystem.FileSystem | CommandExecutor.CommandExecutor> =>
        Effect.gen(function* () {
          const full = yield* runGit(worktreePath, ["--literal-pathspecs", "diff", "HEAD", "--", path])
          const patch = filterDiffHunks(full, startLine, endLine)
          if (patch === null) return
          const fs = yield* FileSystem.FileSystem
          const tmp = yield* fs
            .makeTempFile()
            .pipe(Effect.mapError((cause) => new GitError({ message: "Failed to stage revert patch", cause })))
          yield* fs
            .writeFileString(tmp, patch)
            .pipe(Effect.mapError((cause) => new GitError({ message: "Failed to write revert patch", cause })))
          yield* runGit(worktreePath, ["apply", "-R", tmp]).pipe(
            Effect.ensuring(fs.remove(tmp).pipe(Effect.ignore))
          )
        })
    })
  }
) {}
