import type { CreateSessionInput } from "@jingler/core"
import { createActor, waitFor } from "xstate"
import { describe, expect, it } from "vitest"
import { newSessionMachine, type NewSessionDeps } from "./new-session-machine.js"

const makeDeps = (created: CreateSessionInput[]): NewSessionDeps => ({
  repos: [
    {
      name: "widget",
      path: "/repos/widget",
      defaultBranch: "main",
      currentBranch: "main",
      remoteUrl: null,
      githubSlug: null
    }
  ],
  availableClis: [
    {
      kind: "claude",
      label: "Claude Code",
      binPath: "/usr/bin/claude",
      version: null,
      available: true
    }
  ],
  defaultCli: "claude",
  loadBranches: async () => ["main"],
  onCreate: async (input) => {
    created.push(input)
  },
  onClose: () => {}
})

const submit = async (title: string, useWorktree = true) => {
  const created: CreateSessionInput[] = []
  const deps = makeDeps(created)
  const actor = createActor(newSessionMachine, { input: { getDeps: () => deps } }).start()
  actor.send({ type: "OPEN" })
  await waitFor(actor, (state) => state.context.base === "main")
  actor.send({ type: "SET_TITLE", title })
  actor.send({ type: "SET_USE_WORKTREE", useWorktree })
  actor.send({ type: "SUBMIT" })
  await waitFor(actor, (state) => state.matches({ submission: "done" }))
  actor.stop()
  return created[0]
}

describe("newSessionMachine blank session naming", () => {
  it("trims and submits an operator-entered name", async () => {
    await expect(submit("  Fix token refresh  ")).resolves.toMatchObject({
      title: "Fix token refresh",
      baseBranch: "main"
    })
  })

  it("omits a whitespace-only name so the agent can name the session", async () => {
    const input = await submit("   ")
    expect(input).toBeDefined()
    expect(input).not.toHaveProperty("title")
  })
})

describe("newSessionMachine workspace mode", () => {
  it("seeds isolated worktree creation on every open", () => {
    const deps = makeDeps([])
    const actor = createActor(newSessionMachine, {
      input: { getDeps: () => deps }
    }).start()

    actor.send({ type: "OPEN" })
    expect(actor.getSnapshot().context.useWorktree).toBe(true)
    actor.send({ type: "SET_USE_WORKTREE", useWorktree: false })
    expect(actor.getSnapshot().context.useWorktree).toBe(false)

    actor.send({ type: "OPEN" })
    expect(actor.getSnapshot().context.useWorktree).toBe(true)
    actor.stop()
  })

  it("submits the default worktree choice", async () => {
    await expect(submit("Isolated task")).resolves.toMatchObject({
      useWorktree: true
    })
  })

  it("submits direct-checkout creation when switched off", async () => {
    await expect(submit("Direct task", false)).resolves.toMatchObject({
      useWorktree: false
    })
  })
})
