import { describe, expect, it } from "vitest"
import { isGapMarker, windowRailItems, type RailItem } from "./window-rail-items.js"

const makeItems = (count: number): RailItem[] =>
  Array.from({ length: count }, (_, i) => ({ id: `item-${i}`, label: `Item ${i}` }))

describe("windowRailItems", () => {
  it("returns all items when count <= maxItems", () => {
    const items = makeItems(8)
    const result = windowRailItems(items, undefined, false, 10)
    expect(result).toEqual(items)
  })

  it("returns all items when expanded=true", () => {
    const items = makeItems(40)
    const result = windowRailItems(items, undefined, true, 10)
    expect(result).toEqual(items)
  })

  it("windows 11 items to 5 + gap + 5", () => {
    const items = makeItems(11)
    const result = windowRailItems(items, undefined, false, 10)
    expect(result.length).toBe(11) // 5 + 1 gap + 5
    expect(result[0]!).toEqual(items[0])
    expect(result[4]!).toEqual(items[4])
    expect(isGapMarker(result[5]!)).toBe(true)
    if (isGapMarker(result[5]!)) {
      expect(result[5].hiddenCount).toBe(1)
      expect(result[5].firstHiddenId).toBe("item-5")
    }
    expect(result[6]).toEqual(items[6])
    expect(result[10]).toEqual(items[10])
  })

  it("windows 40 items to 5 + gap + 5", () => {
    const items = makeItems(40)
    const result = windowRailItems(items, undefined, false, 10)
    expect(result.length).toBe(11) // 5 + 1 gap + 5
    expect(result[0]!).toEqual(items[0])
    expect(result[4]!).toEqual(items[4])
    expect(isGapMarker(result[5]!)).toBe(true)
    if (isGapMarker(result[5]!)) {
      expect(result[5].hiddenCount).toBe(30)
    }
    expect(result[6]!).toEqual(items[35])
    expect(result[10]!).toEqual(items[39])
  })

  it("windows 200 items to 5 + gap + 5", () => {
    const items = makeItems(200)
    const result = windowRailItems(items, undefined, false, 10)
    expect(result.length).toBe(11)
    expect(isGapMarker(result[5]!)).toBe(true)
    if (isGapMarker(result[5]!)) {
      expect(result[5].hiddenCount).toBe(190)
    }
  })

  it("keeps active item visible at start", () => {
    const items = makeItems(40)
    const result = windowRailItems(items, "item-2", false, 10)
    expect(result.length).toBe(11)
    expect(result.find(it => !isGapMarker(it) && it.id === "item-2")).toBeDefined()
  })

  it("keeps active item visible at end", () => {
    const items = makeItems(40)
    const result = windowRailItems(items, "item-37", false, 10)
    expect(result.length).toBe(11)
    expect(result.find(it => !isGapMarker(it) && it.id === "item-37")).toBeDefined()
  })

  it("shows active item with ±1 neighbors when in hidden range", () => {
    const items = makeItems(40)
    const result = windowRailItems(items, "item-20", false, 10)
    // Should have: 5 head + gap1 + (item-19, item-20, item-21) + gap2 + 5 tail = 14
    expect(result.length).toBeGreaterThan(11)
    expect(result.find(it => !isGapMarker(it) && it.id === "item-19")).toBeDefined()
    expect(result.find(it => !isGapMarker(it) && it.id === "item-20")).toBeDefined()
    expect(result.find(it => !isGapMarker(it) && it.id === "item-21")).toBeDefined()
    
    const gaps = result.filter(isGapMarker)
    expect(gaps.length).toBe(2)
  })

  it("shows active item with ±1 neighbors when active is near head boundary", () => {
    const items = makeItems(40)
    const result = windowRailItems(items, "item-6", false, 10)
    // item-6 is just past headCount=5, so we show neighbors
    expect(result.find(it => !isGapMarker(it) && it.id === "item-5")).toBeDefined()
    expect(result.find(it => !isGapMarker(it) && it.id === "item-6")).toBeDefined()
    expect(result.find(it => !isGapMarker(it) && it.id === "item-7")).toBeDefined()
  })

  it("shows active item with ±1 neighbors when active is near tail boundary", () => {
    const items = makeItems(40)
    const result = windowRailItems(items, "item-33", false, 10)
    // item-33 is just before tail start (40-5=35), so we show neighbors
    expect(result.find(it => !isGapMarker(it) && it.id === "item-32")).toBeDefined()
    expect(result.find(it => !isGapMarker(it) && it.id === "item-33")).toBeDefined()
    expect(result.find(it => !isGapMarker(it) && it.id === "item-34")).toBeDefined()
  })
})
