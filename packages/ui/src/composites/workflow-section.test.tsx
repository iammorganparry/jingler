import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { WorkflowSection } from "./workflow-section.js"

afterEach(cleanup)

describe("WorkflowSection", () => {
  it("collapses to a one-row summary and expands to show setup retry/skip", () => {
    render(
      <WorkflowSection
        lifecycle={{ status: "setup-failed", updatedAt: "now", error: "boom" }}
        commands={[]}
        runs={[]}
        onRetrySetup={vi.fn()}
        onSkipSetup={vi.fn()}
      />
    )
    expect(screen.getByText("Workflow")).toBeTruthy()
    expect(screen.getByText("Setup failed")).toBeTruthy()
    // Collapsed by default — the details element isn't open.
    expect((screen.getByTestId("pr-workflow-section") as HTMLDetailsElement).open).toBe(false)
    fireEvent.click(screen.getByText("Workflow"))
    expect(screen.getByText("Setup failed: boom")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Retry setup" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Skip setup" })).toBeTruthy()
  })

  it("calls onRetrySetup and onSkipSetup when their buttons are clicked", () => {
    const onRetrySetup = vi.fn()
    const onSkipSetup = vi.fn()
    render(
      <WorkflowSection
        lifecycle={{ status: "setup-failed", updatedAt: "now", error: "boom" }}
        commands={[]}
        runs={[]}
        onRetrySetup={onRetrySetup}
        onSkipSetup={onSkipSetup}
      />
    )
    fireEvent.click(screen.getByRole("button", { name: "Retry setup" }))
    fireEvent.click(screen.getByRole("button", { name: "Skip setup" }))
    expect(onRetrySetup).toHaveBeenCalledTimes(1)
    expect(onSkipSetup).toHaveBeenCalledTimes(1)
  })

  it("shows configured run commands once ready, and calls onStartRun", () => {
    const onStartRun = vi.fn()
    render(
      <WorkflowSection
        lifecycle={{ status: "ready", updatedAt: "now" }}
        commands={[{ id: "dev", label: "Dev", command: "npm run dev" }]}
        runs={[]}
        onStartRun={onStartRun}
      />
    )
    fireEvent.click(screen.getByRole("button", { name: "Run Dev" }))
    expect(onStartRun).toHaveBeenCalledWith("dev")
  })
})
