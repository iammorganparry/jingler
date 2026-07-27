import { execFileSync } from "node:child_process"
import { existsSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Effect } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { GitService, ensureWorktreeLinked, mainTreeHoldsBranch, resetWorktreeLinkCache } from "./git.js"
import { advanceOrigin, failureOf, initGitRepo, initGitRepoWithOrigin, mkTemp, runExit, withTempRoot } from "./test-support.js"

/**
 * GitService.createWorktree runs real `git worktree add`. We assert the real
 * outcomes on disk — the worktree exists, the branch was created and git tracks
 * the worktree — not the git invocations.
 */
describe("GitService.createWorktree", () => {
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
      GitService.createWorktree({ repoPath, repoName, slug: "fix-auth", baseBranch: "main" }).pipe(
        Effect.provide(GitService.Default)
      ),
      temp.layer
    )

  it("creates the worktree on a fresh jingler/<slug> branch", async () => {
    const repoPath = initGitRepo(join(repos.dir, "widget"))
    const exit = await create(repoPath, "widget")
    expect(exit._tag).toBe("Success")
    if (exit._tag !== "Success") return

    const worktree = exit.value
    expect(worktree.branch).toBe("jingler/fix-auth")
    expect(worktree.path).toBe(join(temp.root, "worktrees", "widget", "fix-auth"))
    expect(existsSync(worktree.path)).toBe(true)

    const branches = execFileSync("git", ["branch", "--format=%(refname:short)"], {
      cwd: repoPath,
      encoding: "utf-8"
    })
    expect(branches).toContain("jingler/fix-auth")

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
    // hasn't seen. createWorktree must fetch + fork off origin/main, not stale local.
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
    expect(exit.value.branch).toBe("jingler/fix-auth")
  })

  it("forks off a local-only base branch when there is no matching remote ref", async () => {
    // `feature-x` is a purely local branch: no `origin/feature-x`, so the fetch is
    // a no-op and we fall back to forking off the local branch.
    const repoPath = initGitRepo(join(repos.dir, "localbase"), { branches: ["feature-x"] })
    const exit = await runExit(
      GitService.createWorktree({ repoPath, repoName: "localbase", slug: "off-x", baseBranch: "feature-x" }).pipe(
        Effect.provide(GitService.Default)
      ),
      temp.layer
    )
    expect(exit._tag).toBe("Success")
    if (exit._tag !== "Success") return
    expect(existsSync(exit.value.path)).toBe(true)
    expect(exit.value.baseBranch).toBe("feature-x")
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
    // that failed AFTER the worktree add — e.g. gh pr checkout errored).
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
      GitService.createTaskBranch(cwd, "fix-token-refresh").pipe(
        Effect.provide(GitService.Default)
      ),
      temp.layer
    )
    expect(named._tag).toBe("Success")
    if (named._tag !== "Success") return
    expect(named.value).toBe("jingler/fix-token-refresh")
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
    execFileSync("git", ["branch", "jingler/fix-token-refresh"], { cwd: repoPath })
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
      GitService.createTaskBranch(detached.value.path, "fix-token-refresh").pipe(
        Effect.provide(GitService.Default)
      ),
      temp.layer
    )
    expect(named._tag === "Success" && named.value).toBe("jingler/fix-token-refresh-2")
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
      GitService.createTaskBranch(detached.value.path, "fix-token-refresh").pipe(
        Effect.provide(GitService.Default)
      ),
      temp.layer
    )
    const second = await runExit(
      GitService.createTaskBranch(detached.value.path, "fix-token-refresh").pipe(
        Effect.provide(GitService.Default)
      ),
      temp.layer
    )

    expect(first._tag === "Success" && first.value).toBe("jingler/fix-token-refresh")
    expect(second._tag === "Success" && second.value).toBe("jingler/fix-token-refresh")
    expect(
      execFileSync(
        "git",
        [
          "for-each-ref",
          "--format=%(refname:short)",
          "refs/heads/jingler/fix-token-refresh"
        ],
        { cwd: repoPath, encoding: "utf-8" }
      )
        .trim()
        .split("\n")
    ).toStrictEqual(["jingler/fix-token-refresh"])
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
    expect(preserved._tag === "Success" && preserved.value).toBe("jingler/quiet-curie")
    expect(
      execFileSync("git", ["rev-parse", "jingler/quiet-curie"], {
        cwd: repoPath,
        encoding: "utf-8"
      }).trim()
    ).toBe(head)
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
    "worktree /jingler/worktrees/widget/fix-auth\nHEAD def456\nbranch refs/heads/jingler/fix-auth",
    "worktree /jingler/worktrees/widget/detached\nHEAD 789abc\ndetached"
  ].join("\n\n")

  it("reports a branch held by the main working tree", () => {
    expect(mainTreeHoldsBranch(porcelain, "main")).toBe(true)
  })

  it("does NOT report a branch held only by another session worktree", () => {
    // Sharing between two sessions is the case the lever legitimately opts into.
    expect(mainTreeHoldsBranch(porcelain, "jingler/fix-auth")).toBe(false)
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
      GitService.createWorktree({
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
