import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { ApprovalGate } from "./approval-gate.js"

describe("ApprovalGate long command", () => {
  it("clamps long commands to 6 lines with expand toggle", async () => {
    const longCommand = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n")
    const { container } = render(
      <ApprovalGate
        kind="command"
        title="Run command"
        detail="Test"
        command={longCommand}
        status="pending"
      />
    )

    const toggle = screen.getByLabelText(/Show all · 10 lines/)
    expect(toggle).toBeTruthy()

    const commandBlock = container.querySelector(".h-24")
    expect(commandBlock).toBeTruthy()

    await userEvent.click(toggle)
    expect(screen.getByLabelText(/Show less/)).toBeTruthy()
    expect(container.querySelector(".h-24")).toBeFalsy()
    expect(container.querySelector(".max-h-80")).toBeTruthy()
  })

  it("does not show toggle for short commands", () => {
    render(
      <ApprovalGate
        kind="command"
        title="Run command"
        detail="Test"
        command="pnpm test"
        status="pending"
      />
    )

    expect(screen.queryByLabelText(/Show all/)).toBeFalsy()
  })

  it("shows copy button", () => {
    const { container } = render(
      <ApprovalGate
        kind="command"
        title="Run command"
        detail="Test"
        command="pnpm test"
        status="pending"
      />
    )

    const copyButton = container.querySelector('button[aria-label="Copy command"]')
    expect(copyButton).toBeTruthy()
  })
})
