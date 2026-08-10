import type { CreateSessionInput, HarnessCapability, Project } from "@jingler/core"
import { createActor, waitFor } from "xstate"
import { describe, expect, it, vi } from "vitest"
import { newWorkspaceMachine, type NewWorkspaceDeps } from "./new-workspace-machine.js"

const projects: ReadonlyArray<Project> = [
  { id: "p-local", name: "local", path: "/repos/local", availability: "available", createdAt: "now", updatedAt: "now" },
  { id: "p-remote", environmentId: "device-1", name: "remote", path: "/repos/remote", availability: "available", createdAt: "now", updatedAt: "now" }
]

const capabilities: ReadonlyArray<HarnessCapability> = [
  {
    cli: "codex",
    label: "Codex CLI",
    modes: [{ id: "auto", label: "Auto", kind: "execute" }],
    models: [
      { id: "gpt-5.6-sol", label: "gpt-5.6-sol" },
      { id: "gpt-5.6-luna", label: "gpt-5.6-luna" }
    ]
  }
]

const actorFor = (
  onCreate: (input: CreateSessionInput) => Promise<void> = vi.fn(async () => undefined),
  overrides: Partial<NewWorkspaceDeps> = {}
) => createActor(newWorkspaceMachine, {
  input: {
    getDeps: () => ({
      projects,
      clis: [{ kind: "codex", label: "Codex", available: true, binPath: "/bin/codex", version: null, authStatus: "authenticated" }],
      capabilities,
      defaultCli: "codex",
      defaultModel: "gpt-5.6-sol",
      providers: {
        codex: { enabled: true, defaultMode: "auto", reasoningEffort: "minimal" }
      },
      prepareProject: async (projectId, environmentId) => {
        const project = projects.find((candidate) => candidate.id === projectId)!
        return environmentId === undefined
          ? project
          : { ...project, id: `${project.id}-${environmentId}`, environmentId, path: `/remote/${project.name}` }
      },
      loadBranches: async (path) => path.endsWith("remote") ? ["develop"] : ["main", "feature"],
      onCreate,
      onClose: vi.fn(),
      ...overrides
    })
  }
})

describe("newWorkspaceMachine", () => {
  it("resets incompatible checkout selections when the project changes", async () => {
    const actor = actorFor().start()
    actor.send({ type: "OPEN", projectId: "p-local" })
    await waitFor(actor, (snapshot) => snapshot.matches("editing"))
    actor.send({ type: "SET_BASE", baseBranch: "feature" })
    actor.send({ type: "SET_PROJECT", projectId: "p-remote" })
    expect(actor.getSnapshot().context.baseBranch).toBe("")
    await waitFor(actor, (snapshot) => snapshot.matches("editing"))
    expect(actor.getSnapshot().context).toMatchObject({
      projectId: "p-remote",
      baseBranch: "develop",
      branches: ["develop"]
    })
  })

  it("updates project environment branch and submission state in one transition", async () => {
    const actor = actorFor().start()
    actor.send({ type: "OPEN", projectId: "p-remote" })
    await waitFor(actor, (snapshot) => snapshot.matches("editing"))
    actor.send({ type: "SET_ISOLATION", isolation: "direct" })
    actor.send({ type: "SET_DRAFT", draft: "Run the tests" })
    expect(actor.getSnapshot().context).toMatchObject({
      projectId: "p-remote",
      isolation: "direct",
      baseBranch: "develop",
      draft: "Run the tests"
    })
  })

  it("prepares a local project on a remote host before loading its branches", async () => {
    const actor = actorFor().start()
    actor.send({ type: "OPEN", projectId: "p-local" })
    await waitFor(actor, (snapshot) => snapshot.matches("editing"))
    actor.send({ type: "SET_ENVIRONMENT", environmentId: "device-1" })
    await waitFor(actor, (snapshot) => snapshot.matches("editing"))

    expect(actor.getSnapshot().context).toMatchObject({
      environmentId: "device-1",
      resolvedProject: {
        id: "p-local-device-1",
        environmentId: "device-1",
        path: "/remote/local"
      }
    })
  })

  it("can switch back to local while remote preparation is still pending", async () => {
    let releaseRemote: (() => void) | undefined
    const actor = createActor(newWorkspaceMachine, {
      input: {
        getDeps: () => ({
          projects,
          clis: [{ kind: "codex", label: "Codex", available: true, binPath: "/bin/codex", version: null, authStatus: "authenticated" }],
          capabilities,
          defaultCli: "codex",
          defaultModel: "gpt-5.6-sol",
          prepareProject: async (projectId, environmentId) => {
            const project = projects.find((candidate) => candidate.id === projectId)!
            if (environmentId !== undefined) {
              await new Promise<void>((resolve) => { releaseRemote = resolve })
              return { ...project, environmentId, path: `/remote/${project.name}` }
            }
            return project
          },
          loadBranches: async () => ["main"],
          onCreate: async () => undefined,
          onClose: vi.fn()
        })
      }
    }).start()

    actor.send({ type: "OPEN", projectId: "p-local" })
    await waitFor(actor, (snapshot) => snapshot.matches("editing"))
    actor.send({ type: "SET_ENVIRONMENT", environmentId: "device-1" })
    expect(actor.getSnapshot().matches("loading")).toBe(true)
    actor.send({ type: "SET_MODE", mode: "ask" })
    actor.send({ type: "SET_REASONING", reasoning: { enabled: true, effort: "high" } })
    actor.send({ type: "SET_ENVIRONMENT", environmentId: "local" })
    await waitFor(actor, (snapshot) => snapshot.matches("editing"))

    expect(actor.getSnapshot().context).toMatchObject({
      environmentId: "local",
      baseBranch: "main",
      mode: "ask",
      reasoning: { enabled: true, effort: "high" },
      resolvedProject: { id: "p-local", path: "/repos/local" }
    })
    releaseRemote?.()
  })

  it("submits selected mode and reasoning with the new session", async () => {
    const onCreate = vi.fn(async (_input: CreateSessionInput) => undefined)
    const actor = actorFor(onCreate).start()
    actor.send({ type: "OPEN", projectId: "p-local" })
    await waitFor(actor, (snapshot) => snapshot.matches("editing"))
    actor.send({ type: "SET_MODE", mode: "ask" })
    actor.send({ type: "SET_REASONING", reasoning: { enabled: true, effort: "high" } })
    actor.send({ type: "SUBMIT" })
    await waitFor(actor, (snapshot) => snapshot.matches("closed"))

    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({
      mode: "ask",
      reasoning: { enabled: true, effort: "high" }
    }), [])
  })

  it("leaves naming to automatic title generation", async () => {
    const onCreate = vi.fn(async (_input: CreateSessionInput) => undefined)
    const actor = actorFor(onCreate).start()
    actor.send({ type: "OPEN", projectId: "p-local" })
    await waitFor(actor, (snapshot) => snapshot.matches("editing"))
    actor.send({ type: "SET_DRAFT", draft: "Refine the empty-state transitions" })
    actor.send({ type: "SUBMIT" })
    await waitFor(actor, (snapshot) => snapshot.matches("closed"))

    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({
      initialPrompt: "Refine the empty-state transitions",
      model: "gpt-5.6-sol"
    }), [])
    expect(onCreate.mock.calls[0]?.[0]).not.toHaveProperty("title")
  })

  it("persists an explicitly selected harness model", async () => {
    const onCreate = vi.fn(async (_input: CreateSessionInput) => undefined)
    const actor = actorFor(onCreate).start()
    actor.send({ type: "OPEN", projectId: "p-local" })
    await waitFor(actor, (snapshot) => snapshot.matches("editing"))
    actor.send({ type: "SET_HARNESS", cli: "codex", model: "gpt-5.6-luna" })
    actor.send({ type: "SUBMIT" })
    await waitFor(actor, (snapshot) => snapshot.matches("closed"))

    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({
      cli: "codex",
      model: "gpt-5.6-luna"
    }), [])
  })

  it("continues an existing branch without requesting a replacement task branch", async () => {
    const onCreate = vi.fn(async (_input: CreateSessionInput) => undefined)
    const actor = actorFor(onCreate).start()
    actor.send({ type: "OPEN", projectId: "p-local" })
    await waitFor(actor, (snapshot) => snapshot.matches("editing"))
    actor.send({ type: "SET_SOURCE", source: "branch" })
    actor.send({ type: "SET_BASE", baseBranch: "feature" })
    actor.send({ type: "SUBMIT" })
    await waitFor(actor, (snapshot) => snapshot.matches("closed"))

    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({
      baseBranch: "feature",
      continueBranch: true
    }), [])
  })

  it("loads and submits a selected pull request with composer settings", async () => {
    const pr = {
      number: 42,
      title: "Restore session sources",
      headRefName: "feat/session-sources",
      baseRefName: "main",
      author: { login: "morgan", avatarUrl: null },
      state: "open" as const,
      isDraft: false,
      additions: 12,
      deletions: 3,
      updatedAt: "2026-08-10T00:00:00.000Z"
    }
    const onCreateFromPr = vi.fn(async () => undefined)
    const actor = actorFor(undefined, {
      loadPullRequests: async () => [pr],
      onCreateFromPr
    }).start()
    actor.send({ type: "OPEN", projectId: "p-local" })
    await waitFor(actor, (snapshot) => snapshot.matches("editing"))
    actor.send({ type: "SET_SOURCE", source: "pr" })
    await waitFor(actor, (snapshot) => snapshot.matches("editing") && snapshot.context.pullRequests.length === 1)
    actor.send({ type: "SELECT_PR", pr })
    actor.send({ type: "SET_DRAFT", draft: "Review the failing checks" })
    actor.send({ type: "SUBMIT" })
    await waitFor(actor, (snapshot) => snapshot.matches("closed"))

    expect(onCreateFromPr).toHaveBeenCalledWith(expect.objectContaining({
      pr,
      initialPrompt: "Review the failing checks",
      model: "gpt-5.6-sol",
      mode: "auto"
    }), [])
  })
})
