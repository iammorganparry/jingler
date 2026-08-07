import { describe, expect, it } from "vitest"
import type { SessionActivity } from "@jingler/core"
import { selectSessionActivity } from "./session-activity.js"

const activity = (
  kind: SessionActivity["kind"],
  verb: string,
  target: string | null = null
): SessionActivity => ({ kind, verb, target })

describe("selectSessionActivity", () => {
  it("keeps a session active while only orchestration workers are running", () => {
    const workers = activity("delegating", "Delegating", "2 agents")
    expect(selectSessionActivity(undefined, workers)).toEqual(workers)
  })

  it("lets worker delegation replace an idle main-agent thinking state", () => {
    const workers = activity("delegating", "Delegating", "2 agents")
    expect(
      selectSessionActivity(activity("thinking", "Thinking"), workers)
    ).toEqual(workers)
  })

  it("does not hide operator attention behind worker activity", () => {
    const gate = activity("needs-input", "Needs input")
    expect(
      selectSessionActivity(gate, activity("delegating", "Delegating", "2 agents"))
    ).toEqual(gate)
  })
})
