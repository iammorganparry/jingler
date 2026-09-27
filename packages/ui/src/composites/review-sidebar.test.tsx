import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ReviewSidebar } from "./changes-review.js"

afterEach(cleanup)

const SEND_ONE = /Send 1 to agent/

const base = {
  source: "local" as const,
  connected: true,
  routeTargetSession: "Session",
  paths: new Set<string>(["a.ts"]),
  onRemoveDraft: () => {},
  onFinishReview: () => {}
}

describe("ReviewSidebar", () => {
  it("takes no space until something has been collected", () => {
    render(<ReviewSidebar {...base} drafts={[]} />)
    expect(screen.queryByTestId("review-tray")).toBeNull()
  })

  it("appears with collected drafts and finishes the review", () => {
    const onFinishReview = vi.fn()
    render(
      <ReviewSidebar
        {...base}
        onFinishReview={onFinishReview}
        drafts={[{ id: "d1", path: "a.ts", line: 2, endLine: null, body: "Rename this.", routeToAgent: true }]}
      />
    )
    expect(screen.getByTestId("review-tray")).toBeTruthy()
    expect(screen.getByText("Rename this.")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: SEND_ONE }))
    expect(onFinishReview).toHaveBeenCalledWith("send_to_agent")
  })

  it("asks to connect GitHub before posting a PR review", () => {
    render(
      <ReviewSidebar
        {...base}
        source="pr"
        connected={false}
        onConnectGithub={() => {}}
        drafts={[{ id: "d1", path: "a.ts", line: 2, endLine: null, body: "x", routeToAgent: false }]}
      />
    )
    expect(screen.getByText("Connect GitHub to post this review.")).toBeTruthy()
  })
})
