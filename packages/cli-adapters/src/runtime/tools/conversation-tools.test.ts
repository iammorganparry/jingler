import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { ConversationSearchPage, type Message } from "@jingler/core"
import { Effect, Layer, Schema } from "effect"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { SessionStore } from "../../sessions.js"
import { withTempRoot } from "../../test-support.js"
import { TranscriptStore } from "../../transcripts.js"
import { makeConversationHistory, registerConversationTools } from "./conversation-tools.js"
import { ToolRegistry } from "./tool-registry.js"

const DATE = "2026-11-05T00:00:00Z"
const message = (id: string, text: string): Message => ({ id, role: "assistant", parts: [{ _tag: "Text", text }], streaming: false, createdAt: DATE })
const session = (id: string, repoPath = "/projects/widget") => ({
  id, repo: "widget", repoPath, worktreePath: `${repoPath}/${id}`, title: id,
  branch: "main", status: "idle", diff: { added: 0, removed: 0 }, prNumber: null,
  costUsd: 0, tokens: 0, updatedAt: DATE,
  chats: [{ id: `${id}-chat`, title: id, createdAt: DATE, updatedAt: DATE, mode: "auto" }], activeChatId: `${id}-chat`
})
let temp: ReturnType<typeof withTempRoot>
beforeEach(() => { temp = withTempRoot(); mkdirSync(join(temp.root, "transcripts"), { recursive: true }) })
afterEach(() => temp.cleanup())
const seedSessions = (sessions: ReadonlyArray<unknown>) => writeFileSync(join(temp.root, "sessions.json"), JSON.stringify(sessions))
const seedChat = (id: string, messages: ReadonlyArray<Message>) => writeFileSync(join(temp.root, "transcripts", `${id}.json`), JSON.stringify(messages))
const history = () => Effect.runPromise(makeConversationHistory.pipe(
  Effect.map((bind) => bind("current")),
  Effect.provide(Layer.mergeAll(SessionStore.Default, TranscriptStore.Default)), Effect.provide(temp.layer)
))

describe("agent conversation history", () => {
  it("searches archived and closed chats in the same project, excluding other projects and remote hosts", async () => {
    seedSessions([session("current"), { ...session("archive"), archived: true, chats: [], closedChats: session("archive").chats }, session("unrelated", "/elsewhere/widget"), { ...session("remote"), environmentId: "remote-host" }])
    for (const id of ["archive", "unrelated", "remote"]) seedChat(`${id}-chat`, [message(id, "A quartz capybara fix")])
    const result = await Effect.runPromise((await history()).search("quartz   capybara"))
    expect(result.hits.map((hit) => hit.sessionId)).toEqual(["archive"])
    const port = await history()
    expect((await Effect.runPromise(port.search("quartz capybara", "archive-chat"))).hits).toHaveLength(1)
    expect((await Effect.runPromise(port.search("quartz capybara", "unrelated-chat"))).hits).toEqual([])
  })

  it("does not join unrelated no-repo workspaces by their display name", async () => {
    seedSessions([ { ...session("current"), repoPath: undefined }, { ...session("other"), repoPath: undefined } ])
    seedChat("other-chat", [message("other", "quartz capybara")])
    expect(await Effect.runPromise((await history()).search("quartz capybara"))).toEqual({ hits: [], hasMore: false })
  })

  it("uses project identity across clone paths and refuses conflicting project identities", async () => {
    seedSessions([
      { ...session("current"), projectId: "widget-project" },
      { ...session("clone", "/another/clone"), projectId: "widget-project" },
      { ...session("other"), projectId: "other-project" }
    ])
    seedChat("clone-chat", [message("clone", "quartz capybara")])
    seedChat("other-chat", [message("other", "quartz capybara")])
    expect((await Effect.runPromise((await history()).search("quartz capybara"))).hits.map((hit) => hit.sessionId)).toEqual(["clone"])
  })

  it("preserves code indentation and line breaks in retrieved context", async () => {
    seedSessions([session("current")])
    const code = "quartz\n  capybara\n\n```python\nif ready:\n    reconnect()\n```"
    seedChat("current-chat", [message("code", code)])
    const port = await history()
    const hit = (await Effect.runPromise(port.search("quartz capybara"))).hits[0]!
    expect((await Effect.runPromise(port.read({ ...hit, query: "quartz capybara" }))).messages[0]?.text).toBe(code)
  })

  it("reads the exact old match with duplicate ids, neighboring text and bounded long messages", async () => {
    seedSessions([session("current")])
    const messages = Array.from({ length: 450 }, (_, index) => message(`m${index}`, `Ordinary turn ${index}`))
    messages[11] = message("duplicate", "Earlier context")
    messages[12] = message("duplicate", `${"prefix ".repeat(800)}quartz capybara${" suffix".repeat(800)}`)
    messages[13] = { ...message("private", "Later context"), parts: [{ _tag: "Thinking", text: "private secret", seconds: null, streaming: false }, { _tag: "Text", text: "Later context" }] }
    seedChat("current-chat", messages)
    const port = await history()
    const hit = (await Effect.runPromise(port.search("quartz capybara"))).hits[0]!
    const result = await Effect.runPromise(port.read({ ...hit, query: "quartz capybara" }))
    expect(result.messages).toHaveLength(5)
    expect(result.messages.find((entry) => entry.matched)).toMatchObject({ messageId: "duplicate", truncated: true })
    expect(result.messages.find((entry) => entry.matched)?.text).toContain("quartz capybara")
    expect(result.messages.every((entry) => entry.text.length <= 2_002)).toBe(true)
    expect(JSON.stringify(result)).not.toContain("private secret")
    expect(result.messages.map((entry) => entry.text)).toContain("Later context")
  })

  it("rechecks project scope on read and preserves a useful tool error", async () => {
    seedSessions([session("current"), session("old")])
    seedChat("old-chat", [message("old", "quartz capybara")])
    const port = await history()
    const hit = (await Effect.runPromise(port.search("quartz capybara"))).hits[0]!
    seedSessions([session("current"), session("old", "/other/project")])
    const registry = new ToolRegistry()
    registerConversationTools(registry, port)
    const result = await Effect.runPromise(registry.execute({ id: "conversation_read", arguments: { ...hit, query: "quartz capybara" }, role: "conversation", mode: "read-only" }))
    expect(result.error?.code).toBe("forbidden")
  })

  it("asks the agent to search again when a result has changed", async () => {
    seedSessions([session("current")])
    seedChat("current-chat", [message("match", "quartz capybara")])
    const port = await history()
    const hit = (await Effect.runPromise(port.search("quartz capybara"))).hits[0]!
    await Effect.runPromise(TranscriptStore.patchById("current-chat", "match", () => message("match", "Replaced text")).pipe(Effect.provide(TranscriptStore.Default), Effect.provide(temp.layer)))
    const result = await Effect.runPromise(Effect.either(port.read({ ...hit, query: "quartz capybara" })))
    expect(result).toMatchObject({ _tag: "Left", left: { code: "invalid-input", retryable: true } })
  })

  it("caps results and refuses whitespace-only queries through the registry", async () => {
    seedSessions([session("current")])
    seedChat("current-chat", Array.from({ length: 30 }, (_, index) => message(`m${index}`, "quartz capybara")))
    const registry = new ToolRegistry()
    registerConversationTools(registry, await history())
    const result = await Effect.runPromise(registry.execute({ id: "conversation_search", arguments: { query: "quartz capybara" }, role: "plan", mode: "plan" }))
    expect(result.status).toBe("success")
    expect(result.value).toMatchObject({ hits: expect.any(Array), hasMore: true })
    expect(Schema.decodeUnknownSync(ConversationSearchPage)(result.value).hits).toHaveLength(20)
    const invalid = await Effect.runPromise(registry.execute({ id: "conversation_search", arguments: { query: "   " }, role: "conversation", mode: "ask" }))
    expect(invalid.error?.code).toBe("invalid-input")
  })

  it("interrupts the backing search when the agent cancels", async () => {
    let interrupted = false
    const search = vi.fn(() => Effect.never.pipe(Effect.ensuring(Effect.sync(() => { interrupted = true }))))
    const registry = new ToolRegistry()
    registerConversationTools(registry, { search, read: () => Effect.die("Unexpected read") })
    const controller = new AbortController()
    const pending = Effect.runPromise(registry.execute({ id: "conversation_search", arguments: { query: "quartz capybara" }, role: "conversation", mode: "ask", signal: controller.signal }))
    await vi.waitFor(() => expect(search).toHaveBeenCalledOnce())
    controller.abort()
    expect((await pending).status).toBe("cancelled")
    await vi.waitFor(() => expect(interrupted).toBe(true))
  })
})
