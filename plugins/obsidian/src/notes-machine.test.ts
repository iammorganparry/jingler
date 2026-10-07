import { createActor, waitFor } from "xstate"
import { expect, it, vi } from "vitest"
import { notesMachine, type NotesServices } from "./notes-machine.js"

it("loads persisted configuration, browses, refreshes, and saves through invoked actors", async () => {
  const services: NotesServices = {
    configuration: async () => "/vault",
    configure: vi.fn(async (root) => root),
    list: async () => ["one.md", "two.md"],
    read: async (path) => ({ path, content: path, revision: "rev" })
  }
  const actor = createActor(notesMachine, { input: { services } }).start()
  await waitFor(actor, (s) => s.matches("ready"))
  expect(actor.getSnapshot().context.note?.path).toBe("one.md")
  actor.send({ type: "SELECT", path: "two.md" })
  await waitFor(actor, (s) => s.matches("ready"))
  expect(actor.getSnapshot().context.note?.path).toBe("two.md")
  actor.send({ type: "REFRESH" })
  await waitFor(actor, (s) => s.matches("ready"))
  expect(actor.getSnapshot().context.note?.path).toBe("two.md")
  actor.send({ type: "ROOT", value: "/other" }); actor.send({ type: "SAVE" })
  await waitFor(actor, (s) => s.matches("ready"))
  expect(services.configure).toHaveBeenCalledWith("/other")
  actor.stop()
})

it("surfaces invalid configuration and permits recovery", async () => {
  const services: NotesServices = {
    configuration: async () => { throw new Error("Invalid vault") },
    configure: async (root) => root, list: async () => [], read: vi.fn()
  }
  const actor = createActor(notesMachine, { input: { services } }).start()
  await waitFor(actor, (s) => s.matches("ready"))
  expect(actor.getSnapshot().context.error).toBe("Invalid vault")
  actor.send({ type: "ROOT", value: "/valid" }); actor.send({ type: "SAVE" })
  await waitFor(actor, (s) => s.matches("ready"))
  expect(actor.getSnapshot().context.error).toBe("")
  actor.stop()
})
