import { useState } from "react"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { FilterChips } from "./filter-chips.js"
import { SearchField } from "./search-input.js"

afterEach(cleanup)

function Field({ initial = "", count }: { initial?: string; count?: string }) {
  const [value, setValue] = useState(initial)
  return <SearchField value={value} onChange={setValue} placeholder="Search skills" kbd={<kbd>⌘F</kbd>} count={count} />
}

describe("SearchField", () => {
  it("shows the kbd hint while empty and the clear button once there is text", () => {
    render(<Field />)
    expect(screen.queryByLabelText("Clear")).toBeNull()
    expect(screen.getByText("⌘F")).toBeDefined()
    fireEvent.change(screen.getByLabelText("Search skills"), { target: { value: "lint" } })
    expect(screen.getByLabelText("Clear")).toBeDefined()
    expect(screen.queryByText("⌘F")).toBeNull()
  })

  it("clears on the clear button and on Escape", () => {
    render(<Field initial="lint" />)
    fireEvent.click(screen.getByLabelText("Clear"))
    expect((screen.getByLabelText("Search skills") as HTMLInputElement).value).toBe("")
    fireEvent.change(screen.getByLabelText("Search skills"), { target: { value: "x" } })
    fireEvent.keyDown(screen.getByLabelText("Search skills"), { key: "Escape" })
    expect((screen.getByLabelText("Search skills") as HTMLInputElement).value).toBe("")
  })

  it("shows the count only while there is a query", () => {
    render(<Field initial="lint" count="12 results" />)
    expect(screen.getByText("12 results")).toBeDefined()
  })
})

const OPTIONS = [
  { value: "all", label: "All", count: 214 },
  { value: "agents", label: "Agents", count: 38 },
  { value: "skills", label: "Skills", count: 176 }
] as const

function Chips({ onChange }: { onChange?: (v: string) => void }) {
  const [value, setValue] = useState<"all" | "agents" | "skills">("all")
  return (
    <FilterChips
      ariaLabel="Kind"
      options={OPTIONS}
      value={value}
      onChange={(v) => {
        setValue(v)
        onChange?.(v)
      }}
    />
  )
}

describe("FilterChips", () => {
  it("renders labels with counts and marks the selected chip", () => {
    render(<Chips />)
    expect(screen.getByRole("radiogroup", { name: "Kind" })).toBeDefined()
    expect(screen.getByRole("radio", { name: "All 214" }).getAttribute("aria-checked")).toBe("true")
    expect(screen.getByRole("radio", { name: "Agents 38" }).getAttribute("aria-checked")).toBe("false")
  })

  it("selects on click", () => {
    render(<Chips />)
    fireEvent.click(screen.getByRole("radio", { name: "Skills 176" }))
    expect(screen.getByRole("radio", { name: "Skills 176" }).getAttribute("aria-checked")).toBe("true")
  })

  it("moves with ←/→ (wrapping), selects with Enter, and keeps one tab stop", () => {
    render(<Chips />)
    fireEvent.keyDown(screen.getByRole("radio", { name: "All 214" }), { key: "ArrowLeft" })
    expect(screen.getByRole("radio", { name: "Skills 176" }).getAttribute("aria-checked")).toBe("true")
    fireEvent.keyDown(screen.getByRole("radio", { name: "Skills 176" }), { key: "ArrowRight" })
    expect(screen.getByRole("radio", { name: "All 214" }).getAttribute("aria-checked")).toBe("true")
    fireEvent.keyDown(screen.getByRole("radio", { name: "Agents 38" }), { key: "Enter" })
    expect(screen.getByRole("radio", { name: "Agents 38" }).getAttribute("aria-checked")).toBe("true")
    expect(screen.getAllByRole("radio").filter((r) => r.tabIndex === 0)).toHaveLength(1)
  })

  it("never wraps a chip", () => {
    render(<Chips />)
    for (const chip of screen.getAllByRole("radio")) {
      expect(chip.className).toContain("whitespace-nowrap")
      expect(chip.className).toContain("shrink-0")
    }
  })
})
