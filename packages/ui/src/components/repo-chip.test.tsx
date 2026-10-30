import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { RepoChip } from "./repo-chip.js"

afterEach(cleanup)

describe("RepoChip", () => {
  it("shows the short repo name, PR number, checks glyph and diff", () => {
    render(<RepoChip repo="acme/api" prNumber={482} pr={{ state: "open", checks: "fail" }} added={42} removed={7} />)
    const chip = screen.getByTestId("repo-chip-api")
    expect(chip.textContent).toContain("api #482")
    expect(chip.textContent).toContain("+42")
    expect(chip.textContent).toContain("−7")
    expect(chip.title).toBe("acme/api")
  })

  it("shows only the repo and diff without a PR", () => {
    render(<RepoChip repo="api" added={9} />)
    const chip = screen.getByTestId("repo-chip-api")
    expect(chip.textContent).toBe("api+9")
  })

  it("marks a missing folder and hides PR and diff", () => {
    render(<RepoChip repo="billing" prNumber={3} added={5} missing />)
    const chip = screen.getByTestId("repo-chip-billing")
    expect(chip.dataset.missing).toBe("true")
    expect(chip.textContent).toBe("billing")
    expect(chip.title).toBe("billing: folder not found")
  })
})
