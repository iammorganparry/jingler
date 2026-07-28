import type { ExecutionMode, Plan } from "@jingler/core"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { PlanCard } from "./plan-card.js"
import { PlanReview } from "../screens/plan-review.js"

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

describe("PlanCard approval", () => {
  it("offers the selected mode and an explicit auto path as one grouped choice", () => {
    const approvals: Array<ExecutionMode | undefined> = []
    render(<PlanCard plan={plan} onApprove={(mode) => approvals.push(mode)} />)

    const group = screen.getByRole("group", { name: "Plan approval options" })
    expect(group).toBeTruthy()

    fireEvent.click(screen.getByRole("button", { name: /^Approve$/ }))
    fireEvent.click(screen.getByRole("button", { name: /^Approve and auto$/ }))

    expect(approvals).toStrictEqual([undefined, "auto"])
  })

  it("disables inline approval until the canonical revision is available", () => {
    render(<PlanCard plan={plan} />)

    expect(screen.getByRole("button", { name: /^Approve$/ })).toHaveProperty(
      "disabled",
      true
    )
    expect(screen.getByRole("button", { name: /^Approve and auto$/ })).toHaveProperty(
      "disabled",
      true
    )
  })
})

describe("compact Plan Review", () => {
  it("opens the step detail without squeezing fixed-width navigation and changes rails beside it", () => {
    render(<PlanReview plan={plan} compact />)

    expect(screen.getByText("Intent")).toBeTruthy()
    expect(screen.queryByLabelText("Resize step list")).toBeNull()
    expect(screen.queryByLabelText("Resize changes")).toBeNull()
  })
})
