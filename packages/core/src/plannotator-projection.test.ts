import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import {
  PlannotatorProjection,
  plannotatorProjectionToPlanDocument
} from "./plannotator-projection.js"
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
        ],
        title: null,
        revision: 1,
        stages: [],
        sections: []
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
        checklist: [{ step: 1, text: "Done", completed: true }],
        title: null,
        revision: 1,
        stages: [],
        sections: []
      },
      "session-1",
      "chat-1",
      "2026-08-27T00:00:00.000Z"
    )

    expect(document.status).toBe("done")
    expect(document.revision).toBe(1)
    expect(document.plan.annotations).toEqual([])
  })

  it("decodes a legacy flat payload without the structured fields", () => {
    const projection = Schema.decodeUnknownSync(PlannotatorProjection)({
      phase: "executing",
      planFilePath: "PLAN.md",
      review: { reviewId: "r1", url: "http://localhost:1234" },
      checklist: [{ step: 1, text: "Implement", completed: false }]
    })
    expect(projection.stages).toBeUndefined()
    expect(projection.sections).toBeUndefined()
    expect(projection.revision).toBeUndefined()
    const document = plannotatorProjectionToPlanDocument(
      projection,
      "session-1",
      "chat-1",
      "2026-08-27T00:00:00.000Z"
    )
    expect(document.status).toBe("proposed")
    expect(document.reviewId).toBe("r1")
    expect(document.plan.stages).toHaveLength(1)
  })

  it("maps a structured payload losslessly into the rich document", () => {
    const projection = Schema.decodeUnknownSync(PlannotatorProjection)({
      phase: "executing",
      planFilePath: "PLAN.md",
      review: null,
      checklist: [
        { step: 1, text: "Add the service", completed: true },
        { step: 2, text: "Wire the route", completed: false },
        { step: 3, text: "Service tests green", completed: false }
      ],
      planContent: "# Auth replacement\n\n- [x] Add the service\n",
      title: "Auth replacement",
      revision: 3,
      sections: [{
        title: "TL;DR",
        blocks: [
          { kind: "prose", text: "Replace the auth flow." },
          { kind: "diagram", source: "graph TD; A-->B" }
        ]
      }],
      stages: [{
        id: "stage-auth",
        title: "Auth service",
        intent: "Stand up the new auth service.",
        approach: ["Add the module", "Delete the old one"],
        tasks: [
          {
            step: 1,
            text: "Add the service",
            status: "completed",
            subtasks: [{ step: 2, text: "Wire the route", status: "in-progress" }]
          }
        ],
        acceptance: [{
          step: 3,
          text: "Service tests green",
          status: "pending",
          testReferences: [{ path: "src/auth.test.ts", cases: ["issues tokens"] }]
        }],
        files: [{ path: "src/auth.ts", change: "A" }],
        diagrams: ["sequenceDiagram"],
        notes: ["Watch the token format."],
        complexity: "medium",
        dependencies: []
      }]
    })
    const document = plannotatorProjectionToPlanDocument(
      projection,
      "session-1",
      "chat-1",
      "2026-08-27T00:00:00.000Z"
    )
    expect(document.plan.title).toBe("Auth replacement")
    expect(document.sourceMarkdown).toContain("- [x] Add the service")
    expect(document.revision).toBe(3)
    expect(document.plan.sections).toHaveLength(1)
    expect(document.plan.sections[0]!.blocks.map((block) => block.kind)).toEqual([
      "prose",
      "diagram"
    ])
    const stage = document.plan.stages[0]!
    expect(stage.id).toBe("stage-auth")
    expect(stage.tasks!.map((task) => [task.text, task.status])).toEqual([
      ["Add the service", "completed"],
      ["Wire the route", "in-progress"]
    ])
    expect(stage.acceptance[0]!.testReferences).toEqual([
      { path: "src/auth.test.ts", cases: ["issues tokens"] }
    ])
    expect(stage.files).toEqual([{ path: "src/auth.ts", change: "A" }])
    expect(stage.complexity).toBe("medium")
    expect(planStageExecutionStatus(stage)).toBe("running")
  })
})
