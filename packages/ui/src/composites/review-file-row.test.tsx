import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import type { PrFileChange } from "@starbase/core"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ReviewFileRow } from "./review-file-row.js"

/**
 * The Deslop button spawns an isolated cleanup session for one file. It must not
 * also select the row (its click is stopPropagation'd), it only appears when a
 * handler is supplied, and it goes inert at the concurrency cap — getting any of
 * those wrong either fires an unwanted turn or strands the operator.
 */

const file: PrFileChange = {
  path: "src/services/foo.ts",
  additions: 3,
  deletions: 1,
  commentCount: 0,
  viewed: false
}

afterEach(cleanup)

describe("ReviewFileRow Deslop button", () => {
  it("hides the button when no handler is supplied", () => {
    render(<ReviewFileRow file={file} active={false} onSelect={() => {}} onToggleViewed={() => {}} />)
    expect(screen.queryByRole("button", { name: "Deslop" })).toBeNull()
  })

  it("fires onDeslop without selecting the row", () => {
    const onDeslop = vi.fn()
    const onSelect = vi.fn()
    render(
      <ReviewFileRow
        file={file}
        active={false}
        onSelect={onSelect}
        onToggleViewed={() => {}}
        onDeslop={onDeslop}
      />
    )
    fireEvent.click(screen.getByRole("button", { name: "Deslop" }))
    expect(onDeslop).toHaveBeenCalledOnce()
    expect(onSelect).not.toHaveBeenCalled()
  })

  it("disables the button at the concurrency cap", () => {
    const onDeslop = vi.fn()
    render(
      <ReviewFileRow
        file={file}
        active={false}
        onSelect={() => {}}
        onToggleViewed={() => {}}
        onDeslop={onDeslop}
        deslopDisabled
      />
    )
    const button = screen.getByRole("button", { name: "Deslop" })
    expect(button).toHaveProperty("disabled", true)
    fireEvent.click(button)
    expect(onDeslop).not.toHaveBeenCalled()
  })
})
