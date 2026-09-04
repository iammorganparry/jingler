import type { Session } from "@jingler/core"
import { describe, expect, it, vi } from "vitest"
import { queueSessionChatMutation } from "./session-chat-mutations.js"

const session = (activeChatId: string) => ({ activeChatId }) as Session

describe("queueSessionChatMutation", () => {
  it("publishes active-chat mutations in operator order", async () => {
    let releaseFirst!: (value: Session) => void
    const first = new Promise<Session>((resolve) => { releaseFirst = resolve })
    const secondMutation = vi.fn(async () => session("chat-2"))
    const published: string[] = []
    const apply = (updated: Session) => published.push(updated.activeChatId)

    queueSessionChatMutation("session-1", () => first, apply)
    queueSessionChatMutation("session-1", secondMutation, apply)

    await Promise.resolve()
    expect(secondMutation).not.toHaveBeenCalled()

    releaseFirst(session("chat-1"))
    await vi.waitFor(() => expect(published).toEqual(["chat-1", "chat-2"]))
  })

  it("continues after a failed mutation", async () => {
    const apply = vi.fn()
    queueSessionChatMutation("session-2", async () => { throw new Error("failed") }, apply)
    queueSessionChatMutation("session-2", async () => session("chat-2"), apply)

    await vi.waitFor(() => expect(apply).toHaveBeenCalledWith(session("chat-2")))
  })
})
