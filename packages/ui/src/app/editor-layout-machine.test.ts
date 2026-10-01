import { createActor } from "xstate"
import { beforeEach, describe, expect, it } from "vitest"
import { closeTab, createEditorLayout, EDITOR_LAYOUT_STORAGE_PREFIX, groupsOf, openTab } from "./editor-layout.js"
import { editorLayoutsMachine } from "./editor-layout-machine.js"

const chat = (id: string) => ({ kind: "chat" as const, id })

beforeEach(() => localStorage.clear())

describe("editorLayoutsMachine", () => {
  it("seeds once, applies updates, persists them, and ignores no-op updates", () => {
    const actor = createActor(editorLayoutsMachine).start()
    const seeded = createEditorLayout([chat("a")])
    actor.send({ type: "INIT", sessionId: "s", layout: seeded })
    actor.send({ type: "INIT", sessionId: "s", layout: createEditorLayout([chat("other")]) })
    expect(actor.getSnapshot().context.layouts.s).toBe(seeded)

    const before = actor.getSnapshot()
    actor.send({ type: "UPDATE", sessionId: "s", update: (l) => l })
    expect(actor.getSnapshot().context).toBe(before.context)
    expect(localStorage.getItem(`${EDITOR_LAYOUT_STORAGE_PREFIX}s`)).toBeNull()

    actor.send({ type: "UPDATE", sessionId: "s", update: (l) => openTab(l, chat("b")) })
    const layout = actor.getSnapshot().context.layouts.s!
    expect(groupsOf(layout.root)[0]!.tabs.map((t) => t.id)).toEqual(["a", "b"])
    expect(JSON.parse(localStorage.getItem(`${EDITOR_LAYOUT_STORAGE_PREFIX}s`)!)).toEqual(layout)
  })

  it("keeps other sessions' layouts by identity and forgets a session", () => {
    const actor = createActor(editorLayoutsMachine).start()
    const other = createEditorLayout([chat("x")])
    actor.send({ type: "INIT", sessionId: "s", layout: createEditorLayout([chat("a"), chat("b")]) })
    actor.send({ type: "INIT", sessionId: "t", layout: other })
    actor.send({
      type: "UPDATE",
      sessionId: "s",
      update: (l) => closeTab(l, groupsOf(l.root)[0]!.id, chat("b"))
    })
    expect(actor.getSnapshot().context.layouts.t).toBe(other)
    actor.send({ type: "FORGET", sessionId: "s" })
    expect(actor.getSnapshot().context.layouts.s).toBeUndefined()
  })

  it("ignores updates for a session that was never seeded", () => {
    const actor = createActor(editorLayoutsMachine).start()
    actor.send({ type: "UPDATE", sessionId: "missing", update: (l) => openTab(l, chat("a")) })
    expect(actor.getSnapshot().context.layouts).toEqual({})
  })
})
