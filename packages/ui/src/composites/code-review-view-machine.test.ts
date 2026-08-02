import { describe, expect, it } from "vitest"
import { createActor } from "xstate"
import { codeReviewViewMachine } from "./code-review-view-machine.js"

describe("codeReviewViewMachine", () => {
  it("coordinates filters, responsive sheets, and focus mode", () => {
    const actor = createActor(codeReviewViewMachine).start()

    actor.send({ type: "SET_QUERY", query: "auth" })
    actor.send({ type: "SET_KIND", kind: "tests" })
    actor.send({ type: "TOGGLE_FEEDBACK" })
    actor.send({ type: "UNDOCK" })
    actor.send({ type: "TOGGLE_SHEET", sheet: "files" })
    expect(actor.getSnapshot().context.sheet).toBe("files")

    actor.send({ type: "TOGGLE_FOCUS" })
    expect(actor.getSnapshot().matches({ presentation: "focused" })).toBe(true)
    expect(actor.getSnapshot().context.sheet).toBeNull()

    actor.send({ type: "CLEAR_FILTERS" })
    expect(actor.getSnapshot().context).toMatchObject({
      query: "",
      kind: "all",
      feedbackOnly: false
    })
  })

  it("collapses viewed code by default and can reveal it", () => {
    const actor = createActor(codeReviewViewMachine).start()
    expect(actor.getSnapshot().context.collapseViewed).toBe(true)
    actor.send({ type: "TOGGLE_COLLAPSE_VIEWED" })
    expect(actor.getSnapshot().context.collapseViewed).toBe(false)
  })
})
