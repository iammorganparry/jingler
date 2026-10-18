import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { SessionPrsChip } from "./session-prs-chip.js"
import type { SessionPrRow } from "../lib/session-prs.js"

afterEach(cleanup)

const rows: ReadonlyArray<SessionPrRow> = [
  { number: 482, agent: "main", branch: null },
  { number: 491, agent: "reviewer", branch: "fix/491", state: "running", nodeId: "n1" }
]

const openChip = () => fireEvent.pointerDown(screen.getByTestId("session-prs-chip"), { button: 0, ctrlKey: false })

describe("SessionPrsChip", () => {
  it("labels the trigger with the PR count", () => {
    render(<SessionPrsChip rows={rows} onSelect={vi.fn()} />)
    expect(screen.getByTestId("session-prs-chip").textContent).toContain("PRs · 2")
  })

  it("lists each row's number, agent and branch, and opens it on select", () => {
    const onSelect = vi.fn()
    render(<SessionPrsChip rows={rows} onSelect={onSelect} />)
    openChip()
    const childRow = screen.getByTestId("session-prs-chip-row-491")
    expect(childRow.textContent).toContain("#491")
    expect(childRow.textContent).toContain("reviewer")
    expect(childRow.textContent).toContain("fix/491")
    fireEvent.click(childRow)
    expect(onSelect).toHaveBeenCalledWith(rows[1])
  })
})
