import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { EmptyState, InlineError, ListSkeleton } from "./feedback.js"

afterEach(cleanup)

describe("ListSkeleton", () => {
  it("renders busy rows at the real row height, hidden from assistive tech", () => {
    render(<ListSkeleton rows={4} rowHeight={28} label="Loading sessions" />)
    const region = screen.getByRole("status", { name: "Loading sessions" })
    expect(region.getAttribute("aria-busy")).toBe("true")
    const rows = screen.getAllByTestId("list-skeleton-row")
    expect(rows).toHaveLength(4)
    for (const row of rows) {
      expect(row.getAttribute("aria-hidden")).toBe("true")
      expect(row.style.height).toBe("28px")
    }
  })
})

describe("EmptyState", () => {
  it("shows the heading and the next action", () => {
    const onCreate = vi.fn()
    render(<EmptyState title="No sessions yet" action={<button type="button" onClick={onCreate}>New session</button>} />)
    expect(screen.getByRole("heading", { name: "No sessions yet" })).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "New session" }))
    expect(onCreate).toHaveBeenCalledOnce()
  })
})

describe("InlineError", () => {
  it("announces the error and fires Retry", () => {
    const onRetry = vi.fn()
    render(<InlineError onRetry={onRetry}>Couldn't load PRs</InlineError>)
    expect(screen.getByRole("alert").textContent).toContain("Couldn't load PRs")
    fireEvent.click(screen.getByRole("button", { name: "Retry" }))
    expect(onRetry).toHaveBeenCalledOnce()
  })

  it("has no Retry button without onRetry", () => {
    render(<InlineError>Couldn't load PRs</InlineError>)
    expect(screen.queryByRole("button")).toBeNull()
  })
})
