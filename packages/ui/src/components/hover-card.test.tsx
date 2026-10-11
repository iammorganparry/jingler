import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { HoverCard } from "./hover-card.js"
import { formatShortcut, KbdChip } from "./kbd.js"

afterEach(cleanup)

describe("formatShortcut", () => {
  it("uses ⌘ glyphs on macOS and Ctrl words elsewhere", () => {
    expect(formatShortcut("mod+shift+k", true)).toBe("⌘⇧K")
    expect(formatShortcut("mod+shift+k", false)).toBe("Ctrl+Shift+K")
  })
})

describe("KbdChip", () => {
  it("renders the shortcut as one nowrap unit", () => {
    render(<KbdChip shortcut="mod+k" mac />)
    const chip = screen.getByText("⌘K")
    expect(chip.className).toContain("whitespace-nowrap")
  })
})

describe("HoverCard", () => {
  it("opens on keyboard focus on the elevated surface", async () => {
    render(<HoverCard content="Session detail"><button type="button">Row</button></HoverCard>)
    screen.getByRole("button", { name: "Row" }).focus()
    const card = await screen.findByTestId("hover-card")
    expect(card.className).toContain("bg-surface")
    expect(card.className).toContain("rounded-lg")
  })
})
