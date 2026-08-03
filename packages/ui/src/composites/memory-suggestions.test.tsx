import type { MemorySuggestion } from "@jingler/contracts"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { MemorySuggestionsPanel } from "./memory-suggestions.js"

afterEach(cleanup)

/**
 * The panel exists to surface advisory relatedness WITHOUT ever implying it is an
 * accepted edge. So the behaviours that matter are (1) it is unmistakably labelled
 * non-authoritative, (2) promoting a suggestion routes to the existing proposal
 * flow with the related page as the target, and (3) it stays silent when empty.
 */
const suggestion = (over: Partial<MemorySuggestion> = {}): MemorySuggestion => ({
  sourceId: "garden",
  targetId: "compost",
  method: "lexical",
  score: 0.42,
  sourceTitle: "Garden",
  targetTitle: "Compost",
  evidence: {
    method: "lexical",
    cosine: 0.42,
    sharedTerms: ["tomatoes", "peppers"]
  },
  ...over
})

describe("MemorySuggestionsPanel", () => {
  it("08.4 labels itself non-authoritative", () => {
    render(
      <MemorySuggestionsPanel
        pageId="garden"
        suggestions={[suggestion()]}
        onOpenPage={vi.fn()}
        onPromote={vi.fn()}
      />
    )
    expect(screen.getByTestId("memory-suggestions")).toBeTruthy()
    expect(screen.getByText(/Suggestions · not links/i)).toBeTruthy()
    expect(screen.getByText(/not accepted edges/i)).toBeTruthy()
    // The OTHER endpoint is shown as the related page.
    expect(screen.getByText("Compost")).toBeTruthy()
  })

  it("08.4 promotes to the proposal flow with the related page id", () => {
    const onPromote = vi.fn()
    render(
      <MemorySuggestionsPanel
        pageId="garden"
        suggestions={[suggestion()]}
        onOpenPage={vi.fn()}
        onPromote={onPromote}
      />
    )
    fireEvent.click(screen.getByTestId("memory-suggestion-promote"))
    expect(onPromote).toHaveBeenCalledWith("compost")
  })

  it("stays silent when there is nothing to suggest", () => {
    const { container } = render(
      <MemorySuggestionsPanel
        pageId="garden"
        suggestions={[]}
        onOpenPage={vi.fn()}
        onPromote={vi.fn()}
      />
    )
    expect(container.firstChild).toBeNull()
  })
})
