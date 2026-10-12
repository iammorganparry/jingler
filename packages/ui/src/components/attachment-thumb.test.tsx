import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { AttachmentThumb } from "./attachment-thumb.js"

afterEach(cleanup)

const attachment = { name: "shot.png", mediaType: "image/png", data: "AAAA" } as never

describe("AttachmentThumb remove", () => {
  it("is a labelled, focusable button that fires onRemove", () => {
    const onRemove = vi.fn()
    render(<AttachmentThumb attachment={attachment} onRemove={onRemove} className="size-[58px]" />)
    const remove = screen.getByRole("button", { name: "Remove image" })
    remove.focus()
    expect(document.activeElement).toBe(remove)
    fireEvent.click(remove)
    expect(onRemove).toHaveBeenCalledOnce()
  })

  it("has no remove button when read-only", () => {
    render(<AttachmentThumb attachment={attachment} />)
    expect(screen.queryByRole("button")).toBeNull()
  })
})
