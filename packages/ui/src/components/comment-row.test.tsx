import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { CommentRow } from "./comment-row.js"

afterEach(cleanup)

describe("CommentRow", () => {
  it("has a keyboard-reachable Dismiss button that fires onDismiss", () => {
    const onDismiss = vi.fn()
    render(<CommentRow severity="High" onDismiss={onDismiss}>Retry loop never backs off</CommentRow>)
    const dismiss = screen.getByRole("button", { name: "Dismiss" })
    dismiss.focus()
    expect(document.activeElement).toBe(dismiss)
    fireEvent.click(dismiss)
    expect(onDismiss).toHaveBeenCalledOnce()
  })

  it.each(["Critical", "High", "Low"])("has no coloured fill at %s severity", (severity) => {
    render(<CommentRow severity={severity}>Message</CommentRow>)
    expect(screen.getByTestId("comment-row").className).not.toMatch(/\bbg-/)
    expect(screen.getByText(severity).className).toContain("text-muted-foreground")
  })

  it("renders the action slot", () => {
    render(<CommentRow action={<button type="button">Ask agent to fix</button>}>Message</CommentRow>)
    expect(screen.getByRole("button", { name: "Ask agent to fix" })).toBeTruthy()
  })
})
