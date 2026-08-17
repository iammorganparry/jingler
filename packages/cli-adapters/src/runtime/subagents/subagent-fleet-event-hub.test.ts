import { Effect } from "effect"
import { describe, expect, it, vi } from "vitest"
import { makeSubagentFleetEventHub } from "./subagent-fleet-event-hub.js"

describe("SubagentFleetEventHub", () => {
  it("publishes through Effect state and removes boundary subscriptions", async () => {
    const hub = Effect.runSync(makeSubagentFleetEventHub())
    const listener = vi.fn()
    const unsubscribe = Effect.runSync(hub.subscribe(listener))
    const event = { _tag: "Assistant" as const, text: "progress" }

    await Effect.runPromise(hub.publish(event))
    unsubscribe()
    await Effect.runPromise(hub.publish(event))

    expect(listener).toHaveBeenCalledOnce()
  })
})
