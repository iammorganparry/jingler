import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { ArchivedBanner } from "./archived-banner.js"

afterEach(cleanup)

describe("ArchivedBanner", () => {
  it("renders the read-only copy on a neutral BannerShell with no coloured fill", () => {
    render(<ArchivedBanner reason="merged" prNumber={482} base="main" />)
    expect(screen.getByTestId("banner-message").textContent).toBe(
      "Pull request #482 was merged into main. This session is archived and now read-only…"
    )
    expect(screen.getByTestId("banner-shell").className).not.toMatch(/\bbg-/)
  })

  it("says closed on the base for a closed PR", () => {
    render(<ArchivedBanner reason="closed" prNumber={null} base="main" />)
    expect(screen.getByTestId("banner-message").textContent).toContain("Pull request was closed on main.")
  })

  it("keeps Restore and Delete on one line and fires their handlers", () => {
    const onRestore = vi.fn()
    const onDelete = vi.fn()
    render(<ArchivedBanner reason="merged" prNumber={1} onRestore={onRestore} onDelete={onDelete} />)
    expect(screen.getByTestId("banner-actions").className).toContain("whitespace-nowrap")
    fireEvent.click(screen.getByRole("button", { name: "Restore session" }))
    fireEvent.click(screen.getByRole("button", { name: "Delete" }))
    expect(onRestore).toHaveBeenCalledOnce()
    expect(onDelete).toHaveBeenCalledOnce()
  })

  it("omits actions that have no handler", () => {
    render(<ArchivedBanner reason="merged" prNumber={1} onRestore={() => {}} />)
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull()
    render(<ArchivedBanner reason="merged" prNumber={1} />)
    expect(screen.getAllByTestId("banner-actions")).toHaveLength(1)
  })
})
