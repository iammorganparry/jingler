import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { SessionHeaderIdentity } from "./session-header-identity.js"

afterEach(cleanup)

describe("SessionHeaderIdentity", () => {
  it("renders title, branch and link chips", () => {
    render(<SessionHeaderIdentity title="Fix inbox" branch="morgan/fix" chips={[{ id: "pr", label: "PR #482", title: "Open", onOpen: vi.fn() }]} />)
    expect(screen.getByText("Fix inbox")).toBeTruthy()
    expect(screen.getByTestId("header-branch").textContent).toBe("morgan/fix")
    expect(screen.getByTestId("header-link-pr").textContent).toBe("PR #482")
  })
  it("hides missing chips", () => {
    render(<SessionHeaderIdentity title="T" chips={[]} />)
    expect(screen.queryByTestId("header-branch")).toBeNull()
    expect(screen.queryByTestId("header-link-pr")).toBeNull()
  })
})
