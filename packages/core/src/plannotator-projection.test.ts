import { describe, expect, it } from "vitest"
import { plannotatorProjectionToPlanDocument } from "./plannotator-projection.js"
import { planStageExecutionStatus } from "./plan-view.js"

describe("Plannotator native projection", () => {
  it("maps checklist completion into the existing plan task components", () => {
    const document = plannotatorProjectionToPlanDocument(
      {
        phase: "executing",
        planFilePath: "plans/auth.md",
        review: null,
        checklist: [
          { step: 1, text: "Implement auth", completed: true },
          { step: 2, text: "Verify auth", completed: false }
        ]
      },
      "session-1",
      "chat-1",
      "2026-08-27T00:00:00.000Z"
    )

    expect(document.status).toBe("executing")
    expect(document.plan.title).toBe("plans/auth.md")
    expect(document.plan.stages.map((stage) => stage.title)).toEqual([
      "Implement auth",
      "Verify auth"
    ])
    expect(document.plan.stages.map(planStageExecutionStatus)).toEqual([
      "completed",
      "queued"
    ])
  })

  it("is disposable and contains no state outside the supplied snapshot", () => {
    const document = plannotatorProjectionToPlanDocument(
      {
        phase: "idle",
        planFilePath: "PLAN.md",
        review: null,
        checklist: [{ step: 1, text: "Done", completed: true }]
      },
      "session-1",
      "chat-1",
      "2026-08-27T00:00:00.000Z"
    )

    expect(document.status).toBe("done")
    expect(document.revision).toBe(1)
    expect(document.plan.annotations).toEqual([])
  })
})
