import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { PrEventActionsContext, PrEventCard } from "./pr-event-card.js"

afterEach(cleanup)

describe("PrEventCard", () => {
  it("shows the stacked opened card", () => {
    render(<PrEventCard event={{ _tag: "PrEvent", kind: "opened", number: 482, stackedOn: 481 }} />)
    expect(screen.getByTestId("banner-message").textContent).toBe("Opened #482 · stacked on #481")
  })
  it("merged card archives, or keeps open to hide its actions", () => {
    const archiveWorkspace = vi.fn()
    render(
      <PrEventActionsContext.Provider value={{ archiveWorkspace }}>
        <PrEventCard event={{ _tag: "PrEvent", kind: "merged", number: 482 }} />
      </PrEventActionsContext.Provider>
    )
    expect(screen.getByTestId("banner-message").textContent).toBe("PR #482 merged")
    fireEvent.click(screen.getByRole("button", { name: "Archive workspace" }))
    expect(archiveWorkspace).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole("button", { name: "Keep open" }))
    expect(screen.queryByRole("button", { name: "Archive workspace" })).toBeNull()
  })
})
