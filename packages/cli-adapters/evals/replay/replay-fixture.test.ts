import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { Message } from "@jingler/core"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { EvalTrace } from "../behavior-contract.js"
import { scoreScenario } from "../pi-eval.js"
import { scenarioById } from "../pi-scenarios.js"
import { transcriptToTrace } from "./transcript-to-trace.js"

const FIXTURE = join(import.meta.dirname, "fixtures", "plan-regression-2026-08-22.json")

const replayScenario = () => {
  const scenario = scenarioById("plan.task-status-replay")
  if (scenario === null) throw new Error("missing replay scenario")
  return scenario
}

describe("replayed real sessions", () => {
  it("the checked-in regressed session FAILS the checkpoint scenario", async () => {
    // A real session (2026-08-22): the agent submitted a plan, ran 246 tools
    // to execute it, and never emitted one checkpoint — the panel sat at 0/3.
    // This guard proves the eval sees that bug; if this test starts passing,
    // either the fixture was replaced or the scenario went blind.
    const traces = Schema.decodeUnknownSync(Schema.Array(EvalTrace))(
      JSON.parse(await readFile(FIXTURE, "utf8"))
    )
    expect(traces).toHaveLength(1)
    const result = scoreScenario(replayScenario(), traces[0]!)
    expect(result.status).toBe("failed")
    expect(result.failures).toContain("missing plan-task-status:*:*:completed")
  })

  it("a session that checkpointed its tasks passes the same scenario", () => {
    const healthy = Schema.decodeUnknownSync(Schema.Array(Message))([
      {
        id: "u_1",
        role: "user",
        parts: [{ _tag: "Text", text: "Execute the plan." }],
        streaming: false,
        createdAt: "2026-08-22T00:00:00.000Z"
      },
      {
        id: "a_1",
        role: "assistant",
        parts: [
          { _tag: "Text", text: "Working through the plan." },
          { _tag: "PlanTaskProgress", stageId: "s1", taskId: "s1.t1", status: "in-progress" },
          { _tag: "PlanTaskProgress", stageId: "s1", taskId: "s1.t1", status: "completed" }
        ],
        streaming: false,
        createdAt: "2026-08-22T00:01:00.000Z"
      }
    ])
    const result = scoreScenario(
      replayScenario(),
      transcriptToTrace(healthy, "plan.task-status-replay")
    )
    expect(result.failures).toEqual([])
    expect(result.status).toBe("passed")
  })
})
