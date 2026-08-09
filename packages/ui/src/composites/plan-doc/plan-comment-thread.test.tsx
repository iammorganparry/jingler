import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { PlanCommentComposer } from "./plan-comment-thread.js"

describe("PlanCommentComposer", () => {
  it("submits a comment to the selected workspace agent without participant routing", async () => {
    const onSubmit = vi.fn(async () => true)
    render(<PlanCommentComposer onSubmit={onSubmit} />)
    fireEvent.change(screen.getByLabelText("Reply to this thread…"), {
      target: { value: "Please account for the migration edge case." }
    })
    fireEvent.click(screen.getByRole("button", { name: "Send reply" }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(
      "Please account for the migration edge case.",
      []
    ))
    expect(screen.getByText("This comment is handled by the selected workspace agent.")).toBeTruthy()
  })
})
