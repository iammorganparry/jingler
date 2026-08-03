import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { MemoryBrowser } from "./memory-browser.js"

afterEach(cleanup)

const ALPHA_RESULT = /Alpha/

describe("MemoryBrowser", () => {
  it("searches and opens accepted pages by stable id", () => {
    const query = vi.fn()
    const open = vi.fn()
    render(<MemoryBrowser query="alpha" results={[{ pageId: "page:alpha", path: "alpha.md", title: "Alpha", revisionId: "revision:alpha", snippet: "Accepted summary" }]} page={null} onQueryChange={query} onOpenPage={open} onBack={() => {}} />)
    fireEvent.change(screen.getByRole("textbox", { name: "Search team memory" }), { target: { value: "beta" } })
    expect(query).toHaveBeenCalledWith("beta")
    fireEvent.click(screen.getByRole("button", { name: ALPHA_RESULT }))
    expect(open).toHaveBeenCalledWith("page:alpha")
  })
})
