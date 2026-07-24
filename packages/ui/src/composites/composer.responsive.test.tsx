import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { WidthTierValue } from "../hooks/width-tier.js"
import { Composer } from "./composer.js"

afterEach(cleanup)

const MCP_ITEM = /MCP connectors/

const renderAt = (width: number, props: Partial<React.ComponentProps<typeof Composer>> = {}) =>
  render(
    <WidthTierValue width={width}>
      <Composer {...props} />
    </WidthTierValue>
  )

const openMenu = () =>
  fireEvent.pointerDown(screen.getByRole("button", { name: "Composer menu" }), {
    button: 0,
    ctrlKey: false
  })

describe("Composer at width", () => {
  it("keeps decorative keyboard hints out even when there is room", () => {
    renderAt(1000)
    expect(screen.queryByText("/ · @ · paste image")).toBeNull()
  })

  it("keeps Send and thinking visible at every width", () => {
    // The primary action is `flex-none` and last in DOM order precisely so a
    // squeeze wraps the chips above it rather than pushing it past the border.
    for (const width of [1200, 700, 450, 320]) {
      cleanup()
      renderAt(width)
      expect(screen.getByRole("button", { name: /Send/ })).toBeTruthy()
      expect(screen.getByRole("button", { name: "Thinking strength" })).toBeTruthy()
    }
  })

  it("keeps MCP status in the menu without losing the failure count", () => {
    renderAt(450, {
      mcp: { total: 3, failed: 1, probed: true },
      onOpenMcp: () => {}
    })
    openMenu()
    expect(screen.getByRole("menuitem", { name: MCP_ITEM }).textContent).toContain("1/3 down")
  })

  it("keeps the composer menu findable by the same name at any width", () => {
    for (const width of [1200, 450, 320]) {
      cleanup()
      renderAt(width)
      expect(screen.getByRole("button", { name: "Composer menu" })).toBeTruthy()
    }
  })
})
