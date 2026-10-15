import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { AgentCard } from "./agent-card.js"

afterEach(cleanup)

describe("AgentCard end states", () => {
  it("draws completed and stopped as neutral icon rows with distinct icons and words", () => {
    render(
      <>
        <AgentCard file="a.ts" state="done" status="3 files" />
        <AgentCard file="b.ts" state="stopped" status="stopped by you" />
      </>
    )
    const done = screen.getByTestId("agent-card-icon-done")
    const stopped = screen.getByTestId("agent-card-icon-stopped")
    expect(done.getAttribute("class")).toContain("text-muted-foreground")
    expect(stopped.getAttribute("class")).toContain("text-muted-foreground")
    expect(done.innerHTML).not.toBe(stopped.innerHTML)
    expect(screen.getByText("done")).toBeTruthy()
    expect(screen.getByText("stopped")).toBeTruthy()
  })

  it("draws failed with a red icon, the reason, and Resume / View transcript", () => {
    const onResume = vi.fn()
    const onViewTranscript = vi.fn()
    render(<AgentCard file="c.ts" state="failed" reason="Tool timed out" onResume={onResume} onViewTranscript={onViewTranscript} />)
    expect(screen.getByTestId("agent-card-icon-failed").getAttribute("class")).toContain("text-state-failed")
    expect(screen.getByText("Tool timed out")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Resume" }))
    fireEvent.click(screen.getByRole("button", { name: "View transcript" }))
    expect(onResume).toHaveBeenCalledOnce()
    expect(onViewTranscript).toHaveBeenCalledOnce()
  })

  it("offers no failure actions on non-failed cards", () => {
    render(<AgentCard file="d.ts" state="done" onResume={vi.fn()} onViewTranscript={vi.fn()} />)
    expect(screen.queryByRole("button")).toBeNull()
  })
})
