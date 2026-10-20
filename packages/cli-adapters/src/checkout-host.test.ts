import { describe, expect, it } from "vitest"
import { activeCheckoutOf } from "@jingler/core"
import { makeCheckoutHost, type CheckoutHostDeps } from "./checkout-host.js"

const session = { id: "s1", repo: "web", repoPath: "/r/web", worktreePath: "/w/web", branch: "b", baseBranch: "main", prNumber: null } as CheckoutHostDeps["session"]

const setup = () => {
  const worktreeInputs: Array<{ baseBranch: string }> = []
  let persisted: CheckoutHostDeps["session"] | undefined
  const host = makeCheckoutHost({
    session,
    listProjects: async () => [],
    registerProject: async (path) => ({ id: "p", name: "n", path } as never),
    persist: async (next) => { persisted = next; return next },
    createDetachedWorktree: async (input) => {
      worktreeInputs.push({ baseBranch: input.baseBranch })
      return { path: "/w/new", branch: input.baseBranch, baseBranch: input.baseBranch, repoPath: input.repoPath }
    },
    defaultBranch: async () => "trunk",
    approveRepo: async () => true
  })
  return { host, worktreeInputs, persisted: () => persisted }
}

describe("makeCheckoutHost", () => {
  it("resolves an undefined baseBranch to the repo default and keeps an explicit one", async () => {
    const { host, worktreeInputs } = setup()
    await host.createWorktree({ repoPath: "/r/api", repoName: "api", slug: "a", baseBranch: undefined })
    await host.createWorktree({ repoPath: "/r/api", repoName: "api", slug: "a", baseBranch: "dev" })
    expect(worktreeInputs).toEqual([{ baseBranch: "trunk" }, { baseBranch: "dev" }])
  })

  it("save persists and session() returns the stored result", async () => {
    const { host, persisted } = setup()
    const next = { ...session, branch: "other" }
    await host.save(next)
    expect(persisted()).toBe(next)
    expect(activeCheckoutOf(host.session()).branch).toBe("other")
  })
})
