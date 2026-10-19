import { describe, expect, it } from "vitest"
import { notificationTarget } from "./notification-target.js"

describe("notificationTarget", () => {
  it("focuses the question when the click's turn is still pending", () => {
    expect(notificationTarget({ sessionId: "s1", turnId: "t1" }, "t1")).toEqual({
      sessionId: "s1",
      focusQuestion: true
    })
  })

  it("does not focus when the pending question has moved on", () => {
    expect(notificationTarget({ sessionId: "s1", turnId: "t1" }, "t2")).toEqual({
      sessionId: "s1",
      focusQuestion: false
    })
  })

  it("does not focus when nothing is pending", () => {
    expect(notificationTarget({ sessionId: "s1", turnId: "t1" }, null)).toEqual({
      sessionId: "s1",
      focusQuestion: false
    })
  })

  it("does not focus a kind with no turn (e.g. pr)", () => {
    expect(notificationTarget({ sessionId: "s1", turnId: null }, "t1")).toEqual({
      sessionId: "s1",
      focusQuestion: false
    })
  })
})
