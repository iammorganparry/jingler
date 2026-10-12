import { describe, test, expect, beforeEach, afterEach } from "vitest"
import { createActor } from "xstate"
import { explorerViewMachine } from "./explorer-view-machine.js"

describe("explorerViewMachine", () => {
  let storage: Map<string, string>

  beforeEach(() => {
    storage = new Map()
    globalThis.localStorage = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
      clear: () => storage.clear(),
      key: () => null,
      length: 0
    }
  })

  afterEach(() => {
    // @ts-expect-error cleanup
    delete globalThis.localStorage
  })

  test("toggle mode", () => {
    const actor = createActor(explorerViewMachine).start()
    expect(actor.getSnapshot().context.mode).toBe("sessions")

    actor.send({ type: "TOGGLE_MODE" })
    expect(actor.getSnapshot().context.mode).toBe("explorer")

    actor.send({ type: "TOGGLE_MODE" })
    expect(actor.getSnapshot().context.mode).toBe("sessions")

    actor.stop()
  })

  test("filter remembered per project and restored on SET_PROJECT", () => {
    const actor = createActor(explorerViewMachine).start()

    actor.send({ type: "SET_PROJECT", path: "/proj-a" })
    actor.send({ type: "SET_FILTER", filter: "local" })
    expect(actor.getSnapshot().context.filter).toBe("local")

    actor.send({ type: "SET_PROJECT", path: "/proj-b" })
    actor.send({ type: "SET_FILTER", filter: "pr" })
    expect(actor.getSnapshot().context.filter).toBe("pr")

    actor.send({ type: "SET_PROJECT", path: "/proj-a" })
    expect(actor.getSnapshot().context.filter).toBe("local")

    actor.send({ type: "SET_PROJECT", path: "/proj-b" })
    expect(actor.getSnapshot().context.filter).toBe("pr")

    actor.stop()
  })

  test("persisted state survives a fresh actor (restart)", () => {
    const actor1 = createActor(explorerViewMachine).start()
    actor1.send({ type: "SET_MODE", mode: "explorer" })
    actor1.send({ type: "SET_PROJECT", path: "/proj-x" })
    actor1.send({ type: "SET_FILTER", filter: "pr" })
    actor1.stop()

    const actor2 = createActor(explorerViewMachine).start()
    expect(actor2.getSnapshot().context.mode).toBe("explorer")
    expect(actor2.getSnapshot().context.projectMemory.get("/proj-x")).toBe("pr")

    actor2.send({ type: "SET_PROJECT", path: "/proj-x" })
    expect(actor2.getSnapshot().context.filter).toBe("pr")
    actor2.stop()
  })

  test("REVEAL_CHANGES lands on explorer + local", () => {
    const actor = createActor(explorerViewMachine).start()
    expect(actor.getSnapshot().context.mode).toBe("sessions")
    expect(actor.getSnapshot().context.filter).toBe("all")

    actor.send({ type: "REVEAL_CHANGES" })
    expect(actor.getSnapshot().context.mode).toBe("explorer")
    expect(actor.getSnapshot().context.filter).toBe("local")

    actor.stop()
  })

  test("REVEAL_CHANGES prefers remembered pr filter", () => {
    const actor = createActor(explorerViewMachine).start()
    actor.send({ type: "SET_PROJECT", path: "/proj-pr" })
    actor.send({ type: "SET_FILTER", filter: "pr" })
    actor.send({ type: "TOGGLE_MODE" })

    expect(actor.getSnapshot().context.mode).toBe("explorer")
    actor.send({ type: "REVEAL_CHANGES" })
    expect(actor.getSnapshot().context.mode).toBe("explorer")
    expect(actor.getSnapshot().context.filter).toBe("pr")

    actor.stop()
  })
})
