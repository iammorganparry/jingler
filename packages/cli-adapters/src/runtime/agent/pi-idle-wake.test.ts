import { describe, expect, it, vi } from "vitest"
import { agentWakes, routeIdleTurnsToChat } from "./pi-idle-wake.js"

const fakeSession = (streaming: boolean) => {
  const calls: Array<{ triggerTurn?: boolean; deliverAs?: string } | undefined> = []
  const session = {
    isStreaming: streaming,
    sendCustomMessage: async (
      _message: { customType: string; content: string; display: boolean },
      options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" }
    ) => {
      calls.push(options)
    }
  }
  return { session, calls }
}

const message = { customType: "subagent-notify", content: "done", display: true }

describe("idle Pi turn routing", () => {
  it("persists an idle triggerTurn message without a hidden turn, then wakes the chat", async () => {
    const { session, calls } = fakeSession(false)
    const wake = vi.fn()
    routeIdleTurnsToChat(session as never, wake)
    await session.sendCustomMessage(message, { triggerTurn: true })
    expect(calls).toEqual([{ triggerTurn: false }])
    expect(wake).toHaveBeenCalledOnce()
  })

  it("leaves streaming, non-triggering, and nextTurn messages to Pi", async () => {
    const streaming = fakeSession(true)
    const idle = fakeSession(false)
    const wake = vi.fn()
    routeIdleTurnsToChat(streaming.session as never, wake)
    routeIdleTurnsToChat(idle.session as never, wake)
    await streaming.session.sendCustomMessage(message, { triggerTurn: true })
    await idle.session.sendCustomMessage(message)
    await idle.session.sendCustomMessage(message, { triggerTurn: true, deliverAs: "nextTurn" })
    expect(streaming.calls).toEqual([{ triggerTurn: true }])
    expect(idle.calls).toEqual([undefined, { triggerTurn: true, deliverAs: "nextTurn" }])
    expect(wake).not.toHaveBeenCalled()
  })

  it("fans wakes out to subscribers until they unsubscribe", () => {
    const listener = vi.fn()
    const unsubscribe = agentWakes.subscribe(listener)
    agentWakes.publish({ sessionId: "s", chatId: "c" })
    unsubscribe()
    agentWakes.publish({ sessionId: "s", chatId: "c" })
    expect(listener).toHaveBeenCalledExactlyOnceWith({ sessionId: "s", chatId: "c" })
  })
})
