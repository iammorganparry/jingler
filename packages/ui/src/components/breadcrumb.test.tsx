import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { AgentEditsMarker, Breadcrumb } from "./breadcrumb.js"

afterEach(cleanup)

describe("Breadcrumb", () => {
  it("renders the trail and the right-aligned marker", () => {
    render(
      <Breadcrumb crumbs={["packages", "ui", "a.ts"]}>
        <AgentEditsMarker count={2} />
      </Breadcrumb>
    )
    const nav = screen.getByRole("navigation", { name: "Breadcrumb" })
    expect(nav.textContent).toContain("a.ts")
    expect(nav.textContent).toContain("2 agent edits")
  })

  it("pluralises and hides at zero", () => {
    const { container, rerender } = render(<AgentEditsMarker count={1} />)
    expect(container.textContent).toContain("1 agent edit")
    expect(container.textContent).not.toContain("edits")
    rerender(<AgentEditsMarker count={0} />)
    expect(container.textContent).toBe("")
  })
})
