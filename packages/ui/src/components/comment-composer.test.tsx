import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { CommentComposer } from "./comment-composer.js"

afterEach(cleanup)

const type = (text: string) =>
  fireEvent.change(screen.getByLabelText("Leave a comment"), { target: { value: text } })

describe("CommentComposer", () => {
  it("disables both actions until there is text, then posts and clears", async () => {
    const post = vi.fn().mockResolvedValue(undefined)
    render(<CommentComposer post={post} />)
    expect((screen.getByRole("button", { name: "Comment" }) as HTMLButtonElement).disabled).toBe(true)
    type("Looking into it")
    fireEvent.click(screen.getByRole("button", { name: "Comment" }))
    await waitFor(() => expect(post).toHaveBeenCalledWith("Looking into it", false))
    await waitFor(() => expect((screen.getByLabelText("Leave a comment") as HTMLTextAreaElement).value).toBe(""))
  })

  it("closes with the comment", async () => {
    const post = vi.fn().mockResolvedValue(undefined)
    render(<CommentComposer post={post} />)
    type("Fixed")
    fireEvent.click(screen.getByRole("button", { name: "Close with comment" }))
    await waitFor(() => expect(post).toHaveBeenCalledWith("Fixed", true))
  })

  it("keeps the draft and shows an inline error when the post fails", async () => {
    render(<CommentComposer post={vi.fn().mockRejectedValue(new Error("denied"))} />)
    type("Looking")
    fireEvent.click(screen.getByRole("button", { name: "Comment" }))
    expect((await screen.findByRole("alert")).textContent).toBe("denied")
    expect((screen.getByLabelText("Leave a comment") as HTMLTextAreaElement).value).toBe("Looking")
  })

  it("hides Close with comment when the issue cannot be closed", () => {
    render(<CommentComposer post={vi.fn()} canClose={false} />)
    expect(screen.queryByRole("button", { name: "Close with comment" })).toBeNull()
  })
})
