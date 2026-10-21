import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ClosedIssueBanner, IssueRail, IssueStateView } from "./issue-rail.js"

afterEach(cleanup)

describe("IssueRail", () => {
  it("hides empty sections and shows only the provider block", () => {
    render(<IssueRail provider="GitHub" repository="acme/widget" />)
    expect(screen.queryByText("Assignees")).toBeNull()
    expect(screen.queryByText("Labels")).toBeNull()
    expect(screen.queryByText("Linked workspace / PR")).toBeNull()
    expect(screen.getByText("acme/widget")).toBeTruthy()
  })

  it("shows Open workspace for a linked workspace", async () => {
    const onOpen = vi.fn()
    render(<IssueRail provider="GitHub" repository="a/b" workspace={{ title: "WS", onOpen }} pullRequests={[{ number: 3, state: "open", url: "u" }]} />)
    await userEvent.click(screen.getByRole("button", { name: "Open workspace" }))
    expect(onOpen).toHaveBeenCalled()
    expect(screen.getByText(/#3/)).toBeTruthy()
  })
})

describe("IssueStateView / ClosedIssueBanner", () => {
  it("renders loading, unlinked, error with Retry, and closed with Reopen", async () => {
    const onRetry = vi.fn()
    const onLink = vi.fn()
    const onReopen = vi.fn()
    const { rerender } = render(<IssueStateView state={{ kind: "loading" }} />)
    expect(screen.getByTestId("issue-state-loading")).toBeTruthy()
    rerender(<IssueStateView state={{ kind: "unlinked", onLink }} />)
    expect(screen.getByText("No issue is linked to this session.")).toBeTruthy()
    await userEvent.click(screen.getByRole("button", { name: "Link issue" }))
    expect(onLink).toHaveBeenCalled()
    rerender(<IssueStateView state={{ kind: "error", reason: "boom", onRetry }} />)
    expect(screen.getByText(/couldn.t be loaded/)).toBeTruthy()
    await userEvent.click(screen.getByRole("button", { name: "Retry" }))
    expect(onRetry).toHaveBeenCalled()
    cleanup()
    render(<ClosedIssueBanner onReopen={onReopen} />)
    await userEvent.click(screen.getByRole("button", { name: "Reopen" }))
    expect(onReopen).toHaveBeenCalled()
  })
})
