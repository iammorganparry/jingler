import type { Message } from "@jingler/core"
import { createActor, fromPromise, waitFor } from "xstate"
import { describe, expect, it } from "vitest"
import { conversationSearchPreviewMachine, conversationSearchPreviewPage, type ConversationSearchTarget, type ConversationSearchPreviewPage } from "./conversation-search-preview-machine.js"

const target = (id: string): ConversationSearchTarget => ({
  sessionId: "s", chatId: "c", messageId: id, messageIndex: 0, before: "v1:200", sessionTitle: "Work", chatTitle: "Chat", repo: "widget", role: "assistant", snippet: id, nonce: 1, query: id
})
const message = (id: string, text = id): Message => ({ id, role: "assistant", parts: [{ _tag: "Text", text }], streaming: false, createdAt: "2026-11-05T00:00:00Z" })
const page = (id: string): ConversationSearchPreviewPage => ({ messages: [message(id)], focusIndex: 0 })

// Requests use exact page positions because legacy transcripts can repeat message ids.
describe("saved search navigation", () => {
  it("finds the exact occurrence of a duplicate id without changing source messages", () => {
    const original = [message("duplicate", "wrong turn"), message("duplicate", "correct turn")]
    const preview = conversationSearchPreviewPage(original, { ...target("duplicate"), messageIndex: 1, snippet: "correct turn" })
    expect(preview?.focusIndex).toBe(1)
    expect(preview?.messages[preview.focusIndex]?.parts).toEqual([{ _tag: "Text", text: "correct turn" }])
    expect(original[1]?.id).toBe("duplicate")
    expect(conversationSearchPreviewPage(original, { ...target("missing"), messageIndex: 1 })).toBeNull()
  })

  it("rejects an edited message even when its id and position are unchanged", () => {
    expect(conversationSearchPreviewPage([message("hit", "New content")], { ...target("hit"), snippet: "Previous content" })).toBeNull()
    expect(conversationSearchPreviewPage([message("hit", "Earlier text and the matching phrase and later text")], { ...target("hit"), snippet: "…the matching phrase…" })?.focusIndex).toBe(0)
  })

  it("distinguishes a load failure from a removed message", async () => {
    const actor = createActor(conversationSearchPreviewMachine.provide({ actors: { load: fromPromise<ConversationSearchPreviewPage | null, ConversationSearchTarget>(async () => { throw new Error("Unavailable") }) } })).start()
    actor.send({ type: "OPEN", target: target("hit") })
    await waitFor(actor, (state) => state.matches("failed"))
    expect(actor.getSnapshot().context.page).toBeNull()
    actor.stop()
  })

  it("accounts for hidden non-text messages before the matched position", () => {
    const original = [{ ...message("hidden"), parts: [] }, message("hit")]
    const preview = conversationSearchPreviewPage(original, { ...target("hit"), messageIndex: 1 })
    expect(preview?.focusIndex).toBe(0)
    expect(preview?.messages).toHaveLength(1)
  })

  it("rejects an obsolete page instead of opening a different message", async () => {
    const actor = createActor(conversationSearchPreviewMachine.provide({ actors: { load: fromPromise<ConversationSearchPreviewPage | null, ConversationSearchTarget>(async () => null) } })).start()
    actor.send({ type: "OPEN", target: target("removed") })
    await waitFor(actor, (state) => state.matches("missing"))
    expect(actor.getSnapshot().context.page).toBeNull()
    actor.stop()
  })

  it("cancels old navigation and ignores its late reply", async () => {
    const pending: Array<{ signal: AbortSignal; resolve: (result: ConversationSearchPreviewPage | null) => void }> = []
    const actor = createActor(conversationSearchPreviewMachine.provide({ actors: { load: fromPromise(({ signal }) => new Promise<ConversationSearchPreviewPage | null>((resolve) => { pending.push({ signal, resolve }) })) } })).start()
    actor.send({ type: "OPEN", target: target("old") })
    actor.send({ type: "OPEN", target: { ...target("new"), nonce: 2 } })
    expect(pending[0]?.signal.aborted).toBe(true)
    pending[1]!.resolve(page("new"))
    await waitFor(actor, (state) => state.matches("ready"))
    pending[0]!.resolve(page("old"))
    await Promise.resolve()
    expect(actor.getSnapshot().context.page?.messages.map((entry) => entry.id)).toEqual(["new"])
    actor.send({ type: "CLOSE" })
    expect(actor.getSnapshot().context.page).toBeNull()
    actor.stop()
  })
})
