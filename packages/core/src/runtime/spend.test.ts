import { describe, expect, it } from "vitest"
import { makeUsageFact } from "./usage-facts.js"
import { spendFromFacts } from "./spend.js"

const fact = (over: Partial<Parameters<typeof makeUsageFact>[0]> & { id: string }) =>
  makeUsageFact({
    runId: over.id,
    sessionId: "s1",
    chatId: "c1",
    parentRunId: null,
    runtimeId: "claude",
    providerId: "anthropic",
    modelId: "anthropic/opus",
    kind: "parent",
    startedAt: Date.parse("2026-10-13T11:00:00Z"),
    outcome: "success",
    provenance: "test",
    ...over
  })

const now = new Date("2026-10-13T12:00:00Z")

describe("spendFromFacts", () => {
  it("sums per-invocation Claude CLI cost across --resume and splits today / month", () => {
    const spend = spendFromFacts([
      fact({ id: "a", endedAt: Date.parse("2026-09-02T12:00:00Z"), totalTokens: 100, costUsd: 1 }),
      fact({ id: "b", sessionId: "s2", endedAt: Date.parse("2026-10-10T12:00:00Z"), totalTokens: 200, costUsd: 2 }),
      // s2 resumed today: the CLI reports this invocation's cost (not a running total).
      fact({ id: "c", sessionId: "s2", endedAt: Date.parse("2026-10-13T12:00:00Z"), totalTokens: 50, costUsd: 2.1 })
    ], now)
    expect(spend.today).toEqual({ tokens: 50, costUsd: 2.1 })
    expect(spend.month).toEqual({ tokens: 250, costUsd: 4.1 })
    expect(spend.lastSession).toEqual({ tokens: 250, costUsd: 4.1 })
  })

  it("treats pi session stats as running totals and a counter reset as a fresh start", () => {
    const spend = spendFromFacts([
      fact({ id: "a", runtimeId: "pi", endedAt: Date.parse("2026-10-13T10:00:00Z"), totalTokens: 1000, costUsd: 0.5 }),
      fact({ id: "b", runtimeId: "pi", endedAt: Date.parse("2026-10-13T11:00:00Z"), totalTokens: 1800, costUsd: 0.9 }),
      fact({ id: "c", runtimeId: "pi", endedAt: Date.parse("2026-10-13T12:00:00Z"), totalTokens: 300, costUsd: 0.1 })
    ], now)
    expect(spend.today.tokens).toBe(2100)
    expect(spend.today.costUsd).toBeCloseTo(1.0)
  })

  it("is empty with no facts", () => {
    expect(spendFromFacts([], now)).toEqual({
      lastSession: null,
      today: { tokens: 0, costUsd: 0 },
      month: { tokens: 0, costUsd: 0 }
    })
  })
})
