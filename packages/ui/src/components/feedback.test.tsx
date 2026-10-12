import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { EmptyState, InlineError, ListSkeleton } from "./feedback.js"

afterEach(cleanup)

describe("InlineError", () => {
  it("renders Retry and calls onRetry when clicked", async () => {
    const onRetry = vi.fn()
    render(<InlineError message="Couldn't load PRs" onRetry={onRetry} />)
    await userEvent.click(screen.getByRole("button", { name: "Retry" }))
    expect(onRetry).toHaveBeenCalledOnce()
  })

  it("omits Retry without onRetry", () => {
    render(<InlineError message="Couldn't load PRs" />)
    expect(screen.queryByRole("button")).toBeNull()
  })
})

describe("ListSkeleton", () => {
  it("renders the requested rows at the real row height", () => {
    render(<ListSkeleton rows={4} rowHeight={44} />)
    const rows = screen.getAllByRole("status")
    expect(rows).toHaveLength(4)
    expect(rows[0]?.style.height).toBe("44px")
  })
})

describe("EmptyState", () => {
  it("shows the title and the next action", () => {
    render(<EmptyState title="No open PRs" action={<button type="button">Create PR</button>} />)
    expect(screen.getByText("No open PRs")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Create PR" })).toBeTruthy()
  })
})
