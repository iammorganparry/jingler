import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
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
