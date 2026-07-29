import { describe, expect, it } from "vitest"
import { buildPlanAnchor, isOrphanedAnchor, resolvePlanAnchor } from "./plan-anchor.js"

const text = "Audit the session middleware, then rebuild the session store cleanly."

describe("plan anchors", () => {
  it("builds an anchor with surrounding context from a selection", () => {
    const start = text.indexOf("middleware")
    const anchor = buildPlanAnchor(text, start, start + "middleware".length)
    expect(anchor.quote).toBe("middleware")
    expect(anchor.prefix.endsWith("session ")).toBe(true)
    expect(resolvePlanAnchor(text, anchor)).toEqual({
      start,
      end: start + "middleware".length
    })
  })

  it("disambiguates a repeated quote using recorded context", () => {
    // "session" occurs twice; anchor the SECOND (before " store").
    const second = text.indexOf("session store")
    const anchor = buildPlanAnchor(text, second, second + "session".length)
    const resolved = resolvePlanAnchor(text, anchor)
    expect(resolved?.start).toBe(second)
    // Not the first occurrence.
    expect(resolved?.start).not.toBe(text.indexOf("session"))
  })

  it("falls back to the bare quote when context has shifted", () => {
    const anchor = { quote: "rebuild", prefix: "WRONG CONTEXT ", suffix: " NOPE" }
    expect(resolvePlanAnchor(text, anchor)?.start).toBe(text.indexOf("rebuild"))
  })

  it("returns null / reports orphan when the quote is gone", () => {
    const anchor = buildPlanAnchor(text, 0, 5)
    const edited = "Completely different prose with no overlap."
    expect(resolvePlanAnchor(edited, anchor)).toBeNull()
    expect(isOrphanedAnchor(edited, anchor)).toBe(true)
  })

  it("treats an empty quote as unresolvable", () => {
    expect(resolvePlanAnchor(text, { quote: "", prefix: "", suffix: "" })).toBeNull()
  })
})
