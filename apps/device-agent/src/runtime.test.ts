import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { DeviceSessionTasks } from "./runtime.js"

describe("device session task ownership", () => {
  it("interrupts and awaits active session tunnels before daemon shutdown", async () => {
    const sessions = new DeviceSessionTasks()
    let finalized = false
    const running = sessions.run(
      Effect.never.pipe(
        Effect.ensuring(Effect.sync(() => {
          finalized = true
        }))
      )
    )
    const interrupted = expect(running).rejects.toBeDefined()
    await Promise.resolve()
    await sessions.stop()
    await interrupted
    expect(finalized).toBe(true)
  })
})
