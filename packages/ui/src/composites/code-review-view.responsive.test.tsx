import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { WidthTierValue } from "../hooks/width-tier.js"
import { CodeReviewView } from "./code-review-view.js"

const file = {
  path: "src/session.ts",
  additions: 8,
  deletions: 3,
  commentCount: 0,
  viewed: false
}

const reviewAt = (
  width: number,
  props: Partial<React.ComponentProps<typeof CodeReviewView>> = {}
) => (
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
      {...props}
    />
  </WidthTierValue>
)

const renderAt = (
  width: number,
  props: Partial<React.ComponentProps<typeof CodeReviewView>> = {}
) => render(reviewAt(width, props))

beforeEach(() => {
  localStorage.clear()
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

  it("clamps a live rail drag before it can undock the layout", () => {
    renderAt(1_200)
    const handle = screen.getByRole("separator", { name: "Resize file list" })

    fireEvent.pointerDown(handle, { clientX: 0 })
    fireEvent.pointerMove(window, { clientX: 1_000 })

    expect(screen.getByRole("separator", { name: "Resize file list" })).toBeTruthy()
    expect(localStorage.getItem("sb.review.files")).toBe("338")
    fireEvent.pointerUp(window)
  })

  it("requires hysteresis before re-docking after a pane resize", async () => {
    localStorage.setItem("sb.review.files", "420")
    localStorage.setItem("sb.review.tray.v2", "400")
    const view = renderAt(1_379)

    expect(screen.getByRole("button", { name: "Changed files" })).toBeTruthy()
    view.rerender(reviewAt(1_421))
    expect(screen.getByRole("button", { name: "Changed files" })).toBeTruthy()

    view.rerender(reviewAt(1_422))
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Changed files" })).toBeNull()
    )
  })

  it("searches the rail and the continuous diff together", () => {
    const config = { ...file, path: "config.json" }
    renderAt(1_240, {
      files: [file, config],
      fileDiffs: [
        { path: file.path, diff: "" },
        { path: config.path, diff: "" }
      ]
    })

    fireEvent.change(screen.getByRole("searchbox", { name: "Search changed files" }), {
      target: { value: "config" }
    })

    expect(screen.queryByText("session.ts")).toBeNull()
    expect(screen.getAllByText("config.json").length).toBeGreaterThan(0)
  })

  it("collapses viewed code and restores it from the collapsed row", () => {
    const onToggleViewed = vi.fn()
    renderAt(1_240, {
      files: [{ ...file, viewed: true }],
      onToggleViewed
    })

    fireEvent.click(screen.getByRole("button", { name: "Viewed · code collapsed" }))
    expect(onToggleViewed).toHaveBeenCalledWith(file.path, false)
  })

  it("focus mode leaves only the middle diff pane", () => {
    renderAt(1_240)

    fireEvent.click(screen.getByRole("button", { name: "Focus diff" }))
    expect(screen.queryByTestId("review-file-rail")).toBeNull()
    expect(screen.queryByTestId("review-tray")).toBeNull()
    expect(screen.getByTestId("review-diff-center")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Exit review focus" })).toBeTruthy()
  })
})
