import { describe, expect, it, vi } from "vitest"
import { createActor } from "xstate"
import { mcpImportMachine } from "./mcp-import-machine.js"
import type { McpImportCandidateView } from "./mcp-config.js"

const CANDIDATE: McpImportCandidateView = {
  name: "linear",
  source: "claude",
  origin: "user",
  target: "https://linear.example/mcp",
  problem: null,
  needsSignIn: false,
  needsSecrets: false
}

describe("mcpImportMachine", () => {
  it("goes idle -> detecting -> reviewing on a successful detect", () => {
    const detect = vi.fn(async () => [CANDIDATE])
    const apply = vi.fn(async () => {})
    const actor = createActor(mcpImportMachine, { input: { detect, apply } }).start()
    actor.send({ type: "START" })
    return vi.waitFor(() => expect(actor.getSnapshot().value).toBe("reviewing"))
  })

  it("detect failure -> detectFailed -> RETRY -> reviewing", async () => {
    let attempt = 0
    const detect = vi.fn(async () => {
      attempt += 1
      if (attempt === 1) throw new Error("offline")
      return [CANDIDATE]
    })
    const apply = vi.fn(async () => {})
    const actor = createActor(mcpImportMachine, { input: { detect, apply } }).start()
    actor.send({ type: "START" })
    await vi.waitFor(() => expect(actor.getSnapshot().value).toBe("detectFailed"))
    expect(actor.getSnapshot().context.error).toBe("offline")
    actor.send({ type: "RETRY" })
    await vi.waitFor(() => expect(actor.getSnapshot().value).toBe("reviewing"))
  })

  it("import failure -> importFailed -> RETRY -> done", async () => {
    let attempt = 0
    const detect = vi.fn(async () => [CANDIDATE])
    const apply = vi.fn(async () => {
      attempt += 1
      if (attempt === 1) throw new Error("server unreachable")
    })
    const actor = createActor(mcpImportMachine, { input: { detect, apply } }).start()
    actor.send({ type: "START" })
    await vi.waitFor(() => expect(actor.getSnapshot().value).toBe("reviewing"))
    actor.send({ type: "IMPORT" })
    await vi.waitFor(() => expect(actor.getSnapshot().value).toBe("importFailed"))
    expect(actor.getSnapshot().context.error).toBe("server unreachable")
    actor.send({ type: "RETRY" })
    await vi.waitFor(() => expect(actor.getSnapshot().value).toBe("done"))
    expect(apply).toHaveBeenCalledTimes(2)
  })

  it("goes to empty when nothing is found, and dismissed on DISMISS", async () => {
    const detect = vi.fn(async () => [])
    const apply = vi.fn(async () => {})
    const empty = createActor(mcpImportMachine, { input: { detect, apply } }).start()
    empty.send({ type: "START" })
    await vi.waitFor(() => expect(empty.getSnapshot().value).toBe("empty"))

    const dismissable = createActor(mcpImportMachine, {
      input: { detect: async () => [CANDIDATE], apply }
    }).start()
    dismissable.send({ type: "START" })
    await vi.waitFor(() => expect(dismissable.getSnapshot().value).toBe("reviewing"))
    dismissable.send({ type: "DISMISS" })
    expect(dismissable.getSnapshot().value).toBe("dismissed")
  })
})
