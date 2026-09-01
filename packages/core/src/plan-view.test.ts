import type { PlanPrdStage, PlanTaskStatus } from "./plan-document.js"
import { planStageExecutionStatus } from "./plan-view.js"
import { describe, expect, it } from "vitest"

const stage = (
  taskStatuses: ReadonlyArray<PlanTaskStatus>,
  acceptance: PlanPrdStage["acceptance"] = []
): PlanPrdStage => ({
  id: "stage",
  title: "Stage",
  intent: "Test stage status",
  approach: [],
  tasks: taskStatuses.map((status, index) => ({ id: `task-${index}`, text: status, status })),
  files: [],
  diagrams: [],
  notes: [],
  acceptance
})

describe("planStageExecutionStatus", () => {
  it("uses blocked and failed as the highest-priority states", () => {
    expect(planStageExecutionStatus(stage(["in-progress", "blocked"]))).toBe("blocked")
    expect(planStageExecutionStatus(stage(["in-progress"], [{
      id: "acceptance",
      text: "Fails",
      status: "failed",
      evidence: null
    }]))).toBe("failed")
  })

  it("derives running, completed, and queued from every stage marker", () => {
    const acceptance = (status: "pending" | "passed") => [{
      id: "acceptance",
      text: "Verify it",
      status,
      evidence: null
    }] as const

    expect(planStageExecutionStatus(stage(["in-progress"]))).toBe("running")
    expect(planStageExecutionStatus(stage(["completed", "pending"]))).toBe("running")
    expect(planStageExecutionStatus(stage(["completed"], acceptance("pending")))).toBe("running")
    expect(planStageExecutionStatus(stage(["completed"], acceptance("passed")))).toBe("completed")
    expect(planStageExecutionStatus(stage([], acceptance("passed")))).toBe("completed")
    expect(planStageExecutionStatus(stage(["pending"]))).toBe("queued")
  })
})
