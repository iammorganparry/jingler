import type { Plan, PlanDocument } from "@jingler/core"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { PlanApprovalCard } from "./plan-card.js"

afterEach(cleanup)

const plan: Plan = {
  id: "p1",
  summary: "Ship the feature",
  status: "proposed",
  structured: true,
  raw: "Ship the feature",
  comments: [],
  steps: [
    {
      id: "s1",
      number: "01",
      title: "Implement it",
      intent: "Build the approved change.",
      approach: [],
      kind: "step",
      condition: null,
      parentId: null,
      dependsOn: [],
      blocks: [],
      files: [],
      guards: [],
      code: null,
      diff: null,
      status: "proposed",
      flagged: false
    }
  ]
}

const document: PlanDocument = {
  id: plan.id,
  sessionId: "session-1",
  producingChatId: "chat-1",
  revision: 1,
  status: "proposed",
  plan: {
    title: plan.summary,
    sections: [{
      id: "overview",
      title: "Overview",
      blocks: [{ kind: "prose", id: "overview-copy", text: "Canonical plan summary." }]
    }],
    stages: [{
      id: "canonical-stage",
      title: "Canonical stage",
      intent: "Use the structured plan.",
      approach: [],
      tasks: [
        { id: "task-a", text: "First stage task", status: "completed" },
        { id: "task-b", text: "Second stage task", status: "in-progress" }
      ],
      files: [],
      diagrams: [],
      notes: [],
      acceptance: []
    }],
    annotations: []
  },
  updatedAt: "2026-08-01T00:00:00.000Z",
  updatedBy: "agent"
}

describe("PlanApprovalCard projection", () => {
  it("offers read-only review navigation without approval controls", () => {
    const onOpenReview = vi.fn()
    render(<PlanApprovalCard plan={plan} onOpenReview={onOpenReview} />)

    expect(screen.getByTestId("plan-approval-card")).toBeTruthy()
    expect(screen.getByText("1").textContent).toBe(String(plan.steps.length))
    expect(screen.getByText("Implement it")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "View Plan" }))
    expect(onOpenReview).toHaveBeenCalledOnce()

    expect(screen.queryByRole("button", { name: /^Approve$/ })).toBeNull()
  })

  it("renders canonical stages and tracks their live task status", () => {
    const view = render(<PlanApprovalCard plan={plan} document={document} />)

    expect(screen.getByText("Canonical plan summary.")).toBeTruthy()
    expect(screen.getByText("Canonical stage")).toBeTruthy()
    expect(screen.getByText("First stage task")).toBeTruthy()
    expect(screen.getByText("Second stage task")).toBeTruthy()
    expect(screen.queryByText("Implement it")).toBeNull()
    expect(screen.getByTestId("plan-approval-stage-canonical-stage").dataset.status)
      .toBe("running")

    view.rerender(<PlanApprovalCard plan={plan} document={{
      ...document,
      plan: {
        ...document.plan,
        stages: [{
          ...document.plan.stages[0]!,
          tasks: (document.plan.stages[0]!.tasks ?? []).map((task) => ({
            ...task,
            status: "completed" as const
          }))
        }]
      }
    }} />)
    expect(screen.getByTestId("plan-approval-stage-canonical-stage").dataset.status)
      .toBe("completed")
  })
})
