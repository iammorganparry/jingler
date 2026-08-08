import type { CreateSessionFromIssueInput, CreateSessionFromPrInput, CreateSessionInput, IssueSummary, PrSummary } from "@jingler/core"
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

const remoteRepo = {
  name: "widget",
  path: "/remote/repos/widget",
  defaultBranch: "main",
  currentBranch: "main",
  branches: ["main", "feature"],
  githubSlug: "acme/widget"
} as const

const remoteDeps = (created: CreateSessionInput[] = []): NewSessionDeps => ({
  ...makeDeps(created),
  environments: [{
    id: "device-clive",
    name: "clive.local",
    platform: { os: "darwin", arch: "arm64" },
    capabilities: { version: 1, capabilities: ["session.start"], harnesses: ["claude"], maxConcurrentSessions: 2 },
    state: "online",
    agentVersion: "2.0.3",
    lastSeenAt: 1
  }],
  loadEnvironmentDiscovery: async () => ({
    version: 1,
    deviceId: "device-clive",
    discovery: {
      version: 1,
      agentVersion: "2.0.3",
      platform: { os: "darwin", arch: "arm64" },
      capabilities: { version: 1, capabilities: ["session.start"], harnesses: ["claude"], maxConcurrentSessions: 2 },
      repositories: [remoteRepo]
    },
    updatedAt: 1
  }),
  loadBranches: async (_repoPath, environmentId) =>
    environmentId === "device-clive" ? remoteRepo.branches : ["main"]
})

describe("newSessionMachine remote environments", () => {
  it("loads discovery from the selected environment", async () => {
    const deps = remoteDeps()
    const actor = createActor(newSessionMachine, { input: { getDeps: () => deps } }).start()
    actor.send({ type: "OPEN" })
    actor.send({ type: "SET_ENVIRONMENT", environmentId: "device-clive" })
    await waitFor(actor, (state) => state.context.repoPath === remoteRepo.path && state.context.base === "main")
    expect(actor.getSnapshot().context.repos[0]).toMatchObject({
      path: remoteRepo.path,
      githubSlug: "acme/widget"
    })
    actor.stop()
  })

  it("waits for the first capability announcement and selects a remote harness", async () => {
    let attempts = 0
    const deps: NewSessionDeps = {
      ...remoteDeps(),
      defaultCli: "codex",
      loadEnvironmentDiscovery: async () => {
        attempts += 1
        if (attempts < 3) {
          return { version: 1, deviceId: "device-clive", discovery: null, updatedAt: null }
        }
        const ready = await remoteDeps().loadEnvironmentDiscovery!("device-clive")
        return ready
      }
    }
    const actor = createActor(newSessionMachine, { input: { getDeps: () => deps } }).start()
    actor.send({ type: "OPEN" })
    actor.send({ type: "SET_ENVIRONMENT", environmentId: "device-clive" })
    await waitFor(actor, (state) => state.context.repoPath === remoteRepo.path && state.context.base === "main")
    expect(attempts).toBe(3)
    expect(actor.getSnapshot().context.cli).toBe("claude")
    actor.stop()
  })

  it("clears stale repository state when environment changes", async () => {
    const deps = remoteDeps()
    const actor = createActor(newSessionMachine, { input: { getDeps: () => deps } }).start()
    actor.send({ type: "OPEN" })
    await waitFor(actor, (state) => state.context.repoPath === "/repos/widget")
    actor.send({ type: "SET_ENVIRONMENT", environmentId: "device-clive" })
    await waitFor(actor, (state) => state.context.repoPath === remoteRepo.path)
    expect(actor.getSnapshot().context.repoPath).not.toBe("/repos/widget")
    actor.stop()
  })

  it("submits environmentId for blank PR and issue sessions", async () => {
    const blank: CreateSessionInput[] = []
    const prs: CreateSessionFromPrInput[] = []
    const issues: CreateSessionFromIssueInput[] = []
    const deps: NewSessionDeps = {
      ...remoteDeps(blank),
      loadPrs: async () => [],
      loadIssues: async () => [],
      onCreateFromPr: async (input) => { prs.push(input) },
      onCreateFromIssue: async (input) => { issues.push(input) }
    }
    const pr: PrSummary = {
      number: 7, title: "Remote PR", headRefName: "feature", baseRefName: "main",
      author: { login: "octocat", avatarUrl: null }, state: "open", isDraft: false,
      additions: 1, deletions: 0, updatedAt: "2026-08-08T00:00:00.000Z"
    }
    const issue: IssueSummary = {
      number: 8, title: "Remote issue", url: "https://github.test/acme/widget/issues/8",
      body: "Do the work", labels: [], author: { login: "octocat", avatarUrl: null },
      assignees: [], updatedAt: "2026-08-08T00:00:00.000Z"
    }
    const run = async (mode: "blank" | "pr" | "issue") => {
      const actor = createActor(newSessionMachine, { input: { getDeps: () => deps } }).start()
      actor.send({ type: "OPEN" })
      actor.send({ type: "SET_ENVIRONMENT", environmentId: "device-clive" })
      await waitFor(actor, (state) => state.context.base === "main")
      actor.send({ type: "SET_MODE", mode })
      if (mode === "pr") actor.send({ type: "SELECT_PR", pr })
      if (mode === "issue") {
        actor.send({ type: "SELECT_ISSUE", issue })
        actor.send({ type: "ADVANCE" })
      }
      actor.send({ type: "SUBMIT" })
      await waitFor(actor, (state) => state.matches({ submission: "done" }))
      actor.stop()
    }
    await run("blank")
    await run("pr")
    await run("issue")
    expect(blank[0]?.environmentId).toBe("device-clive")
    expect(prs[0]?.environmentId).toBe("device-clive")
    expect(issues[0]?.environmentId).toBe("device-clive")
  })
})
