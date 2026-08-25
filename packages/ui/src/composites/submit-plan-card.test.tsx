// @vitest-environment jsdom
import type { Message, ToolCall } from "@jingler/core"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { MessageTurn } from "./message-turn.js"
import { decodeSubmitPlanDecision } from "./submit-plan-card.js"

afterEach(cleanup)

const DISCARD_LABEL = /Discard plan/
const CONFIRM_DISCARD_LABEL = /Click again to discard/

const submitTool = (overrides: Partial<ToolCall> = {}): ToolCall => ({
  id: "t1",
  name: "jingler_submit_plan",
  target: null,
  status: "success",
  meta: null,
  diff: null,
  preview: null,
  ...overrides
})

const approveOutput = JSON.stringify({
  _tag: "Approve",
  mode: "auto",
  plan: {
    id: "plan-1",
    summary: "Ship the widget",
    steps: [
      { id: "s1", title: "Wire the schema", kind: "step" },
      { id: "s2", title: "Either arm", kind: "branch-arm" },
      { id: "s3", title: "Render the card", kind: "step" }
    ],
    comments: [],
    status: "approved",
    raw: "# plan"
  }
})

const turn = (parts: Message["parts"]): Message => ({
  id: "a1",
  role: "assistant",
  streaming: false,
  createdAt: "2026-08-24T00:00:00.000Z",
  parts
})

describe("decodeSubmitPlanDecision", () => {
  it("reads an approval with its mode and a bounded plan preview", () => {
    const decision = decodeSubmitPlanDecision(approveOutput)
    expect(decision).toMatchObject({ kind: "approved", mode: "auto" })
    expect(decision?.kind === "approved" && decision.plan).toMatchObject({
      id: "plan-1",
      summary: "Ship the widget",
      // branch-arm steps are alternatives, not work items — excluded like the
      // plan approval card does.
      steps: [
        { id: "s1", title: "Wire the schema" },
        { id: "s3", title: "Render the card" }
      ]
    })
  })

  it("reads reject and revise, and returns null for capped/garbage output", () => {
    expect(decodeSubmitPlanDecision(JSON.stringify({ _tag: "Reject" }))).toEqual({
      kind: "rejected"
    })
    expect(
      decodeSubmitPlanDecision(JSON.stringify({ _tag: "Revise", feedback: "no" }))
    ).toEqual({ kind: "revise" })
    expect(decodeSubmitPlanDecision(undefined)).toBeNull()
    expect(decodeSubmitPlanDecision(`${approveOutput.slice(0, 80)}… omitted …`)).toBeNull()
  })
})

describe("submit-plan tool part rendering", () => {
  it("renders the plan card — never the decision's raw JSON", () => {
    const view = render(
      <MessageTurn
        message={turn([{ _tag: "Tool", tool: submitTool({ output: approveOutput }) }])}
      />
    )
    expect(screen.getByTestId("submit-plan-card")).toBeTruthy()
    expect(view.container.textContent).toContain("Ship the widget")
    expect(view.container.textContent).toContain("Approved")
    expect(view.container.textContent).toContain("auto")
    expect(view.container.textContent).not.toContain('"_tag"')
  })

  it("keeps a readable card when the capped output truncated the JSON", () => {
    const truncated = `${approveOutput.slice(0, 120)}\n\n… 9,000 characters omitted …`
    const view = render(
      <MessageTurn
        message={turn([{ _tag: "Tool", tool: submitTool({ output: truncated }) }])}
      />
    )
    expect(view.container.textContent).toContain("Plan submitted")
    expect(view.container.textContent).toContain("Ship the widget")
    expect(view.container.textContent).not.toContain("… omitted")
  })

  it("shows a quiet submitting row while the tool runs", () => {
    const view = render(
      <MessageTurn message={turn([{ _tag: "Tool", tool: submitTool({ status: "running" }) }])} />
    )
    expect(view.container.textContent).toContain("Submitting plan…")
  })

  it("disappears when the same turn carries the plan's approval card", () => {
    const plan = {
      id: "plan-1",
      summary: "Ship the widget",
      steps: [],
      comments: [],
      status: "approved" as const,
      structured: true,
      raw: "# plan"
    }
    render(
      <MessageTurn
        message={turn([
          { _tag: "Tool", tool: submitTool({ output: approveOutput }) },
          { _tag: "Plan", plan }
        ])}
      />
    )
    expect(screen.queryByTestId("submit-plan-card")).toBeNull()
    expect(screen.getByTestId("plan-approval-card")).toBeTruthy()
  })
})

describe("submit-plan card actions and grouping", () => {
  it("discard arms on the first click and fires on the second", () => {
    const onDiscardPlan = vi.fn()
    render(
      <MessageTurn
        message={turn([{ _tag: "Tool", tool: submitTool({ output: approveOutput }) }])}
        onDiscardPlan={onDiscardPlan}
      />
    )
    fireEvent.click(screen.getByRole("button", { name: DISCARD_LABEL }))
    expect(onDiscardPlan).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: CONFIRM_DISCARD_LABEL }))
    expect(onDiscardPlan).toHaveBeenCalledTimes(1)
  })

  it("stays out of collapsed tool-run groups", () => {
    const read = (id: string): ToolCall => ({
      id,
      name: "Read",
      target: `src/${id}.ts`,
      status: "success",
      meta: null,
      diff: null,
      preview: null
    })
    const view = render(
      <MessageTurn
        message={turn([
          { _tag: "Tool", tool: read("r1") },
          { _tag: "Tool", tool: read("r2") },
          { _tag: "Tool", tool: submitTool({ output: approveOutput }) },
          { _tag: "Tool", tool: read("r3") }
        ])}
      />
    )
    // The submit card renders standalone; the surrounding Reads are too few
    // on each side to collapse, so no "+ N more" group swallows it.
    expect(screen.getByTestId("submit-plan-card")).toBeTruthy()
    expect(view.container.textContent).not.toContain("more tool")
  })
})
