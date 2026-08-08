import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Effect } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  GitService,
  ensureWorktreeLinked,
  gitAskpassWrapperSource,
  githubHttpsPushUrl,
  mainTreeHoldsBranch,
  resetWorktreeLinkCache
} from "./git.js"
import { advanceOrigin, failureOf, initGitRepo, initGitRepoWithOrigin, mkTemp, runExit, withTempRoot } from "./test-support.js"

describe("gitAskpassWrapperSource", () => {
  it("uses the app runtime on POSIX without resolving node from PATH", () => {
    const source = gitAskpassWrapperSource("darwin")
    expect(source).toContain('"$JINGLER_GIT_ASKPASS_RUNTIME"')
    expect(source).toContain('"$JINGLER_GIT_ASKPASS_MODULE"')
    expect(source).toContain("ELECTRON_RUN_AS_NODE=1")
    expect(source).not.toContain("/usr/bin/env node")
  })

  it("uses the app runtime through a Windows command wrapper", () => {
    const source = gitAskpassWrapperSource("win32")
    expect(source).toContain('"%JINGLER_GIT_ASKPASS_RUNTIME%"')
    expect(source).toContain('"%JINGLER_GIT_ASKPASS_MODULE%"')
    expect(source).toContain("ELECTRON_RUN_AS_NODE=1")
  })
})

/**
 * GitService.createDetachedWorktree runs real `git worktree add`. We assert the
 * real outcomes on disk — the worktree exists at the resolved base without
 * creating a branded/task ref, and git tracks it — not the git invocations.
 */
describe("GitService.createDetachedWorktree", () => {
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

  const create = (repoPath: string, repoName: string) =>
    runExit(
      GitService.createDetachedWorktree({ repoPath, repoName, slug: "fix-auth", baseBranch: "main" }).pipe(
        Effect.provide(GitService.Default)
      ),
      temp.layer
    )

  it("creates a detached worktree without creating a task branch", async () => {
    const repoPath = initGitRepo(join(repos.dir, "widget"))
    const exit = await create(repoPath, "widget")
    expect(exit._tag).toBe("Success")
    if (exit._tag !== "Success") return

    const worktree = exit.value
    expect(worktree.branch).toBe("main")
    expect(worktree.path).toBe(join(temp.root, "worktrees", "widget", "fix-auth"))
    expect(existsSync(worktree.path)).toBe(true)

    const branches = execFileSync("git", ["branch", "--format=%(refname:short)"], {
      cwd: repoPath,
      encoding: "utf-8"
    })
    expect(branches).not.toMatch(/(?:^|\n)(?:feat|fix|chore|jingler)\//)
    expect(
      execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
        cwd: worktree.path,
        encoding: "utf-8"
      }).trim()
    ).toBe("HEAD")

    const worktrees = execFileSync("git", ["worktree", "list"], { cwd: repoPath, encoding: "utf-8" })
    expect(worktrees).toContain(worktree.path)
  })

  it("removeWorktreeAt deletes a worktree and unregisters it from the origin repo", async () => {
    const repoPath = initGitRepo(join(repos.dir, "rm"))
    const created = await create(repoPath, "rm")
    expect(created._tag).toBe("Success")
    if (created._tag !== "Success") return
    const worktreePath = created.value.path
    expect(existsSync(worktreePath)).toBe(true)

    const removed = await runExit(
      GitService.removeWorktreeAt(worktreePath).pipe(Effect.provide(GitService.Default)),
      temp.layer
    )
    expect(removed._tag).toBe("Success")
    expect(existsSync(worktreePath)).toBe(false)
    const list = execFileSync("git", ["worktree", "list"], { cwd: repoPath, encoding: "utf-8" })
    expect(list).not.toContain(worktreePath)
  })

  /**
   * The case the old implementation could not see. It located the main repo by
   * running git INSIDE the worktree, so a directory deleted by hand left it
   * with nothing to ask — and it returned success having done nothing, leaving
   * a registration git would keep reporting (and tripping "already registered"
   * on the next create at that path) forever.
   */
  it("prunes the registration when the worktree directory is already gone", async () => {
    const repoPath = initGitRepo(join(repos.dir, "ghost"))
    const created = await create(repoPath, "ghost")
    expect(created._tag).toBe("Success")
    if (created._tag !== "Success") return
    const worktreePath = created.value.path

    // Delete the directory behind git's back, the way a person or a stray
    // cleanup script would.
    rmSync(worktreePath, { force: true, recursive: true })
    expect(
      execFileSync("git", ["worktree", "list"], { cwd: repoPath, encoding: "utf-8" })
    ).toContain(worktreePath)

    const removed = await runExit(
      GitService.removeWorktreeAt(worktreePath, repoPath).pipe(Effect.provide(GitService.Default)),
      temp.layer
    )

    expect(removed._tag).toBe("Success")
    const list = execFileSync("git", ["worktree", "list"], { cwd: repoPath, encoding: "utf-8" })
    expect(list).not.toContain(worktreePath)
  })

  it("forks off the fresh remote tip — a session picks up commits the local clone hadn't fetched", async () => {
    // A real clone with a bare origin, then push a commit to origin the clone
    // hasn't seen. Detached creation must fetch + fork off origin/main, not stale local.
    const repoPath = join(repos.dir, "fresh")
    const { origin } = initGitRepoWithOrigin(repoPath)
    advanceOrigin(origin, "remote-only-commit")

    const exit = await create(repoPath, "fresh")
    expect(exit._tag).toBe("Success")
    if (exit._tag !== "Success") return

    // The worktree contains the origin-only commit …
    const worktreeLog = execFileSync("git", ["log", "--format=%s"], {
      cwd: exit.value.path,
      encoding: "utf-8"
    })
    expect(worktreeLog).toContain("remote-only-commit")
    // … which the clone's local `main` still hasn't (we forked off origin/main).
    const localLog = execFileSync("git", ["log", "main", "--format=%s"], {
      cwd: repoPath,
      encoding: "utf-8"
    })
    expect(localLog).not.toContain("remote-only-commit")
  })

  it("still creates the worktree when origin is unreachable (fetch is best-effort)", async () => {
    // A URL-only remote: `git fetch origin main` will fail, but creation must not.
    const repoPath = initGitRepo(join(repos.dir, "offline"), {
      remote: "https://example.invalid/nope.git"
    })
    const exit = await create(repoPath, "offline")
    expect(exit._tag).toBe("Success")
    if (exit._tag !== "Success") return
    expect(existsSync(exit.value.path)).toBe(true)
    expect(exit.value.branch).toBe("main")
    expect(
      execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
        cwd: exit.value.path,
        encoding: "utf-8"
      }).trim()
    ).toBe("HEAD")
  })

  it("uses the local base after an offline fetch instead of a stale remote-tracking ref", async () => {
    const repoPath = initGitRepo(join(repos.dir, "stale-offline"), {
      remote: join(repos.dir, "missing-origin.git")
    })
    execFileSync("git", ["update-ref", "refs/remotes/origin/main", "HEAD"], {
      cwd: repoPath
    })
    const staleRemote = execFileSync("git", ["rev-parse", "origin/main"], {
      cwd: repoPath,
      encoding: "utf8"
    }).trim()
    writeFileSync(join(repoPath, "local-only.ts"), "local base\n")
    execFileSync("git", ["add", "local-only.ts"], { cwd: repoPath })
    execFileSync("git", ["commit", "-m", "advance local base", "--no-gpg-sign"], {
      cwd: repoPath
    })
    const localBase = execFileSync("git", ["rev-parse", "main"], {
      cwd: repoPath,
      encoding: "utf8"
    }).trim()
    expect(localBase).not.toBe(staleRemote)

    const exit = await create(repoPath, "stale-offline")

    expect(exit._tag).toBe("Success")
    if (exit._tag !== "Success") return
    expect(execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: exit.value.path,
      encoding: "utf8"
    }).trim()).toBe(localBase)
  })

  it("forks off a local-only base branch when there is no matching remote ref", async () => {
    // `feature-x` is a purely local branch: no `origin/feature-x`, so the fetch is
    // a no-op and we fall back to forking off the local branch.
    const repoPath = initGitRepo(join(repos.dir, "localbase"), { branches: ["feature-x"] })
    const exit = await runExit(
      GitService.createDetachedWorktree({ repoPath, repoName: "localbase", slug: "off-x", baseBranch: "feature-x" }).pipe(
        Effect.provide(GitService.Default)
      ),
      temp.layer
    )
    expect(exit._tag).toBe("Success")
    if (exit._tag !== "Success") return
    expect(existsSync(exit.value.path)).toBe(true)
    expect(exit.value.baseBranch).toBe("feature-x")
  })

  it("switchBranch moves the primary checkout without creating a task branch or worktree", async () => {
    const repoPath = initGitRepo(join(repos.dir, "direct"), { branches: ["feature-x"] })
    const registeredPaths = () =>
      execFileSync("git", ["worktree", "list", "--porcelain"], {
        cwd: repoPath,
        encoding: "utf-8"
      })
        .split("\n")
        .filter((line) => line.startsWith("worktree "))
    const before = registeredPaths()

    const exit = await runExit(
      GitService.switchBranch(repoPath, "feature-x").pipe(Effect.provide(GitService.Default)),
      temp.layer
    )

    expect(exit._tag).toBe("Success")
    expect(
      execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
        cwd: repoPath,
        encoding: "utf-8"
      }).trim()
    ).toBe("feature-x")
    expect(registeredPaths()).toStrictEqual(before)
    expect(
      execFileSync("git", ["branch", "--list", "jingler/*"], {
        cwd: repoPath,
        encoding: "utf-8"
      }).trim()
    ).toBe("")
  })

  it("createDetachedWorktree reclaims a leftover worktree at the same path (retry-safe)", async () => {
    const repoPath = initGitRepo(join(repos.dir, "retry"))
    const detached = () =>
      runExit(
        GitService.createDetachedWorktree({
          repoPath,
          repoName: "retry",
          slug: "from-pr",
          baseBranch: "main"
        }).pipe(Effect.provide(GitService.Default)),
        temp.layer
      )

    // First attempt leaves a real detached worktree on disk (mimicking a create
    // that failed AFTER the worktree add — e.g. a PR checkout fetch errored).
    const first = await detached()
    expect(first._tag).toBe("Success")
    if (first._tag !== "Success") return
    expect(existsSync(first.value.path)).toBe(true)

    // A retry at the same slug must reclaim the stale worktree, not fail with
    // "already exists".
    const second = await detached()
    expect(second._tag).toBe("Success")
    if (second._tag !== "Success") return
    expect(second.value.path).toBe(first.value.path)
    expect(existsSync(second.value.path)).toBe(true)

    // git tracks exactly one worktree at that path (no stale duplicate).
    const list = execFileSync("git", ["worktree", "list"], { cwd: repoPath, encoding: "utf-8" })
    const occurrences = list.split("\n").filter((l) => l.includes(second.value.path)).length
    expect(occurrences).toBe(1)
  })

  it("creates a task branch from detached HEAD without losing commits or dirty files", async () => {
    const repoPath = initGitRepo(join(repos.dir, "named"))
    const detached = await runExit(
      GitService.createDetachedWorktree({
        repoPath,
        repoName: "named",
        slug: "landing-pad",
        baseBranch: "main"
      }).pipe(Effect.provide(GitService.Default)),
      temp.layer
    )
    expect(detached._tag).toBe("Success")
    if (detached._tag !== "Success") return

    const cwd = detached.value.path
    writeFileSync(join(cwd, "committed.ts"), "committed\n")
    execFileSync("git", ["add", "committed.ts"], { cwd })
    execFileSync("git", ["commit", "-m", "detached work", "--no-gpg-sign"], { cwd })
    writeFileSync(join(cwd, "dirty.ts"), "dirty\n")
    const detachedHead = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd,
      encoding: "utf-8"
    }).trim()

    const named = await runExit(
      GitService.createTaskBranch(cwd, "fix/token-refresh").pipe(
        Effect.provide(GitService.Default)
      ),
      temp.layer
    )
    expect(named._tag).toBe("Success")
    if (named._tag !== "Success") return
    expect(named.value).toBe("fix/token-refresh")
    expect(
      execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
        cwd,
        encoding: "utf-8"
      }).trim()
    ).toBe(named.value)
    expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf-8" }).trim()).toBe(
      detachedHead
    )
    expect(existsSync(join(cwd, "dirty.ts"))).toBe(true)
  })

  it("uses a deterministic suffix when the task branch already exists", async () => {
    const repoPath = initGitRepo(join(repos.dir, "collision"))
    execFileSync("git", ["branch", "fix/token-refresh"], { cwd: repoPath })
    const detached = await runExit(
      GitService.createDetachedWorktree({
        repoPath,
        repoName: "collision",
        slug: "landing-pad",
        baseBranch: "main"
      }).pipe(Effect.provide(GitService.Default)),
      temp.layer
    )
    if (detached._tag !== "Success") throw new Error("expected detached worktree")

    const named = await runExit(
      GitService.createTaskBranch(detached.value.path, "fix/token-refresh").pipe(
        Effect.provide(GitService.Default)
      ),
      temp.layer
    )
    expect(named._tag === "Success" && named.value).toBe("fix/token-refresh-2")
  })

  it("retries the next suffix when concurrent worktrees race to create the same task branch", async () => {
    const repoPath = initGitRepo(join(repos.dir, "concurrent-collision"))
    const createDetached = (slug: string) =>
      runExit(
        GitService.createDetachedWorktree({
          repoPath,
          repoName: "concurrent-collision",
          slug,
          baseBranch: "main"
        }).pipe(Effect.provide(GitService.Default)),
        temp.layer
      )
    const firstDetached = await createDetached("first-pad")
    const secondDetached = await createDetached("second-pad")
    if (firstDetached._tag !== "Success" || secondDetached._tag !== "Success") {
      throw new Error("expected detached worktrees")
    }

    const [first, second] = await Promise.all([
      runExit(
        GitService.createTaskBranch(firstDetached.value.path, "fix/token-refresh").pipe(
          Effect.provide(GitService.Default)
        ),
        temp.layer
      ),
      runExit(
        GitService.createTaskBranch(secondDetached.value.path, "fix/token-refresh").pipe(
          Effect.provide(GitService.Default)
        ),
        temp.layer
      )
    ])

    expect(first._tag).toBe("Success")
    expect(second._tag).toBe("Success")
    if (first._tag !== "Success" || second._tag !== "Success") return
    expect([first.value, second.value].sort()).toStrictEqual([
      "fix/token-refresh",
      "fix/token-refresh-2"
    ])
    expect(
      [firstDetached.value.path, secondDetached.value.path]
        .map((cwd) =>
          execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
            cwd,
            encoding: "utf-8"
          }).trim()
        )
        .sort()
    ).toStrictEqual(["fix/token-refresh", "fix/token-refresh-2"])
  })

  it("reuses the live branch when task activation is triggered twice", async () => {
    const repoPath = initGitRepo(join(repos.dir, "double-retitle"))
    const detached = await runExit(
      GitService.createDetachedWorktree({
        repoPath,
        repoName: "double-retitle",
        slug: "landing-pad",
        baseBranch: "main"
      }).pipe(Effect.provide(GitService.Default)),
      temp.layer
    )
    if (detached._tag !== "Success") throw new Error("expected detached worktree")

    const first = await runExit(
      GitService.createTaskBranch(detached.value.path, "fix/token-refresh").pipe(
        Effect.provide(GitService.Default)
      ),
      temp.layer
    )
    const second = await runExit(
      GitService.createTaskBranch(detached.value.path, "fix/token-refresh").pipe(
        Effect.provide(GitService.Default)
      ),
      temp.layer
    )

    expect(first._tag === "Success" && first.value).toBe("fix/token-refresh")
    expect(second._tag === "Success" && second.value).toBe("fix/token-refresh")
    expect(
      execFileSync(
        "git",
        [
          "for-each-ref",
          "--format=%(refname:short)",
          "refs/heads/fix/token-refresh"
        ],
        { cwd: repoPath, encoding: "utf-8" }
      )
        .trim()
        .split("\n")
    ).toStrictEqual(["fix/token-refresh"])
  })

  it("suffixes a semantic branch when only a remote-tracking ref collides", async () => {
    const repoPath = initGitRepo(join(repos.dir, "remote-collision"))
    execFileSync("git", ["update-ref", "refs/remotes/origin/fix/token-refresh", "HEAD"], {
      cwd: repoPath
    })
    const detached = await runExit(
      GitService.createDetachedWorktree({
        repoPath,
        repoName: "remote-collision",
        slug: "landing-pad",
        baseBranch: "main"
      }).pipe(Effect.provide(GitService.Default)),
      temp.layer
    )
    if (detached._tag !== "Success") throw new Error("expected detached worktree")

    const named = await runExit(
      GitService.createTaskBranch(detached.value.path, "fix/token-refresh").pipe(
        Effect.provide(GitService.Default)
      ),
      temp.layer
    )
    expect(named._tag === "Success" && named.value).toBe("fix/token-refresh-2")
  })

  it("rejects an unsafe semantic ref and leaves the worktree detached", async () => {
    const repoPath = initGitRepo(join(repos.dir, "unsafe-ref"))
    const detached = await runExit(
      GitService.createDetachedWorktree({
        repoPath,
        repoName: "unsafe-ref",
        slug: "landing-pad",
        baseBranch: "main"
      }).pipe(Effect.provide(GitService.Default)),
      temp.layer
    )
    if (detached._tag !== "Success") throw new Error("expected detached worktree")

    const injectionSentinel = join(detached.value.path, "model-owned")
    for (const ref of [
      `fix/safe; touch ${injectionSentinel}`,
      "fix/../../main",
      "topic/not-a-conventional-type",
      "fix/HEAD",
      `fix/${"x".repeat(81)}`,
      "fix/two/components",
      "fix/"
    ]) {
      const named = await runExit(
        GitService.createTaskBranch(detached.value.path, ref).pipe(
          Effect.provide(GitService.Default)
        ),
        temp.layer
      )
      expect(named._tag).toBe("Failure")
      expect(
        execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
          cwd: detached.value.path,
          encoding: "utf8"
        }).trim()
      ).toBe("HEAD")
    }
    expect(existsSync(injectionSentinel)).toBe(false)
  })

  it("pins otherwise unreachable detached commits before worktree removal", async () => {
    const repoPath = initGitRepo(join(repos.dir, "rescue"))
    const detached = await runExit(
      GitService.createDetachedWorktree({
        repoPath,
        repoName: "rescue",
        slug: "quiet-curie",
        baseBranch: "main"
      }).pipe(Effect.provide(GitService.Default)),
      temp.layer
    )
    if (detached._tag !== "Success") throw new Error("expected detached worktree")

    writeFileSync(join(detached.value.path, "work.ts"), "saved\n")
    execFileSync("git", ["add", "work.ts"], { cwd: detached.value.path })
    execFileSync("git", ["commit", "-m", "detached work", "--no-gpg-sign"], {
      cwd: detached.value.path
    })
    const head = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: detached.value.path,
      encoding: "utf-8"
    }).trim()

    const preserved = await runExit(
      GitService.preserveDetachedHead(detached.value.path, "quiet-curie").pipe(
        Effect.provide(GitService.Default)
      ),
      temp.layer
    )
    expect(preserved._tag === "Success" && preserved.value).toBe("chore/quiet-curie")
    expect(
      execFileSync("git", ["rev-parse", "chore/quiet-curie"], {
        cwd: repoPath,
        encoding: "utf-8"
      }).trim()
    ).toBe(head)
  })

  it("normalizes an unsafe recovery hint to a validated semantic fallback", async () => {
    const repoPath = initGitRepo(join(repos.dir, "safe-rescue"))
    const detached = await runExit(
      GitService.createDetachedWorktree({
        repoPath,
        repoName: "safe-rescue",
        slug: "landing-pad",
        baseBranch: "main"
      }).pipe(Effect.provide(GitService.Default)),
      temp.layer
    )
    if (detached._tag !== "Success") throw new Error("expected detached worktree")
    writeFileSync(join(detached.value.path, "work.ts"), "saved\n")
    execFileSync("git", ["add", "work.ts"], { cwd: detached.value.path })
    execFileSync("git", ["commit", "-m", "detached work", "--no-gpg-sign"], {
      cwd: detached.value.path
    })

    const preserved = await runExit(
      GitService.preserveDetachedHead(detached.value.path, "../../main; echo owned").pipe(
        Effect.provide(GitService.Default)
      ),
      temp.layer
    )

    expect(preserved._tag === "Success" && preserved.value).toBe("chore/main-echo-owned")
    expect(execFileSync("git", ["branch", "--list", "jingler/*"], {
      cwd: repoPath,
      encoding: "utf8"
    }).trim()).toBe("")
  })
})

describe("GitService.publishInspection", () => {
  let temp: ReturnType<typeof withTempRoot>
  let repos: ReturnType<typeof mkTemp>

  beforeEach(() => {
    temp = withTempRoot()
    repos = mkTemp("jingler-publish-inspection-")
  })
  afterEach(() => {
    temp.cleanup()
    repos.cleanup()
  })

  it("reports committed and dirty paths while distinguishing the need for a new commit", async () => {
    const dir = initGitRepo(join(repos.dir, "widget"))
    execFileSync("git", ["switch", "-c", "feat/publish-inspection"], { cwd: dir })
    writeFileSync(join(dir, "committed.ts"), "committed\n")
    execFileSync("git", ["add", "committed.ts"], { cwd: dir })
    execFileSync("git", ["commit", "-m", "feat: committed work", "--no-gpg-sign"], { cwd: dir })
    writeFileSync(join(dir, "dirty.ts"), "dirty\n")

    const exit = await runExit(
      GitService.publishInspection(dir, "main").pipe(Effect.provide(GitService.Default)),
      temp.layer
    )

    expect(exit._tag).toBe("Success")
    if (exit._tag !== "Success") return
    expect(exit.value.hasChanges).toBe(true)
    expect(exit.value.unpublished).toBe(1)
    expect(exit.value.changedPaths).toEqual(expect.arrayContaining(["committed.ts", "dirty.ts"]))
    expect(exit.value.diffSummary).toContain("committed.ts")
  })

  it("retains both sides of a dirty workflow rename for permission selection", async () => {
    const dir = initGitRepo(join(repos.dir, "workflow-rename"))
    const workflowDir = join(dir, ".github", "workflows")
    execFileSync("mkdir", ["-p", workflowDir])
    writeFileSync(join(workflowDir, "ci.yml"), "name: CI\n")
    execFileSync("git", ["add", "-A"], { cwd: dir })
    execFileSync("git", ["commit", "-m", "ci: add workflow", "--no-gpg-sign"], { cwd: dir })
    execFileSync("git", ["switch", "-c", "ci/move-workflow"], { cwd: dir })
    renameSync(join(workflowDir, "ci.yml"), join(dir, "ci.yml"))

    const exit = await runExit(
      GitService.publishInspection(dir, "main").pipe(Effect.provide(GitService.Default)),
      temp.layer
    )

    expect(exit._tag).toBe("Success")
    if (exit._tag !== "Success") return
    expect(exit.value.changedPaths).toEqual(
      expect.arrayContaining([".github/workflows/ci.yml", "ci.yml"])
    )
  })
})

describe("GitService.pushWithInstallationToken", () => {
  let temp: ReturnType<typeof withTempRoot>
  let repos: ReturnType<typeof mkTemp>

  beforeEach(() => {
    temp = withTempRoot()
    repos = mkTemp("jingler-secure-push-")
  })
  afterEach(() => {
    temp.cleanup()
    repos.cleanup()
  })

  it("ignores an SSH origin and pushurl, targeting the API-derived HTTPS repository", async () => {
    const dir = initGitRepo(join(repos.dir, "widget"))
    const target = join(repos.dir, "github-widget.git")
    execFileSync("git", ["init", "--bare", target])
    execFileSync("git", ["remote", "add", "origin", "git@github.com:acme/widget.git"], { cwd: dir })
    execFileSync("git", ["remote", "set-url", "--push", "origin", join(repos.dir, "wrong.git")], { cwd: dir })
    execFileSync("git", ["config", `url.file://${target}.insteadOf`, "https://github.com/acme/widget.git"], { cwd: dir })
    execFileSync("git", ["switch", "-c", "feat/secure-publish"], { cwd: dir })
    writeFileSync(join(dir, "secure.ts"), "export const secure = true\n")
    execFileSync("git", ["add", "secure.ts"], { cwd: dir })
    execFileSync("git", ["commit", "-m", "feat: secure publish", "--no-gpg-sign"], { cwd: dir })
    const token = "ghs_secret_not_for_disk_or_logs"

    const exit = await runExit(
      GitService.pushWithInstallationToken(
        dir,
        "feat/secure-publish",
        "acme/widget",
        token
      ).pipe(Effect.provide(GitService.Default)),
      temp.layer
    )

    const failure = failureOf(exit)
    expect(exit._tag, `${failure?.message} ${String(failure?.cause)}`).toBe("Success")
    expect(execFileSync("git", ["rev-parse", "refs/heads/feat/secure-publish"], {
      cwd: target,
      encoding: "utf8"
    }).trim()).toBe(execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim())
    expect(execFileSync("git", ["remote", "get-url", "origin"], { cwd: dir, encoding: "utf8" }).trim())
      .toBe("git@github.com:acme/widget.git")
    expect(execFileSync("git", ["remote", "get-url", "--push", "origin"], { cwd: dir, encoding: "utf8" }).trim())
      .toBe(join(repos.dir, "wrong.git"))
    expect(readFileSync(join(dir, ".git", "config"), "utf8")).not.toContain(token)
  })

  it("constructs only validated GitHub HTTPS repository URLs", () => {
    expect(githubHttpsPushUrl("acme/widget")).toBe("https://github.com/acme/widget.git")
    expect(githubHttpsPushUrl("acme/widget/extra")).toBeNull()
    expect(githubHttpsPushUrl("acme;touch-owned/widget")).toBeNull()
    expect(githubHttpsPushUrl("acme/widget\n--upload-pack=owned")).toBeNull()
  })
})

describe("GitService.pushConfigured", () => {
  let temp: ReturnType<typeof withTempRoot>
  let repos: ReturnType<typeof mkTemp>

  beforeEach(() => {
    temp = withTempRoot()
    repos = mkTemp("jingler-device-push-")
  })
  afterEach(() => {
    temp.cleanup()
    repos.cleanup()
  })

  it("pushes through the device origin without accepting a desktop token", async () => {
    const dir = initGitRepo(join(repos.dir, "widget"))
    const target = join(repos.dir, "remote.git")
    execFileSync("git", ["init", "--bare", target])
    execFileSync("git", ["remote", "add", "origin", target], { cwd: dir })
    execFileSync("git", ["switch", "-c", "feat/device-publish"], { cwd: dir })
    writeFileSync(join(dir, "device.ts"), "export const device = true\n")
    execFileSync("git", ["add", "device.ts"], { cwd: dir })
    execFileSync("git", ["commit", "-m", "feat: device publish", "--no-gpg-sign"], { cwd: dir })

    const exit = await runExit(
      GitService.pushConfigured(dir, "feat/device-publish").pipe(Effect.provide(GitService.Default)),
      temp.layer
    )

    expect(exit._tag).toBe("Success")
    expect(execFileSync("git", ["rev-parse", "refs/heads/feat/device-publish"], {
      cwd: target,
      encoding: "utf8"
    }).trim()).toBe(execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim())
  })
})

/**
 * `commitsSince` feeds review-finding attribution: the first commit touching a
 * finding's file is credited with fixing it. So the two things worth asserting
 * against real git are the ORDER (oldest first — the contract the credit rule
 * depends on) and the per-commit file lists the match is made against.
 */
describe("GitService.commitsSince", () => {
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

  const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf-8" })

  const commit = (dir: string, file: string, message: string) => {
    writeFileSync(join(dir, file), `${message}\n`)
    git(dir, ["add", "-A"])
    git(dir, ["commit", "-m", message, "--no-gpg-sign"])
  }

  const since = (cwd: string, sha: string) =>
    runExit(GitService.commitsSince(cwd, sha).pipe(Effect.provide(GitService.Default)), temp.layer)

  it("lists commits oldest-first with the files each touched", async () => {
    const dir = initGitRepo(join(repos.dir, "widget"))
    const base = git(dir, ["rev-parse", "HEAD"]).trim()
    commit(dir, "a.ts", "first")
    commit(dir, "b.ts", "second")

    const exit = await since(dir, base)
    expect(exit._tag).toBe("Success")
    if (exit._tag !== "Success") return
    expect(exit.value.map((c) => c.subject)).toStrictEqual(["first", "second"])
    expect(exit.value.map((c) => c.files)).toStrictEqual([["a.ts"], ["b.ts"]])
    expect(exit.value[0]!.sha).toHaveLength(40)
  })

  it("lists every file a single commit touched", async () => {
    const dir = initGitRepo(join(repos.dir, "widget"))
    const base = git(dir, ["rev-parse", "HEAD"]).trim()
    writeFileSync(join(dir, "a.ts"), "a\n")
    writeFileSync(join(dir, "b.ts"), "b\n")
    git(dir, ["add", "-A"])
    git(dir, ["commit", "-m", "both", "--no-gpg-sign"])

    const exit = await since(dir, base)
    if (exit._tag !== "Success") throw new Error("expected success")
    expect(exit.value).toHaveLength(1)
    expect([...exit.value[0]!.files].sort()).toStrictEqual(["a.ts", "b.ts"])
  })

  it("is empty when nothing has landed since the head", async () => {
    const dir = initGitRepo(join(repos.dir, "widget"))
    const head = git(dir, ["rev-parse", "HEAD"]).trim()
    const exit = await since(dir, head)
    if (exit._tag !== "Success") throw new Error("expected success")
    expect(exit.value).toStrictEqual([])
  })

  it("folds an unknown SHA to empty rather than failing", async () => {
    // The real case: the reviewed head was force-pushed away, so the object is
    // gone from this worktree. Declining to attribute is the safe direction — a
    // crashed review pane is not.
    const dir = initGitRepo(join(repos.dir, "widget"))
    const exit = await since(dir, "0000000000000000000000000000000000000000")
    expect(exit._tag).toBe("Success")
    if (exit._tag !== "Success") return
    expect(exit.value).toStrictEqual([])
  })

  it("keeps a subject containing punctuation intact", async () => {
    // The parse splits on a unit separator, not on ':' or '-', so a conventional
    // commit subject survives whole.
    const dir = initGitRepo(join(repos.dir, "widget"))
    const base = git(dir, ["rev-parse", "HEAD"]).trim()
    commit(dir, "a.ts", "fix(auth): compare tokens with timingSafeEqual - not ===")

    const exit = await since(dir, base)
    if (exit._tag !== "Success") throw new Error("expected success")
    expect(exit.value[0]!.subject).toBe("fix(auth): compare tokens with timingSafeEqual - not ===")
  })
})

/**
 * The parse that decides whether a branch is held by the MAIN working tree.
 * Pure, so these cases need no repo — the integration behaviour is asserted
 * separately against real git below.
 */
describe("mainTreeHoldsBranch", () => {
  // `git worktree list --porcelain`: blank-line separated records, main first.
  const porcelain = [
    "worktree /repos/widget\nHEAD abc123\nbranch refs/heads/main",
    "worktree /jingler/worktrees/widget/fix-auth\nHEAD def456\nbranch refs/heads/fix/auth-refresh",
    "worktree /jingler/worktrees/widget/detached\nHEAD 789abc\ndetached"
  ].join("\n\n")

  it("reports a branch held by the main working tree", () => {
    expect(mainTreeHoldsBranch(porcelain, "main")).toBe(true)
  })

  it("does NOT report a branch held only by another session worktree", () => {
    // Sharing between two sessions is the case the lever legitimately opts into.
    expect(mainTreeHoldsBranch(porcelain, "fix/auth-refresh")).toBe(false)
  })

  it("does not match a branch nobody has checked out", () => {
    expect(mainTreeHoldsBranch(porcelain, "feature/new")).toBe(false)
  })

  it("does not confuse a branch whose name PREFIXES another", () => {
    // `refs/heads/main` must not match a query for `mai`, nor `main` match a
    // main tree sitting on `main-2` — the compare is on the whole ref line.
    expect(mainTreeHoldsBranch(porcelain, "mai")).toBe(false)
    expect(
      mainTreeHoldsBranch("worktree /repos/widget\nHEAD abc123\nbranch refs/heads/main-2", "main")
    ).toBe(false)
  })

  it("treats a detached main working tree as holding nothing", () => {
    expect(mainTreeHoldsBranch("worktree /repos/widget\nHEAD abc123\ndetached", "main")).toBe(false)
  })

  it("folds empty output to false rather than throwing", () => {
    expect(mainTreeHoldsBranch("", "main")).toBe(false)
  })
})

describe("GitService.checkoutPullRequestHead", () => {
  let temp: ReturnType<typeof withTempRoot>
  let repos: ReturnType<typeof mkTemp>
  beforeEach(() => {
    temp = withTempRoot()
    repos = mkTemp("jingler-pr-fork-")
  })
  afterEach(() => {
    temp.cleanup()
    repos.cleanup()
  })

  const git = (dir: string, args: Array<string>) =>
    execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim()

  it("fetches and tracks the API-resolved ref from a fork remote", async () => {
    const base = join(repos.dir, "base")
    initGitRepoWithOrigin(base)
    const fork = join(repos.dir, "fork")
    const { origin: forkOrigin } = initGitRepoWithOrigin(fork)
    git(fork, ["checkout", "-b", "feature/from-fork"])
    writeFileSync(join(fork, "fork-only.ts"), "export const fromFork = true\n")
    git(fork, ["add", "fork-only.ts"])
    git(fork, ["commit", "-m", "fork change", "--no-gpg-sign"])
    git(fork, ["push", "origin", "feature/from-fork"])

    const exit = await runExit(
      GitService.checkoutPullRequestHead(base, {
        repositoryId: "303",
        fullName: "contributor/widget",
        ref: "feature/from-fork",
        sha: git(fork, ["rev-parse", "HEAD"]),
        cloneUrl: forkOrigin,
        sshUrl: null
      }).pipe(Effect.provide(GitService.Default)),
      temp.layer
    )

    expect(exit._tag).toBe("Success")
    expect(git(base, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("feature/from-fork")
    expect(existsSync(join(base, "fork-only.ts"))).toBe(true)
    expect(git(base, ["remote", "get-url", "jingler-pr-303"])).toBe(forkOrigin)
    expect(git(base, ["config", "branch.feature/from-fork.remote"])).toBe("jingler-pr-303")
  })

  it("fast-forwards an existing stale local branch to the fetched PR head", async () => {
    const base = join(repos.dir, "base-stale")
    initGitRepoWithOrigin(base)
    const fork = join(repos.dir, "fork-stale")
    const { origin: forkOrigin } = initGitRepoWithOrigin(fork)
    git(fork, ["checkout", "-b", "feature/stale"])
    writeFileSync(join(fork, "first.ts"), "export const first = true\n")
    git(fork, ["add", "first.ts"])
    git(fork, ["commit", "-m", "first", "--no-gpg-sign"])
    git(fork, ["push", "origin", "feature/stale"])
    const firstSha = git(fork, ["rev-parse", "HEAD"])

    const first = await runExit(
      GitService.checkoutPullRequestHead(base, {
        repositoryId: "404",
        fullName: "contributor/widget",
        ref: "feature/stale",
        sha: firstSha,
        cloneUrl: forkOrigin,
        sshUrl: null
      }).pipe(Effect.provide(GitService.Default)),
      temp.layer
    )
    expect(first._tag).toBe("Success")
    git(base, ["checkout", "main"])

    writeFileSync(join(fork, "second.ts"), "export const second = true\n")
    git(fork, ["add", "second.ts"])
    git(fork, ["commit", "-m", "second", "--no-gpg-sign"])
    git(fork, ["push", "origin", "feature/stale"])
    const secondSha = git(fork, ["rev-parse", "HEAD"])

    const second = await runExit(
      GitService.checkoutPullRequestHead(base, {
        repositoryId: "404",
        fullName: "contributor/widget",
        ref: "feature/stale",
        sha: secondSha,
        cloneUrl: forkOrigin,
        sshUrl: null
      }).pipe(Effect.provide(GitService.Default)),
      temp.layer
    )

    expect(second._tag).toBe("Success")
    expect(git(base, ["rev-parse", "HEAD"])).toBe(secondSha)
    expect(existsSync(join(base, "second.ts"))).toBe(true)
  })
})

/**
 * checkoutBranch against real git. The guard exists to stop an agent's commits
 * moving the branch the developer is standing on, so the assertion that matters
 * is that the refusal happens BEFORE any checkout runs.
 */
describe("GitService.checkoutBranch", () => {
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

  const git = (dir: string, args: Array<string>) =>
    execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" })

  const checkout = (cwd: string, branch: string) =>
    runExit(
      GitService.checkoutBranch(cwd, branch).pipe(Effect.provide(GitService.Default)),
      temp.layer
    )

  it("refuses a branch checked out in the main working tree", async () => {
    const repo = initGitRepo(join(repos.dir, "widget"))
    // The developer's own checkout is on `main`; a session worktree sits beside it.
    const wt = join(temp.root, "wt")
    git(repo, ["worktree", "add", "--detach", wt, "main"])

    const exit = await checkout(wt, "main")
    expect(exit._tag).toBe("Failure")
    expect(failureOf(exit)?.message).toMatch(/main working tree/i)
    // The worktree must be untouched — still detached, not sharing `main`.
    expect(git(wt, ["rev-parse", "--abbrev-ref", "HEAD"]).trim()).toBe("HEAD")
  })

  it("allows a branch no other worktree holds", async () => {
    const repo = initGitRepo(join(repos.dir, "widget"))
    git(repo, ["branch", "feature/x"])
    const wt = join(temp.root, "wt")
    git(repo, ["worktree", "add", "--detach", wt, "main"])

    const exit = await checkout(wt, "feature/x")
    expect(exit._tag).toBe("Success")
    expect(git(wt, ["rev-parse", "--abbrev-ref", "HEAD"]).trim()).toBe("feature/x")
  })
})

/**
 * Renaming a repo directory breaks every worktree forked from it, because the
 * link between the two is stored as an ABSOLUTE path at both ends. These run
 * real `git worktree add` and a real directory rename — the failure being
 * repaired is git's own, so a fake executor would only prove the mock agrees
 * with itself.
 */
describe("ensureWorktreeLinked", () => {
  let temp: ReturnType<typeof withTempRoot>
  let repos: ReturnType<typeof mkTemp>
  beforeEach(() => {
    temp = withTempRoot()
    repos = mkTemp("jingler-repos-")
    // The checked-set is module-level and survives between cases, so a second
    // test would otherwise short-circuit on the first one's path.
    resetWorktreeLinkCache()
  })
  afterEach(() => {
    temp.cleanup()
    repos.cleanup()
  })

  const git = (cwd: string, args: Array<string>) =>
    execFileSync("git", args, { cwd, encoding: "utf-8" })

  /** Does git still recognise `dir` as a working tree? */
  const isLinked = (dir: string): boolean => {
    try {
      git(dir, ["rev-parse", "--git-dir"])
      return true
    } catch {
      return false
    }
  }

  /** A repo with one worktree forked from it. Returns both paths. */
  const forkWorktree = async (name: string) => {
    const repoPath = initGitRepo(join(repos.dir, name))
    const exit = await runExit(
      GitService.createDetachedWorktree({
        repoPath,
        repoName: name,
        slug: "fix-auth",
        baseBranch: "main"
      }).pipe(Effect.provide(GitService.Default)),
      temp.layer
    )
    expect(exit._tag).toBe("Success")
    if (exit._tag !== "Success") throw new Error("worktree fork failed")
    return { repoPath, worktreePath: exit.value.path }
  }

  const repair = (repoPath: string, worktreePath: string) =>
    runExit(ensureWorktreeLinked(repoPath, worktreePath), temp.layer)

  it("re-points a worktree after its repo directory is renamed", async () => {
    const { repoPath, worktreePath } = await forkWorktree("starbase")
    expect(isLinked(worktreePath)).toBe(true)

    // The rename the whole fix exists for. The worktree itself does not move —
    // it lives under ~/jingler/worktrees — so it is left holding an absolute
    // path to a repo that is no longer there.
    const renamed = join(repos.dir, "jingler")
    renameSync(repoPath, renamed)
    expect(isLinked(worktreePath)).toBe(false)

    const exit = await repair(renamed, worktreePath)
    expect(exit._tag).toBe("Success")
    expect(isLinked(worktreePath)).toBe(true)
  })

  it("leaves a healthy worktree alone", async () => {
    const { repoPath, worktreePath } = await forkWorktree("widget")
    const before = git(worktreePath, ["rev-parse", "HEAD"]).trim()

    const exit = await repair(repoPath, worktreePath)
    expect(exit._tag).toBe("Success")
    expect(isLinked(worktreePath)).toBe(true)
    expect(git(worktreePath, ["rev-parse", "HEAD"]).trim()).toBe(before)
  })

  it("does not re-create a worktree that was deleted", async () => {
    const { repoPath, worktreePath } = await forkWorktree("widget")
    rmSync(worktreePath, { recursive: true, force: true })

    const exit = await repair(repoPath, worktreePath)
    // Succeeds because it is best-effort, but must not resurrect the directory:
    // handing an agent an empty tree wearing the right name is worse than the
    // honest failure the caller is about to raise.
    expect(exit._tag).toBe("Success")
    expect(existsSync(worktreePath)).toBe(false)
  })

  it("checks a given worktree only once per run", async () => {
    const { repoPath, worktreePath } = await forkWorktree("starbase")
    const renamed = join(repos.dir, "jingler")
    renameSync(repoPath, renamed)

    expect((await repair(renamed, worktreePath))._tag).toBe("Success")
    expect(isLinked(worktreePath)).toBe(true)

    // Break it a second time. The memo means this is NOT repaired again — which
    // is the intended trade: one subprocess per worktree per run, not two per
    // message forever.
    renameSync(renamed, join(repos.dir, "moved-again"))
    expect(isLinked(worktreePath)).toBe(false)
    expect((await repair(join(repos.dir, "moved-again"), worktreePath))._tag).toBe("Success")
    expect(isLinked(worktreePath)).toBe(false)
  })

  it("is a no-op when either path is empty", async () => {
    expect((await repair("", "/tmp/whatever"))._tag).toBe("Success")
    expect((await repair("/tmp/whatever", ""))._tag).toBe("Success")
  })
})
