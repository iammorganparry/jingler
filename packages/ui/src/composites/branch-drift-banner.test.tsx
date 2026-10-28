import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { BranchDriftBanner } from "./branch-drift-banner.js"

afterEach(cleanup)

describe("BranchDriftBanner", () => {
  it("renders a neutral BannerShell with both recovery actions on one line", () => {
    render(<BranchDriftBanner pinnedBranch="main" liveBranch="fix/other" onFork={() => {}} onAdopt={() => {}} />)
    expect(screen.getByTestId("banner-shell").className).not.toMatch(/\bbg-|border-yellow/)
    expect(screen.getByTestId("banner-message").textContent).toContain("Checkout moved off main")
    expect(screen.getByTestId("banner-actions").className).toContain("whitespace-nowrap")
    expect(screen.getByRole("button", { name: "Adopt fix/other" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Fork new session" })).toBeTruthy()
  })

  it("is fork-only on a detached HEAD", () => {
    render(<BranchDriftBanner pinnedBranch="main" liveBranch={null} onFork={() => {}} />)
    expect(screen.getByTestId("banner-message").textContent).toContain("a detached HEAD")
    expect(screen.queryByRole("button", { name: /Adopt/ })).toBeNull()
  })

  it("disables both actions while one handler is in flight", async () => {
    let resolve!: () => void
    const onFork = vi.fn(() => new Promise<void>((r) => { resolve = r }))
    render(<BranchDriftBanner pinnedBranch="main" liveBranch="x" onFork={onFork} onAdopt={() => {}} />)
    fireEvent.click(screen.getByRole("button", { name: "Fork new session" }))
    expect((await screen.findByRole("button", { name: "Forking…" })).hasAttribute("disabled")).toBe(true)
    expect(screen.getByRole("button", { name: "Adopt x" }).hasAttribute("disabled")).toBe(true)
    resolve()
    expect((await screen.findByRole("button", { name: "Fork new session" })).hasAttribute("disabled")).toBe(false)
  })
})
