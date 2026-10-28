import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { PrReviewComposer } from "./pr-review-composer.js"

afterEach(cleanup)

describe("PrReviewComposer draft preservation", () => {
  it("keeps text typed while the comment is still posting", async () => {
    let finish: () => void = () => {}
    const pending = new Promise<void>((resolve) => { finish = resolve })
    render(<PrReviewComposer connected commentOnly ariaLabel="Issue comment" onSubmit={() => pending} />)
    const box = screen.getByLabelText("Issue comment") as HTMLTextAreaElement

    fireEvent.change(box, { target: { value: "first" } })
    fireEvent.click(screen.getByRole("button", { name: "Comment" }))
    fireEvent.change(box, { target: { value: "first and more" } })
    await act(async () => { finish(); await pending })

    expect(box.value).toBe("first and more")
  })

  it("clears the draft once the submitted text is unchanged", async () => {
    render(<PrReviewComposer connected commentOnly ariaLabel="Issue comment" onSubmit={async () => {}} />)
    const box = screen.getByLabelText("Issue comment") as HTMLTextAreaElement
    fireEvent.change(box, { target: { value: "done" } })
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Comment" })) })
    expect(box.value).toBe("")
  })
})

describe("PrReviewComposer own-PR guard", () => {
  it("disables Approve and Request changes on your own PR but keeps Comment and the agent toggle", () => {
    render(<PrReviewComposer connected selfAuthored onSubmit={async () => {}} />)
    expect((screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole("button", { name: "Request changes" }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole("button", { name: "Comment" }) as HTMLButtonElement).disabled).toBe(false)
    expect(screen.getByText("Also send to agent")).toBeDefined()
  })

  it("sends added drawer findings with the review body and reports submission", async () => {
    const onSubmit = vi.fn(async () => {})
    const onSubmitted = vi.fn()
    const pending = [{ id: "a", severity: "issue" as const, path: "src/a.ts", line: 4, body: "Null deref." }]
    render(<PrReviewComposer connected pending={pending} onSubmitted={onSubmitted} onSubmit={onSubmit} />)
    expect(screen.getByTestId("pr-pending-comments").textContent).toContain("src/a.ts:4")
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Comment" })) })
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ body: "- **Issue** `src/a.ts:4` — Null deref.", kind: "comment" }))
    expect(onSubmitted).toHaveBeenCalledTimes(1)
  })
})
