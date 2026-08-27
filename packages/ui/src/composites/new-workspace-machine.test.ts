import type { CreateSessionInput, Environment, Project, ProviderCatalog } from "@jingler/core"
import { ProviderConnectionId, ProviderId, ProviderModelId } from "@jingler/core"
import { Schema } from "effect"
import { createActor, waitFor } from "xstate"
import { describe, expect, it, vi } from "vitest"
import { newWorkspaceMachine, type NewWorkspaceDeps } from "./new-workspace-machine.js"

const projects: ReadonlyArray<Project> = [
  { id: "p-local", name: "local", path: "/repos/local", availability: "available", createdAt: "now", updatedAt: "now" },
  { id: "p-remote", environmentId: "device-1", name: "remote", path: "/repos/remote", availability: "available", createdAt: "now", updatedAt: "now" }
]

const connectionId = Schema.decodeUnknownSync(ProviderConnectionId)("claude-max")
const providerId = Schema.decodeUnknownSync(ProviderId)("anthropic")
const modelId = Schema.decodeUnknownSync(ProviderModelId)("anthropic/claude-sonnet")
const providerCatalog: ProviderCatalog = {
  refreshedAt: "2026-08-10T00:00:00.000Z",
  stale: false,
  connections: [{
    connection: {
      id: connectionId,
      providerId,
      authKind: "claude-setup-token",
      account: null,
      targetId: "local",
      status: "authenticated",
      subscription: {
        entitlement: "active",
        planLabel: "Max",
        expiresAt: null,
        quotaLabel: null,
        rateLimitLabel: null,
        confirmedBillingRoute: "subscription"
      },
      createdAt: "2026-08-10T00:00:00.000Z",
      updatedAt: "2026-08-10T00:00:00.000Z"
    },
    models: [{
      providerId,
      id: modelId,
      label: "Claude Sonnet",
      capabilities: { contextWindow: 200_000, reasoning: [], reasoningCanDisable: true, vision: false },
      verification: "certified",
      selectable: true,
      certificationKey: "certified"
    }, {
      providerId,
      id: Schema.decodeUnknownSync(ProviderModelId)("anthropic/claude-opus"),
      label: "Claude Opus",
      capabilities: { contextWindow: 200_000, reasoning: [], reasoningCanDisable: true, vision: false },
      verification: "certified",
      selectable: true,
      certificationKey: "certified-opus"
    }]
  }]
}

const cloudEnvironment: Environment = {
  kind: "managed",
  id: "cloud",
  name: "Cloud",
  platform: { os: "linux", arch: "x64" },
  state: "online",
  region: "auto",
  instanceType: "basic",
  capabilities: {
    version: 1,
    capabilities: ["session.start"],
    maxConcurrentSessions: 1
  },
  agentVersion: null,
  lastSeenAt: null,
  generation: 1,
  createdAt: 0,
  updatedAt: 0
}

const actorFor = (
  onCreate: NewWorkspaceDeps["onCreate"] = vi.fn(async () => undefined),
  overrides: Partial<NewWorkspaceDeps> = {}
) => createActor(newWorkspaceMachine, {
  input: {
    getDeps: () => ({
      projects,
      providerCatalog,
      defaultConnectionId: connectionId,
      defaultModelId: modelId,
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
  it("starts every model in the configured default mode and falls back to Auto", async () => {
    const fallback = actorFor().start()
    fallback.send({ type: "OPEN", projectId: "p-local" })
    expect(fallback.getSnapshot().context.mode).toBe("auto")
    fallback.stop()

    const configured = actorFor(undefined, { defaultMode: "ask" }).start()
    configured.send({ type: "OPEN", projectId: "p-local" })
    expect(configured.getSnapshot().context.mode).toBe("ask")
    configured.stop()
  })

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

  it("defers owned-host preparation until session creation", async () => {
    const prepareProject = vi.fn(async (projectId: string, environmentId?: string) => {
      const project = projects.find((candidate) => candidate.id === projectId)!
      return environmentId === undefined
        ? project
        : { ...project, environmentId, path: `/remote/${project.name}` }
    })
    const loadBranches = vi.fn(async (_path: string, environmentId?: string) =>
      environmentId === undefined ? ["main", "feature"] : ["remote-only"]
    )
    const onCreate = vi.fn(async (_input: CreateSessionInput) => undefined)
    const actor = actorFor(onCreate, { prepareProject, loadBranches }).start()
    actor.send({ type: "OPEN", projectId: "p-local" })
    await waitFor(actor, (snapshot) => snapshot.matches("editing"))
    prepareProject.mockClear()
    loadBranches.mockClear()
    actor.send({ type: "SET_ENVIRONMENT", environmentId: "device-1" })
    await waitFor(actor, (snapshot) => snapshot.matches("editing"))

    expect(prepareProject).toHaveBeenCalledWith("p-local", undefined)
    expect(loadBranches).toHaveBeenCalledWith("/repos/local", undefined)
    expect(actor.getSnapshot().context).toMatchObject({
      environmentId: "device-1",
      resolvedProject: {
        id: "p-local",
        environmentId: "device-1",
        path: "/repos/local"
      }
    })

    actor.send({ type: "SUBMIT" })
    await waitFor(actor, (snapshot) => snapshot.matches("closed"))
    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({ environmentId: "device-1", repoPath: "/repos/local" }),
      [],
      expect.any(Function)
    )
  })

  it("defers managed workspace provisioning until session creation", async () => {
    const prepareProject = vi.fn(async (projectId: string, environmentId?: string) => {
      const project = projects.find((candidate) => candidate.id === projectId)!
      return environmentId === undefined
        ? project
        : { ...project, environmentId, path: `/remote/${project.name}` }
    })
    const loadBranches = vi.fn(async (_path: string, environmentId?: string) =>
      environmentId === undefined ? ["main", "feature"] : ["remote-only"]
    )
    const onCreate = vi.fn(async (_input: CreateSessionInput) => undefined)
    const actor = actorFor(onCreate, {
      environments: [cloudEnvironment],
      prepareProject,
      loadBranches
    }).start()

    actor.send({ type: "OPEN", projectId: "p-local" })
    await waitFor(actor, (snapshot) => snapshot.matches("editing"))
    prepareProject.mockClear()
    loadBranches.mockClear()

    actor.send({ type: "SET_ENVIRONMENT", environmentId: "cloud" })
    await waitFor(actor, (snapshot) => snapshot.matches("editing"))

    expect(prepareProject).toHaveBeenCalledWith("p-local", undefined)
    expect(loadBranches).toHaveBeenCalledWith("/repos/local", undefined)
    expect(actor.getSnapshot().context).toMatchObject({
      environmentId: "cloud",
      baseBranch: "main",
      resolvedProject: { id: "p-local", path: "/repos/local", environmentId: "cloud" }
    })

    actor.send({ type: "SET_DRAFT", draft: "Run in Cloud" })
    actor.send({ type: "SUBMIT" })
    await waitFor(actor, (snapshot) => snapshot.matches("closed"))
    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({ environmentId: "cloud", repoPath: "/repos/local" }),
      [],
      expect.any(Function)
    )
  })

  it("tracks backend cloud provisioning milestones until creation completes", async () => {
    let finish: (() => void) | undefined
    const onCreate: NewWorkspaceDeps["onCreate"] = vi.fn(async (
      _input: CreateSessionInput,
      _images,
      onProgress?: (phase: "checking-access" | "resolving-repository" | "starting-sandbox" | "creating-session" | "ready") => void
    ) => {
      onProgress?.("resolving-repository")
      await new Promise<void>((resolve) => { finish = resolve })
      onProgress?.("starting-sandbox")
      onProgress?.("creating-session")
      onProgress?.("ready")
    })
    const actor = actorFor(onCreate, { environments: [cloudEnvironment] }).start()

    actor.send({ type: "OPEN", projectId: "p-local" })
    await waitFor(actor, (snapshot) => snapshot.matches("editing"))
    actor.send({ type: "SET_ENVIRONMENT", environmentId: "cloud" })
    await waitFor(actor, (snapshot) => snapshot.matches("editing"))
    actor.send({ type: "SUBMIT" })
    await waitFor(actor, (snapshot) => snapshot.context.provisioningPhase === "resolving-repository")
    expect(actor.getSnapshot().matches("submitting")).toBe(true)

    finish?.()
    await waitFor(actor, (snapshot) => snapshot.matches("closed"))
    expect(onCreate).toHaveBeenCalledOnce()
  })

  it("can switch back to local without beginning remote preparation", async () => {
    const prepareProject = vi.fn(async (projectId: string, environmentId?: string) => {
      const project = projects.find((candidate) => candidate.id === projectId)!
      return environmentId === undefined
        ? project
        : { ...project, environmentId, path: `/remote/${project.name}` }
    })
    const actor = createActor(newWorkspaceMachine, {
      input: {
        getDeps: () => ({
          projects,
          providerCatalog,
          defaultConnectionId: connectionId,
          defaultModelId: modelId,
          prepareProject,
          loadBranches: async () => ["main"],
          onCreate: async () => undefined,
          onClose: vi.fn()
        })
      }
    }).start()

    actor.send({ type: "OPEN", projectId: "p-local" })
    await waitFor(actor, (snapshot) => snapshot.matches("editing"))
    actor.send({ type: "SET_ENVIRONMENT", environmentId: "device-1" })
    await waitFor(actor, (snapshot) => snapshot.matches("editing"))
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
    expect(prepareProject).not.toHaveBeenCalledWith("p-local", "device-1")
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
    }), [], expect.any(Function))
  })

  it("submits the certified provider connection without a legacy harness", async () => {
    const onCreate = vi.fn(async (_input: CreateSessionInput) => undefined)
    const actor = actorFor(onCreate, {
      providerCatalog,
      defaultConnectionId: connectionId,
      defaultModelId: modelId
    }).start()
    actor.send({ type: "OPEN", projectId: "p-local" })
    await waitFor(actor, (snapshot) => snapshot.matches("editing"))
    actor.send({ type: "SUBMIT" })
    await waitFor(actor, (snapshot) => snapshot.matches("closed"))

    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({
      connectionId,
      providerId,
      modelId
    }), [], expect.any(Function))
    const input = onCreate.mock.calls[0]?.[0]
    expect(input).not.toHaveProperty("cli")
    expect(input).not.toHaveProperty("model")
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
      connectionId,
      modelId
    }), [], expect.any(Function))
    expect(onCreate.mock.calls[0]?.[0]).not.toHaveProperty("title")
  })

  it("persists an explicitly selected certified model", async () => {
    const onCreate = vi.fn(async (_input: CreateSessionInput) => undefined)
    const actor = actorFor(onCreate).start()
    actor.send({ type: "OPEN", projectId: "p-local" })
    await waitFor(actor, (snapshot) => snapshot.matches("editing"))
    actor.send({ type: "SET_REASONING", reasoning: { enabled: true, effort: "high" } })
    const opusId = Schema.decodeUnknownSync(ProviderModelId)("anthropic/claude-opus")
    actor.send({ type: "SET_MODEL", connectionId, providerId, modelId: opusId })
    expect(actor.getSnapshot().context.reasoning).toBeUndefined()
    actor.send({ type: "SUBMIT" })
    await waitFor(actor, (snapshot) => snapshot.matches("closed"))

    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({
      connectionId,
      providerId,
      modelId: opusId
    }), [], expect.any(Function))
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
    }), [], expect.any(Function))
  })

  it("opens preselected to a requested pull request", async () => {
    const pr = {
      number: 42,
      title: "Restore session sources",
      headRefName: "feat/session-sources",
      baseRefName: "develop",
      author: { login: "morgan", avatarUrl: null },
      state: "open" as const,
      isDraft: false,
      additions: 12,
      deletions: 3,
      updatedAt: "2026-08-10T00:00:00.000Z"
    }
    const onCreateFromPr = vi.fn(async () => undefined)
    const actor = actorFor(undefined, { onCreateFromPr }).start()

    actor.send({ type: "OPEN", projectId: "p-local", pr })
    await waitFor(actor, (snapshot) => snapshot.matches("editing"))

    expect(actor.getSnapshot().context).toMatchObject({
      projectId: "p-local",
      source: "pr",
      selectedPr: pr,
      pullRequests: [pr],
      baseBranch: "develop"
    })
    actor.send({ type: "SUBMIT" })
    await waitFor(actor, (snapshot) => snapshot.matches("closed"))
    expect(onCreateFromPr).toHaveBeenCalledWith(
      expect.objectContaining({ pr, repoPath: "/repos/local" }),
      [],
      expect.any(Function)
    )
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
      connectionId,
      providerId,
      modelId,
      mode: "auto"
    }), [], expect.any(Function))
  })
})
