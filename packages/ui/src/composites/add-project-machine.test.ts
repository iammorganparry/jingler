import type { Project } from "@jingler/core"
import { createActor, waitFor } from "xstate"
import { describe, expect, it, vi } from "vitest"
import { addProjectMachine } from "./add-project-machine.js"

const project: Project = {
  id: "p-1",
  name: "jingler",
  path: "/repos/jingler",
  availability: "available",
  createdAt: "2026-08-09T00:00:00.000Z",
  updatedAt: "2026-08-09T00:00:00.000Z"
}

describe("addProjectMachine", () => {
  it("keeps project acquisition separate from workspace creation", async () => {
    const register = vi.fn(async () => project)
    const added = vi.fn()
    const actor = createActor(addProjectMachine, {
      input: {
        getDeps: () => ({
          browse: async () => null,
          register,
          createDirectory: async () => project,
          clone: async () => project,
          onAdded: added,
          onClose: vi.fn()
        })
      }
    }).start()

    actor.send({ type: "OPEN" })
    actor.send({ type: "SELECT", method: "existing" })
    actor.send({ type: "SET_PATH", path: "/repos/jingler" })
    actor.send({ type: "SUBMIT" })
    await waitFor(actor, (snapshot) => snapshot.matches("closed"))

    expect(register).toHaveBeenCalledWith({ path: "/repos/jingler" })
    expect(added).toHaveBeenCalledWith(project)
  })
})
