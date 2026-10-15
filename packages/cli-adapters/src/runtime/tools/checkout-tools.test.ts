import { Effect } from "effect"
import type { StreamEvent } from "@jingler/core"
import { describe, expect, it } from "vitest"
import { activeCheckoutCwd, registerCheckoutTool, type CheckoutHost, type CheckoutSessionState } from "./checkout-tools.js"
import { ToolRegistry } from "./tool-registry.js"

const projects = [
  { id: "p1", name: "web", path: "/repos/web" },
  { id: "p2", name: "api", path: "/repos/api" }
]

const setup = () => {
  let session: CheckoutSessionState = {
    id: "s1", projectId: "p1", repo: "web", repoPath: "/repos/web", worktreePath: "/wt/web-1",
    workspaceMode: "worktree", branch: "feat/x", prNumber: null
  } as CheckoutSessionState
  const created: string[] = []
  const registered: string[] = []
  let approve = false
  const events: StreamEvent[] = []
  const host: CheckoutHost = {
    session: () => session,
    save: async (next) => { session = next },
    projects: async () => projects,
    approveRepo: async () => approve,
    registerProject: async (repoPath) => { registered.push(repoPath); return { id: "p3", name: "elsewhere", path: repoPath } },
    createWorktree: async ({ repoPath, baseBranch }) => {
      created.push(repoPath)
      return { path: `/wt/new-${created.length}`, branch: baseBranch ?? "main", baseBranch: baseBranch ?? "main", repoPath }
    }
  }
  const registry = new ToolRegistry()
  registerCheckoutTool(registry, host, (e) => Effect.sync(() => { events.push(e) }))
  const run = (args: unknown) =>
    Effect.runPromise(registry.execute({ id: "switch_checkout", arguments: args, role: "conversation", mode: "auto" }))
  return { host, created, events, run, registered, approveWith: (v: boolean) => { approve = v } }
}

describe("switch_checkout", () => {
  it("resolves a registered project by name, attaches a worktree and moves cwd", async () => {
    const { host, created, events, run } = setup()
    expect(activeCheckoutCwd(host)).toBe("/wt/web-1")
    const result = await run({ project: "API", branch: "develop" })
    expect(result.status).toBe("success")
    expect(created).toEqual(["/repos/api"])
    expect(activeCheckoutCwd(host)).toBe("/wt/new-1")
    expect(events).toContainEqual({ _tag: "Assistant", text: "Switched to `api` · `develop`" })
  })

  it("resolves a registered project by path", async () => {
    const { host, created, run } = setup()
    await run({ repoPath: "/repos/api/" })
    expect(created).toEqual(["/repos/api"])
    expect(host.session().repo).toBe("api")
  })

  it("switches back to an attached checkout without creating another worktree", async () => {
    const { host, created, run } = setup()
    await run({ project: "api" })
    await run({ project: "web" })
    expect(activeCheckoutCwd(host)).toBe("/wt/web-1")
    await run({ project: "api" })
    expect(created).toEqual(["/repos/api"])
    expect(host.session().checkouts).toHaveLength(2)
    expect(activeCheckoutCwd(host)).toBe("/wt/new-1")
  })

  it("denied approval on an unregistered path leaves the session unchanged", async () => {
    const { host, created, registered, run } = setup()
    const result = await run({ repoPath: "/elsewhere/repo" })
    expect(result).toMatchObject({ status: "success", value: { status: "denied" } })
    expect(created).toEqual([])
    expect(registered).toEqual([])
    expect(host.session().checkouts).toBeUndefined()
  })

  it("approved unregistered path is registered as a project and attached", async () => {
    const { host, created, registered, run, approveWith } = setup()
    approveWith(true)
    await run({ repoPath: "/elsewhere/repo" })
    expect(registered).toEqual(["/elsewhere/repo"])
    expect(created).toEqual(["/elsewhere/repo"])
    expect(host.session().repo).toBe("elsewhere")
  })
})
