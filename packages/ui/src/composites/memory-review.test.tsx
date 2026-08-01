import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { MemoryReview } from "./memory-review.js"
import type { MemoryReviewItem } from "@jingler/contracts"

afterEach(cleanup)

const FIRST_PAGE = /First/
const SECOND_PAGE = /Second/

const review: MemoryReviewItem = { id: "set:1", workflowId: "workflow:1", sourceId: "source:1", proposedBy: "agent:1", createdAt: "2026-08-01T00:00:00.000Z", status: "open", changeKind: "factual", pages: [{ proposalId: "proposal:1", pageId: "page:1", title: "First", baseRevisionId: "revision:1", summary: "Change first", markdown: "# First" }, { proposalId: "proposal:2", pageId: "page:2", title: "Second", baseRevisionId: "revision:2", summary: "Change second", markdown: "# Second" }] }

describe("MemoryReview", () => {
  it("lets an authorized reviewer inspect and decide a multi-page proposal", () => {
    const decide = vi.fn()
    render(<MemoryReview reviews={[review]} canReview selectedId="set:1" result={null} onSelect={() => {}} onReview={decide} />)
    expect(screen.getByRole("tab", { name: FIRST_PAGE })).toBeDefined()
    expect(screen.getByRole("tab", { name: SECOND_PAGE })).toBeDefined()
    fireEvent.click(screen.getByRole("button", { name: "Accept all" }))
    expect(decide).toHaveBeenCalledWith("set:1", "approve")
  })

  it("shows stale-base conflicts as text, not colour alone", () => {
    render(<MemoryReview reviews={[review]} canReview selectedId="set:1" result={{ status: "conflict", proposalId: "set:1", conflicts: [{ pageId: "page:1", expectedBaseRevisionId: "revision:1", currentHeadRevisionId: "revision:new" }] }} onSelect={() => {}} onReview={() => {}} />)
    expect(screen.getByRole("alert").textContent).toContain("Publication conflict")
    expect(screen.getByRole("alert").textContent).toContain("revision:new")
  })
})
