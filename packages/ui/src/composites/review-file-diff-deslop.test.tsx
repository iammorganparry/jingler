import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import type { PrFileChange } from "@jingler/core"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { WidthTierValue } from "../hooks/width-tier.js"
import { ReviewFileDiff } from "./changes-review.js"

/**
 * The per-file "Deslop" button sits in each file's sticky header, beside Revert.
 * It hands that file to the session's agent for an in-place cleanup pass — so it
 * must call back with the file's path, and appear only when a handler is supplied.
 */

const file: PrFileChange = {
  path: "src/session.ts",
  additions: 8,
  deletions: 3,
  commentCount: 0,
  viewed: false
}

const renderView = (props: Partial<React.ComponentProps<typeof ReviewFileDiff>>) =>
  render(
    <WidthTierValue width={1_240}>
      <ReviewFileDiff
        file={file}
        diff=""
        source="local"
        drafts={[]}
        routeTargetSession="Session"
        connected
        focused={false}
        onToggleFocus={() => {}}
        onToggleViewed={() => {}}
        onAddDraft={() => {}}
        onRemoveDraft={() => {}}
        {...props}
      />
    </WidthTierValue>
  )

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("ReviewFileDiff Deslop button", () => {
  it("hides the button when no handler is supplied", () => {
    renderView({})
    expect(screen.queryByRole("button", { name: "Deslop" })).toBeNull()
  })

  it("hands the file's path to the agent", () => {
    const onDeslopFile = vi.fn()
    renderView({ onDeslopFile })
    fireEvent.click(screen.getByRole("button", { name: "Deslop" }))
    expect(onDeslopFile).toHaveBeenCalledExactlyOnceWith(file.path)
  })
})
