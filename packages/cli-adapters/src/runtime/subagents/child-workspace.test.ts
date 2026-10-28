import { execFileSync } from "node:child_process"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { childWorkspace } from "./child-workspace.js"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, stdio: "ignore" })

const makeRepo = async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "jingler-child-ws-")))
  roots.push(root)
  const repo = join(root, "repo")
  execFileSync("git", ["init", "-q", "-b", "main", repo])
  git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init")
  return { root, repo }
}

describe("childWorkspace", () => {
  it("reports path and branch for a child in a separate worktree", async () => {
    const { root, repo } = await makeRepo()
    const child = join(root, "child")
    git(repo, "worktree", "add", "-q", "-b", "pi-subagents/reviewer", child)
    expect(childWorkspace(child, repo)).toEqual({
      path: child,
      branch: "pi-subagents/reviewer",
      baseRef: null
    })
  })

  it("is null when the child shares the parent checkout", async () => {
    const { repo } = await makeRepo()
    expect(childWorkspace(repo, repo)).toBeNull()
  })

  it("is null when the cwd is unknown or not a git checkout", async () => {
    const { root, repo } = await makeRepo()
    expect(childWorkspace(undefined, repo)).toBeNull()
    expect(childWorkspace(root, repo)).toBeNull()
  })
})
