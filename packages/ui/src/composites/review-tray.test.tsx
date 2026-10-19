import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ReviewTray, type ReviewDraft } from "./review-tray.js"

afterEach(cleanup)

const drafts: ReviewDraft[] = [
  { id: "d1", path: "a.ts", line: 2, endLine: null, body: "Rename this.", routeToAgent: true },
  { id: "d2", path: "b.ts", line: 5, endLine: null, body: "Fix this.", routeToAgent: true }
]

describe("ReviewTray", () => {
  it("submits with a neutral (secondary) Submit button, not a primary action", () => {
    const onFinishReview = vi.fn()
    render(<ReviewTray drafts={drafts} onRemoveDraft={() => {}} onFinishReview={onFinishReview} />)
    const submit = screen.getByRole("button", { name: /Send 2 to agent/ })
    expect(submit.getAttribute("title")).toBe("Submit review (⌘↵)")
    expect(submit.className).not.toContain("bg-primary-fill")
    fireEvent.click(submit)
    expect(onFinishReview).toHaveBeenCalledWith("send_to_agent")
  })

  it("removes a focused comment on Backspace/Delete", () => {
    const onRemoveDraft = vi.fn()
    render(<ReviewTray drafts={drafts} onRemoveDraft={onRemoveDraft} onFinishReview={() => {}} />)
    const comment = screen.getByRole("group", { name: /a.ts/ })
    comment.focus()
    fireEvent.keyDown(comment, { key: "Backspace" })
    expect(onRemoveDraft).toHaveBeenCalledWith("d1")
  })

  it("removes a focused comment on Delete", () => {
    const onRemoveDraft = vi.fn()
    render(<ReviewTray drafts={drafts} onRemoveDraft={onRemoveDraft} onFinishReview={() => {}} />)
    const comment = screen.getByRole("group", { name: /b.ts/ })
    comment.focus()
    fireEvent.keyDown(comment, { key: "Delete" })
    expect(onRemoveDraft).toHaveBeenCalledWith("d2")
  })

  it("submits on Cmd/Ctrl+Enter from anywhere in the tray", () => {
    const onFinishReview = vi.fn()
    render(<ReviewTray drafts={drafts} onRemoveDraft={() => {}} onFinishReview={onFinishReview} />)
    const comment = screen.getByRole("group", { name: /a.ts/ })
    comment.focus()
    fireEvent.keyDown(comment, { key: "Enter", metaKey: true })
    expect(onFinishReview).toHaveBeenCalledWith("send_to_agent")
  })

  it("does nothing on Cmd+Enter when empty", () => {
    const onFinishReview = vi.fn()
    render(<ReviewTray drafts={[]} onRemoveDraft={() => {}} onFinishReview={onFinishReview} />)
    const tray = screen.getByText("Select lines in the diff to start a comment.").closest("div")
    fireEvent.keyDown(tray as HTMLElement, { key: "Enter", metaKey: true })
    expect(onFinishReview).not.toHaveBeenCalled()
  })
})
