import { describe, expect, it } from "vitest"
import { createActor } from "xstate"
import { codeReviewViewMachine } from "./code-review-view-machine.js"

describe("codeReviewViewMachine", () => {
  it("sets and clears every filter", () => {
    const actor = createActor(codeReviewViewMachine).start()

    actor.send({ type: "SET_QUERY", query: "auth" })
    actor.send({ type: "SET_KIND", kind: "tests" })
    actor.send({ type: "TOGGLE_FEEDBACK" })
    actor.send({ type: "TOGGLE_HIDE_VIEWED" })
    expect(actor.getSnapshot().context).toEqual({
      query: "auth",
      kind: "tests",
      feedbackOnly: true,
      hideViewed: true
    })

    actor.send({ type: "CLEAR_FILTERS" })
    expect(actor.getSnapshot().context).toEqual({
      query: "",
      kind: "all",
      feedbackOnly: false,
      hideViewed: false
    })
  })

  it("drops feedback-only mode when the filtered source becomes empty", () => {
    const actor = createActor(codeReviewViewMachine).start()
    actor.send({ type: "TOGGLE_FEEDBACK" })
    expect(actor.getSnapshot().context.feedbackOnly).toBe(true)
    actor.send({ type: "FEEDBACK_EMPTY" })
    expect(actor.getSnapshot().context.feedbackOnly).toBe(false)
  })

  it("shows viewed files by default and can hide them", () => {
    const actor = createActor(codeReviewViewMachine).start()
    expect(actor.getSnapshot().context.hideViewed).toBe(false)
    actor.send({ type: "TOGGLE_HIDE_VIEWED" })
    expect(actor.getSnapshot().context.hideViewed).toBe(true)
  })
})
