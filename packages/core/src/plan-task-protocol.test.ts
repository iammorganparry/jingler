import { describe, expect, it } from "vitest"
import {
  planTaskProgressRecords,
  planTaskProtocolTokens,
  stripPlanTaskProgressProtocol
} from "./plan-task-protocol.js"

describe("plan task protocol", () => {
  it("parses fully-qualified checkpoint markers", () => {
    expect(
      planTaskProgressRecords(
        "done\nPLAN_TASK stage=stage-1 fingerprint=abc123 task=t1 status=completed\n"
      )
    ).toEqual([
      {
        stageId: "stage-1",
        stageFingerprint: "abc123",
        taskId: "t1",
        status: "completed"
      }
    ])
  })

  it("accepts a marker without a fingerprint instead of dropping it", () => {
    expect(
      planTaskProgressRecords("PLAN_TASK stage=stage-2 task=t3 status=in-progress")
    ).toEqual([
      {
        stageId: "stage-2",
        stageFingerprint: "",
        taskId: "t3",
        status: "in-progress"
      }
    ])
  })

  it("splits prose around markers and strips them from visible text", () => {
    const text =
      "Starting.\nPLAN_TASK stage=s fingerprint=f task=t status=in-progress\nWorking."
    const tokens = planTaskProtocolTokens(text)
    expect(tokens.map((token) => token.kind)).toEqual(["text", "progress", "text"])
    expect(stripPlanTaskProgressProtocol(text)).toBe("Starting.\n\nWorking.")
  })
})
