import { afterEach, describe, expect, it, vi } from "vitest"
import {
  sessionActivitiesSnapshot,
  setSessionActivity,
  subscribeSessionActivities
} from "./session-activity.js"

const ids = ["session-1", "session-2"]

afterEach(() => {
  for (const id of ids) setSessionActivity(id, null)
})

describe("setSessionActivity", () => {
  it("publishes and clears activity by workspace", () => {
    const activity = { kind: "thinking" as const, verb: "Thinking", target: null }
    setSessionActivity("session-1", activity)
    setSessionActivity("session-2", { kind: "editing", verb: "Editing", target: "src/app.ts" })

    expect(sessionActivitiesSnapshot()).toEqual({
      "session-1": activity,
      "session-2": { kind: "editing", verb: "Editing", target: "src/app.ts" }
    })

    setSessionActivity("session-1", null)
    expect(sessionActivitiesSnapshot()).toEqual({
      "session-2": { kind: "editing", verb: "Editing", target: "src/app.ts" }
    })
  })

  it("notifies subscribers only for observable changes", () => {
    const listener = vi.fn()
    const unsubscribe = subscribeSessionActivities(listener)
    const activity = { kind: "thinking" as const, verb: "Thinking", target: null }

    setSessionActivity("session-1", activity)
    const firstSnapshot = sessionActivitiesSnapshot()
    setSessionActivity("session-1", { ...activity })
    expect(sessionActivitiesSnapshot()).toBe(firstSnapshot)
    expect(listener).toHaveBeenCalledTimes(1)

    setSessionActivity("session-1", null)
    setSessionActivity("session-1", null)
    expect(listener).toHaveBeenCalledTimes(2)
    unsubscribe()
  })
})
