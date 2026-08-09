import type { Project } from "@jingler/core"
import { createActor, waitFor } from "xstate"
import { describe, expect, it, vi } from "vitest"
import { newWorkspaceMachine } from "./new-workspace-machine.js"

const projects: ReadonlyArray<Project> = [
  { id: "p-local", name: "local", path: "/repos/local", availability: "available", createdAt: "now", updatedAt: "now" },
  { id: "p-remote", environmentId: "device-1", name: "remote", path: "/repos/remote", availability: "available", createdAt: "now", updatedAt: "now" }
]

const actorFor = () => createActor(newWorkspaceMachine, {
  input: {
    getDeps: () => ({
      projects,
      clis: [{ kind: "codex", label: "Codex", available: true, binPath: "/bin/codex", version: null, authStatus: "authenticated" }],
      defaultCli: "codex",
      prepareProject: async (projectId, environmentId) => {
        const project = projects.find((candidate) => candidate.id === projectId)!
        return environmentId === undefined
          ? project
          : { ...project, id: `${project.id}-${environmentId}`, environmentId, path: `/remote/${project.name}` }
      },
      loadBranches: async (path) => path.endsWith("remote") ? ["develop"] : ["main", "feature"],
      onCreate: vi.fn(async () => undefined),
      onClose: vi.fn()
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
})
