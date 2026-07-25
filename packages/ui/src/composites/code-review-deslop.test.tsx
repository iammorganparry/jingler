import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import type { PrFileChange } from "@starbase/core"
import { afterEach, describe, expect, it, vi } from "vitest"
import { WidthTierValue } from "../hooks/width-tier.js"
import { CodeReviewView } from "./code-review-view.js"

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

  it("hands the file's path to the agent", () => {
    const onDeslopFile = vi.fn()
    renderView({ onDeslopFile })
    fireEvent.click(screen.getByRole("button", { name: "Deslop" }))
    expect(onDeslopFile).toHaveBeenCalledExactlyOnceWith(file.path)
  })
})
