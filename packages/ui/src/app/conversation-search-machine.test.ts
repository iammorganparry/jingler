import type { ConversationSearchPage } from "@jingler/core"
import { createActor } from "xstate"
import { afterEach, describe, expect, it, vi } from "vitest"
import { conversationSearchMachine, type ConversationSearchLoader } from "./conversation-search-machine.js"

afterEach(() => vi.useRealTimers())

describe("conversation search requests", () => {
  it("debounces typing and aborts a superseded request; late responses cannot replace current results", async () => {
    vi.useFakeTimers()
    const pending: Array<{ query: string; signal: AbortSignal; resolve: (page: ConversationSearchPage) => void }> = []
    const load: ConversationSearchLoader = (query, _scope, signal) => new Promise((resolve) => { pending.push({ query, signal, resolve }) })
    const actor = createActor(conversationSearchMachine).start()
    actor.send({ type: "QUERY", query: "first", scope: "workspace", load })
    actor.send({ type: "QUERY", query: "second", scope: "workspace", load })
    await vi.advanceTimersByTimeAsync(200)
    expect(pending.map((request) => request.query)).toEqual(["second"])
    actor.send({ type: "QUERY", query: "third", scope: "chat", load })
    expect(pending[0]?.signal.aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(200)
    pending[1]!.resolve({ hits: [], hasMore: false })
    await vi.advanceTimersByTimeAsync(0)
    pending[0]!.resolve({ hits: [], hasMore: true })
    await vi.advanceTimersByTimeAsync(0)
    expect(actor.getSnapshot().context).toMatchObject({ query: "third", scope: "chat", page: { hasMore: false } })
    actor.stop()
  })

  it("closing cancels work and clears failure and result state", async () => {
    vi.useFakeTimers()
    let signal: AbortSignal | undefined
    const load: ConversationSearchLoader = (_query, _scope, requestSignal) => {
      signal = requestSignal
      return new Promise(() => {})
    }
    const actor = createActor(conversationSearchMachine).start()
    actor.send({ type: "QUERY", query: "needle", scope: "workspace", load })
    await vi.advanceTimersByTimeAsync(200)
    actor.send({ type: "RESET" })
    expect(signal?.aborted).toBe(true)
    expect(actor.getSnapshot().matches("idle")).toBe(true)
    expect(actor.getSnapshot().context.page).toEqual({ hits: [], hasMore: false })
    actor.stop()
  })

  it("a failed query can be retried by typing again", async () => {
    vi.useFakeTimers()
    const load: ConversationSearchLoader = async () => { throw new Error("offline") }
    const actor = createActor(conversationSearchMachine).start()
    actor.send({ type: "QUERY", query: "needle", scope: "workspace", load })
    await vi.advanceTimersByTimeAsync(200)
    expect(actor.getSnapshot().context.failed).toBe(true)
    actor.send({ type: "QUERY", query: "new needle", scope: "workspace", load: async () => ({ hits: [], hasMore: false }) })
    await vi.advanceTimersByTimeAsync(200)
    expect(actor.getSnapshot().context.failed).toBe(false)
    actor.stop()
  })
})
