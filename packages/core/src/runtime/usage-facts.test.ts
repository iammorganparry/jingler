import { describe, expect, it } from "vitest"
import {
  filterUsageFacts,
  makeUsageFact,
  modelDetailFromFacts,
  slowestRuns,
  sortModelPerformance,
  usageReportFromFacts,
  type UsageFact
} from "./usage-facts.js"

const fact = (over: Partial<UsageFact> = {}): UsageFact => ({
  id: "run-1",
  runId: "run-1",
  sessionId: "session-1",
  chatId: "chat-1",
  parentRunId: null,
  runtimeId: "claude",
  providerId: "anthropic",
  modelId: "claude-sonnet",
  kind: "parent",
  startedAt: "2026-01-01T00:00:00.000Z",
  endedAt: "2026-01-01T00:00:01.000Z",
  durationMs: 1000,
  inputTokens: 100,
  outputTokens: 20,
  cacheReadTokens: null,
  cacheWriteTokens: null,
  reasoningTokens: null,
  totalTokens: 120,
  costUsd: null,
  toolCalls: 2,
  outcome: "success",
  provenance: "native-cli.result",
  ...over
})

describe("usage facts", () => {
  it("fills shared timing and nullable counters", () => {
    expect(makeUsageFact({
      id: "run-1",
      runId: "run-1",
      sessionId: "session-1",
      chatId: "chat-1",
      parentRunId: null,
      runtimeId: "claude",
      providerId: "anthropic",
      modelId: "claude-sonnet",
      kind: "parent",
      startedAt: 1_000,
      endedAt: 2_500,
      outcome: "success",
      provenance: "test"
    })).toMatchObject({
      startedAt: "1970-01-01T00:00:01.000Z",
      endedAt: "1970-01-01T00:00:02.500Z",
      durationMs: 1_500,
      inputTokens: null,
      costUsd: null,
      toolCalls: null
    })
  })

  it("groups by harness identity and keeps unknown spend out of known cost", () => {
    const report = usageReportFromFacts([
      fact(),
      fact({ id: "run-2", runId: "run-2", outcome: "error", costUsd: 0.25 })
    ], "2026-01-02T00:00:00.000Z")
    expect(report.groups).toEqual([expect.objectContaining({
      runtimeId: "claude",
      runCount: 2,
      successRate: 0.5,
      inputTokens: 200,
      totalTokens: 240,
      knownCostUsd: 0.25,
      costCoverage: 0.5
    })])
    expect(report.facts[0]?.costUsd).toBeNull()
  })

  it("ranks the slowest runs and maps each to its parent turn", () => {
    const facts = [
      fact({ id: "a", runId: "turn-a", durationMs: 500 }),
      fact({ id: "b", runId: "child-b", parentRunId: "turn-a", kind: "child", durationMs: 3000 }),
      fact({ id: "c", runId: "turn-c", durationMs: 2000 })
    ]
    expect(slowestRuns(facts, 2).map((run) => [run.runId, run.turnRunId])).toEqual([
      ["child-b", "turn-a"],
      ["turn-c", "turn-c"]
    ])
  })

  it("keeps filtered group totals equal to the sum over the same facts", () => {
    const facts = [fact({ id: "a", durationMs: 100 }), fact({ id: "b", runId: "r2", durationMs: 250, modelId: "other" })]
    const report = usageReportFromFacts(facts)
    const sum = report.groups.reduce((total, group) => total + group.durationMs, 0)
    expect(sum).toBe(facts.reduce((total, f) => total + f.durationMs, 0))
  })

  it("filters facts by runtime and started-at range", () => {
    const facts = [
      fact({ id: "a", startedAt: "2026-01-01T00:00:00.000Z" }),
      fact({ id: "b", runId: "r2", runtimeId: "codex", startedAt: "2026-01-05T00:00:00.000Z" }),
      fact({ id: "c", runId: "r3", startedAt: "2026-02-01T00:00:00.000Z" })
    ]
    expect(filterUsageFacts(facts, { runtimeId: "claude" }).map((f) => f.id)).toEqual(["a", "c"])
    expect(filterUsageFacts(facts, { from: "2026-01-02T00:00:00.000Z", to: "2026-01-31T00:00:00.000Z" }).map((f) => f.id))
      .toEqual(["b"])
    expect(filterUsageFacts(facts, {})).toHaveLength(3)
  })

  it("sorts model performance rows by any column, nulls first ascending", () => {
    const report = usageReportFromFacts([
      fact({ id: "a", modelId: "model-a", durationMs: 100 }),
      fact({ id: "b", runId: "r2", modelId: "model-b", durationMs: 50, costUsd: 1 })
    ])
    const byCostAsc = sortModelPerformance(report.groups, "knownCostUsd", "asc")
    expect(byCostAsc.map((g) => g.modelId)).toEqual(["model-a", "model-b"])
    const byDurationDesc = sortModelPerformance(report.groups, "durationMs")
    expect(byDurationDesc.map((g) => g.modelId)).toEqual(["model-a", "model-b"])
  })

  it("builds a model detail from only the matching group's facts, sparkline in run order", () => {
    const facts = [
      fact({ id: "a", runId: "a", startedAt: "2026-01-01T00:00:02.000Z", durationMs: 100, totalTokens: 10 }),
      fact({ id: "b", runId: "b", startedAt: "2026-01-01T00:00:01.000Z", durationMs: 3000, totalTokens: 20 }),
      fact({ id: "c", runId: "c", modelId: "other-model", durationMs: 9000 })
    ]
    const detail = modelDetailFromFacts(facts, { runtimeId: "claude", providerId: "anthropic", modelId: "claude-sonnet", kind: "parent" })
    expect(detail?.group.runCount).toBe(2)
    expect(detail?.sparkline.map((p) => p.runId)).toEqual(["b", "a"])
    expect(detail?.slowestRuns.map((r) => r.runId)).toEqual(["b", "a"])
  })

  it("returns null when no facts match the selector", () => {
    expect(modelDetailFromFacts([fact()], { runtimeId: "codex", providerId: "openai", modelId: "gpt", kind: "parent" })).toBeNull()
  })
})
