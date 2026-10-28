import { afterEach, describe, it, expect, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { ApprovalGate } from "./approval-gate.js"

afterEach(cleanup)

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
    expect(container.querySelector(".overflow-y-auto")).toBeTruthy()
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

describe("ApprovalGate Switch to Auto", () => {
  it("does not render Switch to Auto link when onSwitchToAuto is not provided", () => {
    render(
      <ApprovalGate
        kind="command"
        title="Run command"
        detail="cwd ~"
        command="pnpm test"
        status="pending"
      />
    )
    expect(screen.queryByText("Switch session to Auto")).toBeNull()
  })

  it("renders Switch to Auto link when onSwitchToAuto is provided and status is pending", () => {
    render(
      <ApprovalGate
        kind="command"
        title="Run command"
        detail="cwd ~"
        command="pnpm test"
        status="pending"
        onSwitchToAuto={() => {}}
      />
    )
    expect(screen.getByText("Switch session to Auto")).toBeTruthy()
  })

  it("does not render Switch to Auto link when status is not pending", () => {
    render(
      <ApprovalGate
        kind="command"
        title="Run command"
        detail="cwd ~"
        status="approved"
        onSwitchToAuto={() => {}}
      />
    )
    expect(screen.queryByText("Switch session to Auto")).toBeNull()
  })

  it("calls onSwitchToAuto when the link is clicked", async () => {
    const user = userEvent.setup()
    const onSwitchToAuto = vi.fn()
    render(
      <ApprovalGate
        kind="command"
        title="Run command"
        detail="cwd ~"
        command="pnpm test"
        status="pending"
        onSwitchToAuto={onSwitchToAuto}
      />
    )
    await user.click(screen.getByText("Switch session to Auto"))
    expect(onSwitchToAuto).toHaveBeenCalledOnce()
  })
})

describe("ApprovalGate 42-line command", () => {
  const longCommand = Array.from({ length: 42 }, (_, i) => `step ${i + 1} && \\`).join("\n")

  it("shows the toggle collapsed and keeps Approve rendered after expanding", async () => {
    const user = userEvent.setup()
    render(
      <ApprovalGate
        kind="command"
        title="Run command"
        detail="Test"
        command={longCommand}
        status="pending"
      />
    )

    expect(screen.getByLabelText(/Show all · 42 lines/)).toBeTruthy()
    expect(screen.getByText("Allow once")).toBeTruthy()

    await user.click(screen.getByLabelText(/Show all · 42 lines/))

    expect(screen.getByLabelText(/Show less/)).toBeTruthy()
    expect(screen.getByText("Allow once")).toBeTruthy()
  })
})
