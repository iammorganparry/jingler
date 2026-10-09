import { createActor, waitFor } from "xstate"
import { expect, it, vi } from "vitest"
import { notesMachine, type NotesServices } from "./notes-machine.js"

it("loads persisted configuration, browses, refreshes, and saves through invoked actors", async () => {
  const services: NotesServices = {
    configuration: async () => "/vault",
    configure: vi.fn(async (root) => root),
    list: vi.fn(async () => ["one.md", "two.md"]),
    read: async (path) => ({ path, content: path, revision: "rev" })
  }
  const actor = createActor(notesMachine, { input: { services } }).start()
  await waitFor(actor, (s) => s.matches("ready"))
  expect(actor.getSnapshot().context.note?.path).toBe("one.md")
  actor.send({ type: "SELECT", path: "two.md" })
  await waitFor(actor, (s) => s.matches("ready"))
  expect(actor.getSnapshot().context.note?.path).toBe("two.md")
  expect(services.list).toHaveBeenCalledTimes(1)
  actor.send({ type: "REFRESH" })
  await waitFor(actor, (s) => s.matches("ready"))
  expect(actor.getSnapshot().context.note?.path).toBe("two.md")
  actor.send({ type: "ROOT", value: "/other" }); actor.send({ type: "SAVE" })
  await waitFor(actor, (s) => s.matches("ready"))
  expect(services.configure).toHaveBeenCalledWith("/other")
  expect(services.list).toHaveBeenCalledTimes(3)
  actor.stop()
})

it("keeps the note list when one preview cannot be read", async () => {
  const services: NotesServices = {
    configuration: async () => "/vault", configure: async (root) => root,
    list: async () => ["large.md", "small.md"],
    read: async (path) => {
      if (path === "large.md") throw new Error("Note is too large.")
      return { path, content: "Readable", revision: "rev" }
    }
  }
  const actor = createActor(notesMachine, { input: { services } }).start()
  await waitFor(actor, (s) => s.matches("ready"))
  expect(actor.getSnapshot().context.paths).toEqual(["large.md", "small.md"])
  expect(actor.getSnapshot().context.error).toBe("Note is too large.")
  actor.send({ type: "SELECT", path: "small.md" })
  await waitFor(actor, (s) => s.matches("ready"))
  expect(actor.getSnapshot().context.note?.content).toBe("Readable")
  actor.send({ type: "SELECT", path: "large.md" })
  await waitFor(actor, (s) => s.matches("ready"))
  expect(actor.getSnapshot().context.paths).toEqual(["large.md", "small.md"])
  expect(actor.getSnapshot().context.note).toBeNull()
  expect(actor.getSnapshot().context.error).toBe("Note is too large.")
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

it("discovers choices without configuring until explicitly saved", async () => {
  const services: NotesServices = {
    discover: async () => [{ name: "Notes", path: "/notes" }],
    configuration: async () => "", configure: vi.fn(async (root) => root),
    list: async () => [], read: vi.fn()
  }
  const actor = createActor(notesMachine, { input: { services } }).start()
  await waitFor(actor, (s) => s.matches("ready") && s.context.vaults.length === 1)
  expect(actor.getSnapshot().context.vaults).toHaveLength(1)
  expect(actor.getSnapshot().context.root).toBe("")
  actor.send({ type: "ROOT", value: "/notes" })
  expect(services.configure).not.toHaveBeenCalled()
  actor.send({ type: "SAVE" })
  await waitFor(actor, (s) => s.matches("ready"))
  expect(services.configure).toHaveBeenCalledWith("/notes")
  actor.stop()
})

it("opens saved notes and allows manual setup while discovery never resolves", async () => {
  const discover = () => new Promise<never>(() => {})
  const services: NotesServices = {
    discover,
    configuration: async () => "/saved", configure: vi.fn(async (root) => root),
    list: async () => ["saved.md"],
    read: async (path) => ({ path, content: "Saved note", revision: "rev" })
  }
  const actor = createActor(notesMachine, { input: { services } }).start()
  await waitFor(actor, (s) => s.matches("ready"))
  expect(actor.getSnapshot().context.note?.content).toBe("Saved note")
  actor.send({ type: "ROOT", value: "/new" }); actor.send({ type: "SAVE" })
  await waitFor(actor, (s) => s.matches("ready"))
  expect(services.configure).toHaveBeenCalledWith("/new")
  actor.stop()
})

it("allows manual configuration when discovery fails", async () => {
  const actor = createActor(notesMachine, { input: { services: {
    discover: async () => { throw new Error("private metadata unavailable") },
    configuration: async () => "", configure: async (root) => root,
    list: async () => [], read: vi.fn()
  } } }).start()
  await waitFor(actor, (s) => s.matches("ready"))
  expect(actor.getSnapshot().context.vaults).toEqual([])
  expect(actor.getSnapshot().context.error).toBe("")
  actor.stop()
})
