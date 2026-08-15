import type { OffloadComputeSettings } from "@jingler/core"
import { createActor } from "xstate"
import { describe, expect, it, vi } from "vitest"
import { createOffloadSettingsMachine } from "./offload-settings-machine.js"

const enabled = { enabled: true, explicitCommands: [] } as const
const disabled = { enabled: false, explicitCommands: [] } as const

const waitFor = async (predicate: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error("Machine did not settle")
}

describe("Offload Compute settings lifecycle", () => {
  it("shows priming while persistence and asynchronous admission start", async () => {
    let resolve!: (settings: typeof enabled) => void
    const save = vi.fn(() => new Promise<typeof enabled>((done) => { resolve = done }))
    const actor = createActor(createOffloadSettingsMachine({ save })).start()
    actor.send({ type: "SET", settings: enabled })
    expect(actor.getSnapshot().matches("saving")).toBe(true)
    expect(actor.getSnapshot().context.settings.enabled).toBe(true)
    resolve(enabled)
    await waitFor(() => actor.getSnapshot().matches("idle"))
    expect(save).toHaveBeenCalledWith(enabled)
    actor.stop()
  })

  it("queues the latest toggle while a save is in progress", async () => {
    const resolvers: Array<(settings: OffloadComputeSettings) => void> = []
    const save = vi.fn((settings: OffloadComputeSettings) =>
      new Promise<OffloadComputeSettings>((resolve) => resolvers.push(resolve))
    )
    const actor = createActor(createOffloadSettingsMachine({ save })).start()
    actor.send({ type: "SET", settings: enabled })
    actor.send({ type: "SET", settings: disabled })
    expect(actor.getSnapshot().context.settings.enabled).toBe(false)
    resolvers[0]?.(enabled)
    await waitFor(() => save.mock.calls.length === 2)
    expect(save.mock.calls[1]?.[0]).toEqual(disabled)
    resolvers[1]?.(disabled)
    await waitFor(() => actor.getSnapshot().matches("idle"))
    expect(actor.getSnapshot().context.settings.enabled).toBe(false)
    actor.stop()
  })

  it("retains an explicit failure instead of silently reverting", async () => {
    const actor = createActor(createOffloadSettingsMachine({
      save: async () => { throw new Error("Primer unavailable") }
    })).start()
    actor.send({ type: "SET", settings: enabled })
    await waitFor(() => actor.getSnapshot().matches("failed"))
    expect(actor.getSnapshot().context.error).toBe("Primer unavailable")
    expect(actor.getSnapshot().context.settings.enabled).toBe(true)
    actor.stop()
  })
})
