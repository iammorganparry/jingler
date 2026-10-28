import type { PrReviewThread } from "@jingler/core"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { PrReviewGroup } from "./pr-review-group.js"

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const thread: PrReviewThread = {
  id: "PRRT_1", reviewId: "PRR_1", path: "src/a.ts", line: 4, startLine: null, originalLine: 4, originalStartLine: null,
  diffHunk: "@@ -1,1 +1,2 @@\n+x", isResolved: false, isOutdated: false, resolvedBy: null,
  comments: [{
    id: "PRRC_1", databaseId: 1001, author: "greptile-apps", authorAvatarUrl: null, isBot: true,
    association: "NONE", body: "Needs a guard", createdAt: "2026-07-15T20:15:10Z", reactions: []
  }]
}

describe("PrReviewGroup", () => {
  it("uses no hue-coded colour for the review header, bot badge or resolved badge", () => {
    const { container } = render(
      <PrReviewGroup threads={[thread, { ...thread, id: "PRRT_2", isResolved: true, resolvedBy: "dan" }]} />
    )
    expect(screen.getAllByText("Bot").length).toBeGreaterThan(0)
    expect(screen.getByText("Resolved")).toBeTruthy()
    expect(container.innerHTML).not.toMatch(/(text|bg)-(blue|green|red|purple|yellow)/)
  })

  it("routes Resolve and Reply to the supplied callbacks", async () => {
    const onResolve = vi.fn()
    const onReply = vi.fn()
    render(<PrReviewGroup threads={[thread]} onResolve={onResolve} onReply={onReply} />)

    fireEvent.click(screen.getByText("Resolve conversation"))
    await waitFor(() => expect(onResolve).toHaveBeenCalledWith("PRRT_1", true))

    fireEvent.change(screen.getByPlaceholderText("Reply…"), { target: { value: "Done" } })
    fireEvent.click(screen.getByText("Reply"))
    await waitFor(() => expect(onReply).toHaveBeenCalledWith(1001, "Done"))
  })
})
