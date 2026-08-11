import { describe, expect, it } from "vitest"
import {
  managedUsageCostMicrousd,
  redactedUsageTelemetry,
  shouldSampleUsage
} from "./usage-policy.js"

describe("managed runtime usage policy", () => {
  it("computes published basic-instance ceiling costs", () => {
    expect(managedUsageCostMicrousd(3_600)).toBe(28_000)
    expect(managedUsageCostMicrousd(120)).toBe(934)
  })

  it("records one redacted settlement per lifecycle interval, not per event", () => {
    const event = redactedUsageTelemetry({
      activeSeconds: 42,
      restoreBytes: 1_024,
      cleanup: "completed"
    })
    expect(event).toEqual({
      event: "managed_runtime_settled",
      activeSeconds: 42,
      restoreBytes: 1_024,
      cleanup: "completed"
    })
    expect(JSON.stringify(event)).not.toMatch(/user|session|prompt|token|credential/u)
  })

  it("samples deterministically without storing an identity", () => {
    expect(shouldSampleUsage("usage_same", 0.5)).toBe(
      shouldSampleUsage("usage_same", 0.5)
    )
    expect(shouldSampleUsage("usage", 0)).toBe(false)
    expect(shouldSampleUsage("usage", 1)).toBe(true)
  })
})
