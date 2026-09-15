import { execFileSync } from "node:child_process"
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { NodeContext } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { AppPaths } from "./app-paths.js"
import { ConfigService } from "./config.js"
import {
  FILE_DIFF_BYTE_LIMIT,
  FILE_DIFF_LINE_LIMIT,
  WorkspaceService,
  filterDiffHunks
} from "./workspace.js"
import { failureOf, initGitRepo, mkTemp, runExit, withTempRoot } from "./test-support.js"

/**
 * WorkspaceService scans a real directory of real git repos. We assert what the
 * sidebar would show — which repos are found, their order, branch, and derived
 * GitHub slug — plus the unconfigured failure. The scan's depth/ignore rules are
 * observed through their outcome (a nested repo isn't double-listed), not probed.
 */
describe("WorkspaceService", () => {
  let temp: ReturnType<typeof withTempRoot>
  let repos: ReturnType<typeof mkTemp>
  beforeEach(() => {
    temp = withTempRoot()
    repos = mkTemp("jingler-repos-")
  })
  afterEach(() => {
    temp.cleanup()
    repos.cleanup()
  })

  const services = Layer.mergeAll(WorkspaceService.Default, ConfigService.Default)

  const configureAnd = <A, E>(
    effect: Effect.Effect<
      A,
      E,
      WorkspaceService | ConfigService | AppPaths | NodeContext.NodeContext
    >
  ) =>
    runExit(
      Effect.gen(function* () {
        yield* ConfigService.setReposDir(repos.dir)
        return yield* effect
      }).pipe(Effect.provide(services)),
      temp.layer
    )

  it("fails with WorkspaceNotConfiguredError before setup", async () => {
    const exit = await runExit(
      WorkspaceService.listRepos().pipe(Effect.provide(services)),
      temp.layer
    )
    expect(exit._tag).toBe("Failure")
    expect(failureOf(exit)?._tag).toBe("WorkspaceNotConfiguredError")
  })

  it("lists discovered repos sorted by name, with branch + github slug", async () => {
    initGitRepo(join(repos.dir, "widget"), {
      remote: "git@github.com:acme/widget.git",
      initialBranch: "main"
    })
    initGitRepo(join(repos.dir, "athena"), { initialBranch: "develop" })

    const exit = await configureAnd(WorkspaceService.listRepos())
    expect(exit._tag).toBe("Success")
    if (exit._tag !== "Success") return

    expect(exit.value.map((r) => r.name)).toStrictEqual(["athena", "widget"])
    const widget = exit.value.find((r) => r.name === "widget")!
    expect(widget.currentBranch).toBe("main")
    expect(widget.githubSlug).toBe("acme/widget")
    const athena = exit.value.find((r) => r.name === "athena")!
    expect(athena.currentBranch).toBe("develop")
    expect(athena.githubSlug).toBeNull()
  })

  it("stops at the first .git — a repo nested inside a repo is not double-listed", async () => {
    const outer = initGitRepo(join(repos.dir, "outer"), { initialBranch: "main" })
    // A nested git repo under the outer repo must NOT appear as its own entry.
    initGitRepo(join(outer, "packages", "inner"), { initialBranch: "main" })

    const exit = await configureAnd(WorkspaceService.listRepos())
    expect(exit._tag).toBe("Success")
    if (exit._tag === "Success") {
      expect(exit.value.map((r) => r.name)).toStrictEqual(["outer"])
    }
  })

  it("ignores non-repo clutter like node_modules", async () => {
    initGitRepo(join(repos.dir, "app"), { initialBranch: "main" })
    mkdirSync(join(repos.dir, "node_modules", "some-pkg"), { recursive: true })

    const exit = await configureAnd(WorkspaceService.listRepos())
    expect(exit._tag).toBe("Success")
    if (exit._tag === "Success") expect(exit.value.map((r) => r.name)).toStrictEqual(["app"])
  })

  it("branches() returns the repo's branch names", async () => {
    const repoPath = initGitRepo(join(repos.dir, "multi"), {
      initialBranch: "main",
      branches: ["develop", "feat/scoring"]
    })
    const exit = await runExit(
      WorkspaceService.branches(repoPath).pipe(Effect.provide(services)),
      temp.layer
    )
    expect(exit._tag).toBe("Success")
    if (exit._tag === "Success") {
      expect([...exit.value].sort()).toStrictEqual(["develop", "feat/scoring", "main"])
    }
  })

  it("files() includes an UNTRACKED file — the one the agent just wrote", async () => {
    // The case the whole thing exists for. A file created this turn is untracked
    // until something commits it, so a tracked-only list is blind to precisely
    // the file the operator wants to open. `.gitignore`d paths still stay out.
    const repoPath = initGitRepo(join(repos.dir, "untracked"))
    writeFileSync(join(repoPath, ".gitignore"), "node_modules/\nbuild.log\n")
    execFileSync("git", ["add", "-A"], { cwd: repoPath })
    execFileSync("git", ["commit", "-m", "ignore", "--no-gpg-sign"], { cwd: repoPath })
    writeFileSync(join(repoPath, "spec.md"), "# just written\n")
    writeFileSync(join(repoPath, "build.log"), "noise\n")
    const exit = await runExit(
      WorkspaceService.files(repoPath).pipe(Effect.provide(services)),
      temp.layer
    )
    expect(exit._tag).toBe("Success")
    if (exit._tag === "Success") {
      expect([...exit.value].sort()).toStrictEqual([".gitignore", "README.md", "spec.md"])
    }
  })

  it("files() lists each path once — tracked and untracked are disjoint", async () => {
    const repoPath = initGitRepo(join(repos.dir, "disjoint"))
    writeFileSync(join(repoPath, "README.md"), "# edited but still tracked\n")
    const exit = await runExit(
      WorkspaceService.files(repoPath).pipe(Effect.provide(services)),
      temp.layer
    )
    expect(exit._tag).toBe("Success")
    if (exit._tag === "Success") {
      // A MODIFIED tracked file must not also show up as "other".
      expect([...exit.value]).toStrictEqual(["README.md"])
    }
  })

  it("files() lists the repo's tracked files (for the @ menu)", async () => {
    const repoPath = initGitRepo(join(repos.dir, "tracked"))
    writeFileSync(join(repoPath, "src.ts"), "export const x = 1\n")
    execFileSync("git", ["add", "-A"], { cwd: repoPath })
    execFileSync("git", ["commit", "-m", "add src", "--no-gpg-sign"], { cwd: repoPath })
    const exit = await runExit(
      WorkspaceService.files(repoPath).pipe(Effect.provide(services)),
      temp.layer
    )
    expect(exit._tag).toBe("Success")
    if (exit._tag === "Success") {
      expect([...exit.value].sort()).toStrictEqual(["README.md", "src.ts"])
    }
  })

  it("diff() returns the worktree's unified diff of an uncommitted change", async () => {
    const repoPath = initGitRepo(join(repos.dir, "dirty"))
    writeFileSync(join(repoPath, "README.md"), "# dirty repo\nchanged line\n")
    const exit = await runExit(
      WorkspaceService.diff(repoPath).pipe(Effect.provide(services)),
      temp.layer
    )
    expect(exit._tag).toBe("Success")
    if (exit._tag === "Success") {
      expect(exit.value).toContain("+changed line")
      expect(exit.value).toContain("README.md")
    }
  })

  it("diff() includes NEW (untracked) and DELETED files, not just modified ones", async () => {
    const repoPath = initGitRepo(join(repos.dir, "netchanges"))
    // A brand-new untracked file, and a deletion of a tracked one (README exists
    // from initGitRepo's initial commit).
    writeFileSync(join(repoPath, "brand-new.ts"), "export const hi = 1\n")
    rmSync(join(repoPath, "README.md"))
    const exit = await runExit(
      WorkspaceService.diff(repoPath).pipe(Effect.provide(services)),
      temp.layer
    )
    expect(exit._tag).toBe("Success")
    if (exit._tag !== "Success") return
    // New file shows as an addition…
    expect(exit.value).toContain("brand-new.ts")
    expect(exit.value).toContain("+export const hi = 1")
    // …and the deletion shows too.
    expect(exit.value).toContain("README.md")
    expect(exit.value).toContain("deleted file")
    // The untracked file is left UNtracked afterwards (intent-to-add was reset).
    const stillUntracked = execFileSync("git", ["status", "--porcelain", "--", "brand-new.ts"], {
      cwd: repoPath,
      encoding: "utf-8"
    })
    expect(stillUntracked.startsWith("??")).toBe(true)
  })

  it("diff() reports a moved file as one rename even when repository config disables detection", async () => {
    const repoPath = initGitRepo(join(repos.dir, "renamed"))
    mkdirSync(join(repoPath, "docs"), { recursive: true })
    execFileSync("git", ["config", "diff.renames", "false"], { cwd: repoPath })
    renameSync(join(repoPath, "README.md"), join(repoPath, "docs", "README.md"))

    const exit = await runExit(
      WorkspaceService.diff(repoPath).pipe(Effect.provide(services)),
      temp.layer
    )

    expect(exit._tag).toBe("Success")
    if (exit._tag !== "Success") return
    expect(exit.value).toContain("rename from README.md")
    expect(exit.value).toContain("rename to docs/README.md")
    expect(exit.value).not.toContain("deleted file mode")
    expect(exit.value).not.toContain("new file mode")

    const selected = await runExit(
      WorkspaceService.boundedFileDiff(repoPath, "docs/README.md").pipe(
        Effect.provide(services)
      ),
      temp.layer
    )
    expect(selected._tag).toBe("Success")
    if (selected._tag === "Success" && selected.value.kind === "patch") {
      expect(selected.value.patch).toContain("rename from README.md")
      expect(selected.value.patch).toContain("rename to docs/README.md")
    }
    expect(
      execFileSync("git", ["status", "--porcelain=v1"], {
        cwd: repoPath,
        encoding: "utf-8"
      })
    ).toContain("?? docs/")
  })

  it("diff() never mutates the developer's staged index", async () => {
    const repoPath = initGitRepo(join(repos.dir, "staged-index"))
    writeFileSync(join(repoPath, "README.md"), "staged developer edit\n")
    execFileSync("git", ["add", "README.md"], { cwd: repoPath })
    writeFileSync(join(repoPath, "agent-new.ts"), "export const added = true\n")
    const statusBefore = execFileSync("git", ["status", "--porcelain=v1"], {
      cwd: repoPath,
      encoding: "utf-8"
    })
    const cachedBefore = execFileSync("git", ["diff", "--cached", "--binary"], {
      cwd: repoPath,
      encoding: "utf-8"
    })

    const exit = await runExit(
      WorkspaceService.diff(repoPath).pipe(Effect.provide(services)),
      temp.layer
    )

    expect(exit._tag).toBe("Success")
    if (exit._tag !== "Success") return
    expect(exit.value).toContain("agent-new.ts")
    expect(
      execFileSync("git", ["status", "--porcelain=v1"], {
        cwd: repoPath,
        encoding: "utf-8"
      })
    ).toBe(statusBefore)
    expect(
      execFileSync("git", ["diff", "--cached", "--binary"], {
        cwd: repoPath,
        encoding: "utf-8"
      })
    ).toBe(cachedBefore)
  })

  it("diff() is empty for a clean worktree", async () => {
    const repoPath = initGitRepo(join(repos.dir, "clean"))
    const exit = await runExit(
      WorkspaceService.diff(repoPath).pipe(Effect.provide(services)),
      temp.layer
    )
    expect(exit._tag).toBe("Success")
    if (exit._tag === "Success") expect(exit.value).toBe("")
  })

  it("diffStat counts huge untracked changes without returning their contents", async () => {
    const repoPath = initGitRepo(join(repos.dir, "diff-stat"))
    writeFileSync(join(repoPath, "generated.txt"), "generated\n".repeat(FILE_DIFF_LINE_LIMIT + 1))

    const exit = await runExit(
      WorkspaceService.diffStat(repoPath).pipe(Effect.provide(services)),
      temp.layer
    )

    expect(exit._tag).toBe("Success")
    if (exit._tag === "Success") {
      expect(exit.value).toEqual({
        added: FILE_DIFF_LINE_LIMIT + 1,
        removed: 0,
        files: 1
      })
    }
  })

  it("boundedFileDiff refuses an oversized file before producing its patch", async () => {
    const repoPath = initGitRepo(join(repos.dir, "bounded-file-diff"))
    writeFileSync(join(repoPath, "generated.txt"), "generated\n".repeat(FILE_DIFF_LINE_LIMIT + 1))

    const exit = await runExit(
      WorkspaceService.boundedFileDiff(repoPath, "generated.txt").pipe(Effect.provide(services)),
      temp.layer
    )

    expect(exit._tag).toBe("Success")
    if (exit._tag === "Success") {
      expect(exit.value).toEqual({
        kind: "too-large",
        added: FILE_DIFF_LINE_LIMIT + 1,
        removed: 0,
        reason: "lines",
        lineLimit: FILE_DIFF_LINE_LIMIT,
        byteLimit: FILE_DIFF_BYTE_LIMIT
      })
    }
  })

  it("boundedFileDiff rejects a huge single-line file before producing its patch", async () => {
    const repoPath = initGitRepo(join(repos.dir, "bounded-file-diff-bytes"))
    writeFileSync(join(repoPath, "minified.js"), "x".repeat(FILE_DIFF_BYTE_LIMIT + 1))

    const exit = await runExit(
      WorkspaceService.boundedFileDiff(repoPath, "minified.js").pipe(Effect.provide(services)),
      temp.layer
    )

    expect(exit._tag).toBe("Success")
    if (exit._tag === "Success") {
      expect(exit.value).toMatchObject({ kind: "too-large", reason: "bytes" })
    }
  })

  it("boundedFileDiff returns a normal selected file and includes untracked files", async () => {
    const repoPath = initGitRepo(join(repos.dir, "bounded-file-diff-small"))
    writeFileSync(join(repoPath, "small.txt"), "small\n")

    const exit = await runExit(
      WorkspaceService.boundedFileDiff(repoPath, "small.txt").pipe(Effect.provide(services)),
      temp.layer
    )

    expect(exit._tag).toBe("Success")
    if (exit._tag === "Success") {
      expect(exit.value.kind).toBe("patch")
      if (exit.value.kind === "patch") expect(exit.value.patch).toContain("+small")
    }
  })

  // Commit a fresh file to `repoPath`.
  const commitFile = (repoPath: string, name: string, content: string) => {
    writeFileSync(join(repoPath, name), content)
    execFileSync("git", ["add", "-A"], { cwd: repoPath })
    execFileSync("git", ["commit", "-m", `add ${name}`, "--no-gpg-sign"], { cwd: repoPath })
  }

  const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n") + "\n"

  it("revertFile discards ALL uncommitted changes to a file", async () => {
    const repoPath = initGitRepo(join(repos.dir, "revert-file"))
    commitFile(repoPath, "f.txt", lines(5))
    writeFileSync(join(repoPath, "f.txt"), "totally different\n")

    const exit = await runExit(
      WorkspaceService.revertFile(repoPath, "f.txt").pipe(Effect.provide(services)),
      temp.layer
    )
    expect(exit._tag).toBe("Success")
    expect(readFileSync(join(repoPath, "f.txt"), "utf-8")).toBe(lines(5))
  })

  it("revertRange reverts only the selected hunk, leaving other edits intact", async () => {
    const repoPath = initGitRepo(join(repos.dir, "revert-range"))
    commitFile(repoPath, "f.txt", lines(20))
    // Two edits far enough apart (>2×context) that git emits two separate hunks.
    const edited = lines(20).replace("line 2\n", "line 2 EDITED\n").replace("line 18\n", "line 18 EDITED\n")
    writeFileSync(join(repoPath, "f.txt"), edited)

    // Revert only the range around line 2.
    const exit = await runExit(
      WorkspaceService.revertRange(repoPath, "f.txt", 2, 2).pipe(Effect.provide(services)),
      temp.layer
    )
    expect(exit._tag).toBe("Success")
    const after = readFileSync(join(repoPath, "f.txt"), "utf-8")
    expect(after).toContain("line 2\n") // reverted
    expect(after).not.toContain("line 2 EDITED")
    expect(after).toContain("line 18 EDITED") // untouched
  })

  it("revertRange is a no-op when nothing in the range changed", async () => {
    const repoPath = initGitRepo(join(repos.dir, "revert-noop"))
    commitFile(repoPath, "f.txt", lines(20))
    const edited = lines(20).replace("line 2\n", "line 2 EDITED\n")
    writeFileSync(join(repoPath, "f.txt"), edited)

    // Range far from the only change → nothing reverted, no error.
    const exit = await runExit(
      WorkspaceService.revertRange(repoPath, "f.txt", 18, 20).pipe(Effect.provide(services)),
      temp.layer
    )
    expect(exit._tag).toBe("Success")
    expect(readFileSync(join(repoPath, "f.txt"), "utf-8")).toBe(edited)
  })
})

describe("filterDiffHunks", () => {
  const TWO_HUNK = [
    "diff --git a/f.txt b/f.txt",
    "index 111..222 100644",
    "--- a/f.txt",
    "+++ b/f.txt",
    "@@ -1,3 +1,3 @@",
    " line 1",
    "-line 2",
    "+line 2 EDITED",
    " line 3",
    "@@ -17,3 +17,3 @@",
    " line 17",
    "-line 18",
    "+line 18 EDITED",
    " line 19",
    ""
  ].join("\n")

  it("keeps only the hunk whose new-side range overlaps the selection", () => {
    const out = filterDiffHunks(TWO_HUNK, 2, 2)
    expect(out).not.toBeNull()
    expect(out).toContain("@@ -1,3 +1,3 @@")
    expect(out).not.toContain("@@ -17,3 +17,3 @@")
    // Header is preserved so the result stays a valid patch.
    expect(out).toContain("--- a/f.txt")
  })

  it("keeps both hunks when the range spans them", () => {
    const out = filterDiffHunks(TWO_HUNK, 1, 20)
    expect(out).toContain("@@ -1,3 +1,3 @@")
    expect(out).toContain("@@ -17,3 +17,3 @@")
  })

  it("returns null when no hunk overlaps or the diff is empty", () => {
    expect(filterDiffHunks(TWO_HUNK, 8, 12)).toBeNull()
    expect(filterDiffHunks("", 1, 1)).toBeNull()
  })
})
