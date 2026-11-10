import { describe, expect, it } from "vitest"
import { positionPopover } from "./popover-layout.js"

const layout = {
  trigger: { left: 400, top: 400, width: 100, height: 32 },
  content: { width: 280, height: 180 },
  viewport: { width: 1000, height: 600 }
}

describe("popover viewport bounds", () => {
  it("preserves the requested anchor and gap when the panel fits", () => {
    expect(positionPopover(layout, "top", "start", 8)).toMatchObject({
      side: "top", left: 400, top: 212
    })
  })

  it("opens below a trigger near the top edge", () => {
    expect(positionPopover({ ...layout, trigger: { ...layout.trigger, top: 20 } }, "top", "start", 8))
      .toMatchObject({ side: "bottom", top: 60 })
  })

  it("keeps a tall panel above its trigger with room to scroll", () => {
    expect(positionPopover({ ...layout, content: { width: 280, height: 900 } }, "top", "start", 8))
      .toMatchObject({ side: "top", top: 8, maxHeight: 384 })
  })

  it("keeps a right-aligned trigger's menu inside the right edge", () => {
    expect(positionPopover({ ...layout, trigger: { ...layout.trigger, left: 940 } }, "top", "start", 8))
      .toMatchObject({ left: 712 })
  })

  it("flips horizontal panels away from the right edge", () => {
    expect(positionPopover({ ...layout, trigger: { ...layout.trigger, left: 880 } }, "right", "end", 8))
      .toMatchObject({ side: "left", left: 592, top: 252 })
  })

  it("caps a matched trigger width to the viewport", () => {
    expect(positionPopover({ ...layout, trigger: { ...layout.trigger, width: 1200 } }, "top", "start", 8, true))
      .toMatchObject({ left: 8, width: 984, maxWidth: 984 })
  })

  it("keeps all edges reachable for oversized content and corner anchors", () => {
    for (const side of ["top", "bottom", "left", "right"] as const) {
      for (const align of ["start", "end"] as const) {
        for (const left of [0, 450, 900]) {
          for (const top of [0, 280, 568]) {
            const content = { width: 1400, height: 1200 }
            const position = positionPopover({ ...layout, trigger: { ...layout.trigger, left, top }, content }, side, align, 8)
            expect(position.left).toBeGreaterThanOrEqual(8)
            expect(position.top).toBeGreaterThanOrEqual(8)
            expect(position.left + Math.min(content.width, position.maxWidth)).toBeLessThanOrEqual(992)
            expect(position.top + Math.min(content.height, position.maxHeight)).toBeLessThanOrEqual(592)
          }
        }
      }
    }
  })
})
