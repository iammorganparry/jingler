import type { RemoteSessionCommand } from "@jingler/core"
import { describe, expect, it } from "vitest"
import {
  MAX_COMMANDS,
  MAX_EVENTS_PER_COMMAND,
  ManagedSessionJournal
} from "./session-journal.js"

const command = (commandId = "command_1"): RemoteSessionCommand => ({
  version: 1,
  commandId,
  sessionId: "session_1",
  operation: "ManagedRuntime.exec",
  payload: { command: "printf ready" }
})

describe("managed session runtime", () => {
  it("streams ordered shared session events from a managed sandbox", () => {
    const journal = new ManagedSessionJournal()
    journal.admit(command())
    journal.append("command_1", {
      kind: "event",
      payload: { type: "runtime.output", data: "rea" }
    })
    journal.append("command_1", {
      kind: "event",
      payload: { type: "runtime.output", data: "dy" }
    })
    journal.settle("command_1", "complete", { exitCode: 0 })
    expect(journal.replay("command_1").map((event) => event.eventSequence)).toEqual([
      0, 1, 2
    ])
    expect(journal.replay("command_1").at(-1)?.kind).toBe("complete")
  })

  it("replays managed session events after reconnect without duplication", () => {
    const journal = new ManagedSessionJournal()
    journal.admit(command())
    journal.append("command_1", { kind: "event", payload: "first" })
    journal.append("command_1", { kind: "event", payload: "second" })
    const restored = new ManagedSessionJournal(journal.snapshot())
    expect(restored.admit(command())).toBe("replay")
    expect(restored.replay("command_1", 0).map((event) => event.payload)).toEqual([
      "second"
    ])
  })

  it("cancellation emits a terminal shared session event", () => {
    const journal = new ManagedSessionJournal()
    journal.admit(command())
    journal.settle("command_1", "cancelled", { reason: "cancelled" })
    expect(journal.replay("command_1")).toEqual([
      expect.objectContaining({ kind: "failed", payload: { reason: "cancelled" } })
    ])
  })

  it("keeps Durable Object command and replay growth explicitly bounded", () => {
    expect(MAX_COMMANDS).toBe(256)
    expect(MAX_EVENTS_PER_COMMAND).toBe(4_096)
  })

  it("evicts the oldest settled command instead of bricking a long session", () => {
    const journal = new ManagedSessionJournal()
    for (let index = 0; index < MAX_COMMANDS; index += 1) {
      const commandId = `command_${index}`
      journal.admit(command(commandId))
      journal.settle(commandId, "complete", { exitCode: 0 })
    }

    expect(journal.admit(command("command_next"))).toBe("started")
    expect(journal.replay("command_0")).toEqual([])
    expect(journal.snapshot().commands).toHaveProperty("command_next")
  })
})
