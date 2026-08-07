// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import type { PlanPrd } from "@jingler/core"
import { afterEach, describe, expect, it, vi } from "vitest"
import { PlanWalkthrough } from "./plan-walkthrough.js"

afterEach(cleanup)

const plan: PlanPrd = {
  title: "PRD: Walkthrough",
  sections: [],
  stages: [{
    id: "stage-runtime",
    title: "Add the runtime boundary",
    intent: "Keep provider details behind one interface.",
    approach: ["Define the interface", "Move provider calls behind it"],
    tasks: [],
    files: [],
    diagrams: [],
    notes: [],
    walkthrough: [
      { kind: "prose", id: "runtime-why", text: "This keeps callers provider-neutral." },
      { kind: "code", id: "runtime-code", language: "ts", code: "await runtime.execute(input)" }
    ],
    acceptance: [],
    dependencies: []
  }],
  annotations: []
}

describe("PlanWalkthrough", () => {
  it("renders tutorial blocks with stable stage anchors and links back to the step", () => {
    const onOpenStep = vi.fn()
    render(<PlanWalkthrough prd={plan} selectedStageId="stage-runtime" onOpenStep={onOpenStep} />)

    const section = screen.getByRole("region", { name: "Walkthrough for Add the runtime boundary" })
    expect(section.getAttribute("data-stage")).toBe("stage-runtime")
    expect(screen.getByText("This keeps callers provider-neutral.")).toBeTruthy()
    expect(screen.getByText("await runtime.execute(input)")).toBeTruthy()

    fireEvent.click(screen.getByRole("button", { name: "Open step Add the runtime boundary" }))
    expect(onOpenStep).toHaveBeenCalledWith("stage-runtime")
  })

  it("falls back to the stage approach for a legacy plan", () => {
    render(<PlanWalkthrough prd={{
      ...plan,
      stages: [{ ...plan.stages[0]!, walkthrough: [] }]
    }} />)
    expect(screen.getByText("Define the interface")).toBeTruthy()
  })
})
