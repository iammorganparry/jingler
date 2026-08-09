import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ChipMenu } from "./chip-menu.js"

/**
 * The model list grows with every harness and every model a provider ships, so
 * the model chip filters. These cover what the operator does: type part of a
 * model, or type a harness when they just want "whatever Codex has".
 */

afterEach(cleanup)

const groups = [
  {
    label: "Claude Code",
    options: [
      { value: "claude:opus", label: "opus" },
      { value: "claude:sonnet", label: "sonnet" },
      { value: "claude:haiku", label: "haiku" }
    ]
  },
  {
    label: "Codex CLI",
    options: [
      { value: "codex:gpt-5.6-sol", label: "GPT-5.6-Sol" },
      { value: "codex:gpt-5.6-terra", label: "GPT-5.6-Terra" }
    ]
  }
]

const open = () => fireEvent.click(screen.getByRole("button"))
const box = () => screen.getByRole("combobox")
const items = () => screen.queryAllByRole("option").map((n) => n.textContent)

describe("ChipMenu search", () => {
  it("has no filter box unless asked for (the mode chip stays plain)", () => {
    render(<ChipMenu value="claude:opus" groups={groups} />)
    open()
    expect(screen.queryByRole("combobox")).toBeNull()
  })

  it("filters to a model by name", () => {
    render(<ChipMenu value="claude:opus" groups={groups} searchable />)
    open()
    fireEvent.change(box(), { target: { value: "haiku" } })
    expect(items()).toEqual(["haiku"])
  })

  it("filters by harness name, so you can ask for a provider not a model", () => {
    render(<ChipMenu value="claude:opus" groups={groups} searchable />)
    open()
    fireEvent.change(box(), { target: { value: "codex" } })
    // Every Codex model, and nothing from Claude.
    expect(items()).toEqual(["GPT-5.6-Sol", "GPT-5.6-Terra"])
  })

  it("is case-insensitive and matches partial text", () => {
    render(<ChipMenu value="claude:opus" groups={groups} searchable />)
    open()
    fireEvent.change(box(), { target: { value: "TERRA" } })
    expect(items()).toEqual(["GPT-5.6-Terra"])
  })

  it("says so when nothing matches, rather than showing an empty menu", () => {
    render(<ChipMenu value="claude:opus" groups={groups} searchable emptyLabel="No models match" />)
    open()
    fireEvent.change(box(), { target: { value: "zzzz" } })
    expect(items()).toEqual([])
    expect(screen.getByText("No models match")).toBeDefined()
  })

  it("selects the top match on Enter, emitting the full value", () => {
    const onSelect = vi.fn()
    render(<ChipMenu value="claude:opus" groups={groups} searchable onSelect={onSelect} />)
    open()
    fireEvent.change(box(), { target: { value: "sol" } })
    fireEvent.keyDown(box(), { key: "Enter" })
    expect(onSelect).toHaveBeenCalledWith("codex:gpt-5.6-sol")
  })

  it("keeps section headings while filtered, so a model still names its harness", () => {
    render(<ChipMenu value="claude:opus" groups={groups} searchable />)
    open()
    fireEvent.change(box(), { target: { value: "terra" } })
    // Filtering to one group must not drop the heading — you'd lose which
    // harness you're about to switch to.
    expect(screen.getByRole("group", { name: "Codex CLI" })).toBeDefined()
    expect(screen.queryByRole("group", { name: "Claude Code" })).toBeNull()
  })

  it("forgets the filter once closed, so reopening shows the whole list", () => {
    render(<ChipMenu value="claude:opus" groups={groups} searchable />)
    open()
    fireEvent.change(box(), { target: { value: "haiku" } })
    expect(items()).toEqual(["haiku"])
    fireEvent.keyDown(box(), { key: "Escape" })
    open()
    expect(items()).toHaveLength(5)
  })

  it("still shows the selected label on the chip", () => {
    render(<ChipMenu value="codex:gpt-5.6-sol" groups={groups} searchable />)
    expect(screen.getByRole("button").textContent).toContain("GPT-5.6-Sol")
  })
})

describe("ChipMenu search — shadcn/cmdk keyboard behavior", () => {
  it("takes focus on open, so you can just start typing", async () => {
    render(<ChipMenu value="claude:opus" groups={groups} searchable />)
    open()
    // Popover opens first; the shared picker claims the search field next frame.
    await new Promise((r) => requestAnimationFrame(() => r(null)))
    expect(document.activeElement).toBe(box())
  })

  it("uses cmdk arrow navigation without moving focus out of the search field", () => {
    render(<ChipMenu value="claude:opus" groups={groups} searchable />)
    open()
    const selectedBefore = document.querySelector('[cmdk-item][data-selected="true"]')
    fireEvent.keyDown(box(), { key: "ArrowDown" })
    const selectedAfter = document.querySelector('[cmdk-item][data-selected="true"]')
    expect(selectedAfter).not.toBe(selectedBefore)
    expect(document.activeElement).toBe(box())
  })

  it("lets Escape close the popover from the filter", async () => {
    render(<ChipMenu value="claude:opus" groups={groups} searchable />)
    open()
    await new Promise((r) => requestAnimationFrame(() => r(null)))
    fireEvent.keyDown(box(), { key: "Escape" })
    expect(screen.queryByRole("combobox")).toBeNull()
  })
})
