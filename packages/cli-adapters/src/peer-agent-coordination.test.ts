import { Effect } from "effect"
import { describe, expect, it, vi } from "vitest"
import { routePeerAgentMessage } from "./peer-agent-coordination.js"

const chats = [
  { id: "a", title: "Agent A" },
  { id: "b", title: "Agent B" },
  { id: "c", title: null }
]

const run = <A>(effect: Effect.Effect<A>) => Effect.runPromise(effect)

describe("routePeerAgentMessage adversarial ownership", () => {
  it.each([
    ["self target", "a", "a", "hello"],
    ["unknown sender", "outside", "b", "hello"],
    ["cross-session or stale target", "a", "outside", "hello"],
    ["empty body", "a", "b", "   "]
  ])("rejects %s without invoking delivery", async (_label, from, to, text) => {
    const deliver = vi.fn(() => Effect.succeed(true))
    await expect(run(routePeerAgentMessage(chats, from, to, text, deliver)))
      .resolves.toEqual({ status: "rejected", targetChatId: to })
    expect(deliver).not.toHaveBeenCalled()
  })

  it("reports an inactive target as unavailable and preserves attribution", async () => {
    const deliver = vi.fn((_target: string, _text: string) => Effect.succeed(false))
    await expect(run(routePeerAgentMessage(chats, "a", "b", "  avoid src/shared.ts  ", deliver)))
      .resolves.toEqual({ status: "unavailable", targetChatId: "b" })
    expect(deliver).toHaveBeenCalledWith(
      "b",
      "[Peer message from Agent A (a)]\navoid src/shared.ts"
    )
  })

  it("routes simultaneous bidirectional sends only to their intended targets", async () => {
    const deliveries: Array<{ target: string; text: string }> = []
    const deliver = (target: string, text: string) =>
      Effect.promise(async () => {
        await Promise.resolve()
        deliveries.push({ target, text })
        return true
      })

    const [toB, toA] = await Promise.all([
      run(routePeerAgentMessage(chats, "a", "b", "A owns src/a.ts", deliver)),
      run(routePeerAgentMessage(chats, "b", "a", "B owns src/b.ts", deliver))
    ])

    expect(toB).toEqual({ status: "delivered", targetChatId: "b" })
    expect(toA).toEqual({ status: "delivered", targetChatId: "a" })
    expect(deliveries).toEqual(expect.arrayContaining([
      { target: "b", text: "[Peer message from Agent A (a)]\nA owns src/a.ts" },
      { target: "a", text: "[Peer message from Agent B (b)]\nB owns src/b.ts" }
    ]))
    expect(deliveries).toHaveLength(2)
  })
})
