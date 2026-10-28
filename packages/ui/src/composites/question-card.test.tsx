import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { QuestionRequest } from "@jingler/core"
import { ApprovalGate } from "./approval-gate.js"
import { QuestionCard } from "./question-card.js"

afterEach(cleanup)

const request: QuestionRequest = {
  id: "q1",
  questions: [
    {
      question: "Which strategy?",
      header: "Strategy",
      multiSelect: false,
      options: [
        { label: "Rotating", description: "a" },
        { label: "Sliding", description: "b" }
      ]
    }
  ]
}

describe("QuestionCard (spec §6.10, 7.8)", () => {
  it("focuses option 1 and answers by number key", () => {
    const onSubmit = vi.fn()
    render(<QuestionCard request={request} onSubmit={onSubmit} />)
    expect(document.activeElement?.textContent).toContain("Rotating")
    fireEvent.keyDown(window, { key: "2" })
    fireEvent.keyDown(window, { key: "Enter" })
    expect(onSubmit).toHaveBeenCalledWith([{ selected: ["Sliding"], other: null }])
  })

  it("is neutral: amber only on the needs-you tick, no blue or purple", () => {
    const { container } = render(<QuestionCard request={request} onSubmit={() => {}} />)
    expect(screen.getByTestId("needs-you-tick").className).toContain("bg-state-needs")
    expect(container.innerHTML).not.toMatch(/(bg|text|border)-(blue|purple|green|red)/)
  })

  it("offers Switch session to Auto only when a handler is given", () => {
    const onSwitchToAuto = vi.fn()
    const { rerender } = render(<QuestionCard request={request} onSubmit={() => {}} />)
    expect(screen.queryByText("Switch session to Auto")).toBeNull()
    rerender(<QuestionCard request={request} onSubmit={() => {}} onSwitchToAuto={onSwitchToAuto} />)
    fireEvent.click(screen.getByText("Switch session to Auto"))
    expect(onSwitchToAuto).toHaveBeenCalledTimes(1)
  })
})

describe("ApprovalGate", () => {
  it("is neutral while pending, red only for a denial", () => {
    const { container, rerender } = render(
      <ApprovalGate kind="command" title="Run command" detail="d" command="ls" status="pending" />
    )
    expect(container.innerHTML).not.toMatch(/(bg|text|border)-(blue|green)\b/)
    rerender(<ApprovalGate kind="command" title="Run command" detail="d" status="rejected" />)
    expect(screen.getByText("Denied").className).toContain("text-state-failed")
  })
})
