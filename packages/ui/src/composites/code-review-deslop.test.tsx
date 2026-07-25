import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import type { PrFileChange } from "@starbase/core"
import { afterEach, describe, expect, it, vi } from "vitest"
import { WidthTierValue } from "../hooks/width-tier.js"
import { CodeReviewView } from "./code-review-view.js"

/**
 * The per-file "Deslop" button sits in each file's sticky header, beside Revert.
 * It spawns an isolated cleanup session for that file — so it must call back with
 * the file's path, appear only when a handler is supplied, and go inert at the
 * concurrency cap (where clicking must not fire another spawn).
 */

const file: PrFileChange = {
  path: "src/session.ts",
  additions: 8,
  deletions: 3,
  commentCount: 0,
  viewed: false
}

const renderView = (props: Partial<React.ComponentProps<typeof CodeReviewView>>) =>
  render(
    <WidthTierValue width={1_240}>
      <CodeReviewView
        files={[file]}
        activePath={file.path}
        fileDiffs={[{ path: file.path, diff: "" }]}
        drafts={[]}
        routeTargetSession="Session"
        connected
        source="local"
        prAvailable
        localAvailable
        onSetSource={() => {}}
        onSelectFile={() => {}}
        onToggleViewed={() => {}}
        onAddDraft={() => {}}
        onRemoveDraft={() => {}}
        onFinishReview={() => {}}
        {...props}
      />
    </WidthTierValue>
  )

afterEach(cleanup)

describe("CodeReviewView Deslop button", () => {
  it("hides the button when no handler is supplied", () => {
    renderView({})
    expect(screen.queryByRole("button", { name: "Deslop" })).toBeNull()
  })

  it("spawns a cleanup session for the file's path", () => {
    const onDeslopFile = vi.fn()
    renderView({ onDeslopFile })
    fireEvent.click(screen.getByRole("button", { name: "Deslop" }))
    expect(onDeslopFile).toHaveBeenCalledExactlyOnceWith(file.path)
  })

  it("disables the button at the concurrency cap", () => {
    const onDeslopFile = vi.fn()
    renderView({ onDeslopFile, deslopAtCap: true })
    const button = screen.getByRole("button", { name: "Deslop" })
    expect(button).toHaveProperty("disabled", true)
    fireEvent.click(button)
    expect(onDeslopFile).not.toHaveBeenCalled()
  })
})
