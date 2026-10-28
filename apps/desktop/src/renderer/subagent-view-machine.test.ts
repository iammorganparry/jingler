// @vitest-environment node
import { createActor } from "xstate"
import { describe, expect, it } from "vitest"
import { subagentViewMachine } from "./subagent-view-machine.js"

const start = () => createActor(subagentViewMachine, { input: { chatId: "chat-1" } }).start()

describe("subagentViewMachine", () => {
  it("opens a subagent in place", () => {
    const actor = start()
    expect(actor.getSnapshot().value).toBe("main")
    actor.send({ type: "OPEN_SUBAGENT", id: "a" })
    expect(actor.getSnapshot().value).toBe("subagent")
    expect(actor.getSnapshot().context.selectedId).toBe("a")
  })

  it("switches sibling without returning to main", () => {
    const actor = start()
    actor.send({ type: "OPEN_SUBAGENT", id: "a" })
    actor.send({ type: "SWITCH_SIBLING", id: "b" })
    expect(actor.getSnapshot().value).toBe("subagent")
    expect(actor.getSnapshot().context.selectedId).toBe("b")
  })

  it("BACK restores the saved main draft and scroll", () => {
    const actor = start()
    actor.send({ type: "SAVE_MAIN_VIEW", draft: "half-typed", scrollTop: 420 })
    actor.send({ type: "OPEN_SUBAGENT", id: "a" })
    actor.send({ type: "SAVE_MAIN_VIEW", draft: "ignored", scrollTop: 1 })
    actor.send({ type: "BACK" })
    const snapshot = actor.getSnapshot()
    expect(snapshot.value).toBe("main")
    expect(snapshot.context).toMatchObject({
      selectedId: null,
      mainDraft: "half-typed",
      mainScrollTop: 420
    })
  })

  it("opening the same id twice is a no-op", () => {
    const actor = start()
    actor.send({ type: "OPEN_SUBAGENT", id: "a" })
    const before = actor.getSnapshot()
    actor.send({ type: "OPEN_SUBAGENT", id: "a" })
    expect(actor.getSnapshot()).toBe(before)
  })

  it("scopes content to the opened child, follows sibling switches, and BACK restores all", () => {
    const actor = start()
    actor.send({ type: "OPEN_SUBAGENT", id: "n1", scope: "a" })
    expect(actor.getSnapshot().context).toMatchObject({ selectedId: "n1", changesScope: "a" })
    actor.send({ type: "SWITCH_SIBLING", id: "n2", scope: "b" })
    expect(actor.getSnapshot().context).toMatchObject({ selectedId: "n2", changesScope: "b" })
    actor.send({ type: "SWITCH_SIBLING", id: "n3" })
    expect(actor.getSnapshot().context.changesScope).toBe("all")
    actor.send({ type: "OPEN_SUBAGENT", id: "n1", scope: "a" })
    actor.send({ type: "SET_CHANGES_SCOPE", scope: "all" })
    expect(actor.getSnapshot().context).toMatchObject({ selectedId: "n1", changesScope: "all" })
    actor.send({ type: "SET_CHANGES_SCOPE", scope: "a" })
    actor.send({ type: "BACK" })
    expect(actor.getSnapshot().context).toMatchObject({ selectedId: null, changesScope: "all" })
  })

  it("Esc (BACK) from a scoped child restores all agents in one transition", () => {
    const actor = start()
    actor.send({ type: "OPEN_SUBAGENT", id: "n1", scope: "a" })
    actor.send({ type: "BACK" })
    expect(actor.getSnapshot().value).toBe("main")
    expect(actor.getSnapshot().context.changesScope).toBe("all")
  })
})
