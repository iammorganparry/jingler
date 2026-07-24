import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { WidthTierValue } from "../hooks/width-tier.js"
import { CodeReviewView } from "./code-review-view.js"

const file = {
  path: "src/session.ts",
  additions: 8,
  deletions: 3,
  commentCount: 0,
  viewed: false
}

const renderAt = (width: number) =>
  render(
    <WidthTierValue width={width}>
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
      />
    </WidthTierValue>
  )

beforeEach(() => localStorage.clear())
afterEach(cleanup)

describe("CodeReviewView responsive rails", () => {
  it("docks default rails when they leave a readable diff", () => {
    renderAt(1_240)

    expect(screen.queryByRole("button", { name: "Changed files" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Review drafts" })).toBeNull()
  })

  it("turns oversized persisted rails into sheets in split screen", () => {
    localStorage.setItem("sb.review.files", "420")
    localStorage.setItem("sb.review.tray.v2", "400")
    renderAt(1_140)

    expect(screen.getByRole("button", { name: "Changed files" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Review drafts" })).toBeTruthy()
    expect(screen.queryByRole("separator", { name: "Resize file list" })).toBeNull()
    expect(screen.queryByRole("separator", { name: "Resize review panel" })).toBeNull()
  })
})
