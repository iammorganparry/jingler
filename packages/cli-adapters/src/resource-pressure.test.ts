import { describe, expect, it } from "vitest"
import { isResourcePressure } from "./resource-pressure.js"

describe("resource pressure policy", () => {
  it("keeps work local with CPU and memory headroom", () => {
    expect(isResourcePressure(Array(10).fill(0.79), 21, 100)).toBe(false)
  })

  it("offloads below twenty percent available memory", () => {
    expect(isResourcePressure([], 19, 100)).toBe(true)
  })

  it("offloads at eighty percent CPU sustained across ten samples", () => {
    expect(isResourcePressure(Array(10).fill(0.8), 80, 100)).toBe(true)
  })

  it("does not classify an incomplete CPU window as squeezed", () => {
    expect(isResourcePressure(Array(9).fill(1), 80, 100)).toBe(false)
  })
})
