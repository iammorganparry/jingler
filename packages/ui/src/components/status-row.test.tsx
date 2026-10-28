import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { StatusRow, Stepper } from "./status-row.js"

afterEach(cleanup)

describe("StatusRow", () => {
  it("is neutral unless failed", () => {
    const { container, rerender } = render(<StatusRow>Indexing</StatusRow>)
    expect((container.firstChild as HTMLElement).className).toContain("text-muted-foreground")
    expect((container.firstChild as HTMLElement).className).not.toContain("state-failed")
    rerender(<StatusRow failed>Index failed</StatusRow>)
    expect((container.firstChild as HTMLElement).className).toContain("text-state-failed")
  })
})

describe("Stepper", () => {
  it("marks done, current and upcoming steps and announces the current one", () => {
    render(<Stepper steps={["Folder", "GitHub", "Agent"]} current={1} />)
    const items = screen.getAllByRole("listitem")
    expect(items.map((item) => item.dataset.state)).toEqual(["done", "current", "upcoming"])
    expect(items[1]?.getAttribute("aria-current")).toBe("step")
    expect(items[0]?.textContent).toContain("(done)")
  })
})
