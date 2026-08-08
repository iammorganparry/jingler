// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import type { PlanPrd } from "@jingler/core"
import { afterEach, describe, expect, it, vi } from "vitest"
import { PlanGuide } from "./plan-guide.js"

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
    diagrams: [{ id: "runtime-flow", source: "flowchart LR; Session-->Runtime" }],
    notes: [],
    walkthrough: [
      { kind: "prose", id: "runtime-why", text: "This keeps callers provider-neutral." },
      { kind: "code", id: "runtime-code", language: "ts", code: "await runtime.execute(input)" }
    ],
    callPathDiff: {
      before: [{ symbol: "Session.run", path: "src/session.ts" }, { symbol: "Claude.execute" }],
      after: [{ symbol: "Session.run", path: "src/session.ts" }, { symbol: "Runtime.execute" }]
    },
    acceptance: [],
    dependencies: []
  }],
  annotations: []
}

describe("PlanGuide", () => {
  it("weaves walkthrough, architecture, and call-path changes into one stage", () => {
    const onOpenStep = vi.fn()
    render(<PlanGuide prd={plan} selectedStageId="stage-runtime" onOpenStep={onOpenStep} />)

    const section = screen.getByRole("region", { name: "Guide for Add the runtime boundary" })
    expect(section.getAttribute("data-stage")).toBe("stage-runtime")
    expect(screen.getByText("This keeps callers provider-neutral.")).toBeTruthy()
    expect(screen.getByText("await runtime.execute(input)")).toBeTruthy()
    expect(screen.getByText("Before")).toBeTruthy()
    expect(screen.getByText("Claude.execute")).toBeTruthy()
    expect(screen.getByText("After")).toBeTruthy()
    expect(screen.getByText("Runtime.execute")).toBeTruthy()
    expect(screen.getByLabelText("Diagram runtime-flow")).toBeTruthy()

    fireEvent.click(screen.getByRole("button", { name: "Open step Add the runtime boundary" }))
    expect(onOpenStep).toHaveBeenCalledWith("stage-runtime")
  })

  it("falls back to the stage approach for a legacy plan", () => {
    render(<PlanGuide prd={{
      ...plan,
      stages: [{ ...plan.stages[0]!, walkthrough: [] }]
    }} />)
    expect(screen.getByText("Define the interface")).toBeTruthy()
  })
})
