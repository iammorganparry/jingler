// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest"
import { buildAnchorFromRange, domRangeFromAnchor } from "./plan-anchor-dom.js"

afterEach(() => {
  document.body.innerHTML = ""
})

describe("plan-anchor-dom", () => {
  it("round-trips a DOM selection to a TextQuote anchor and back", () => {
    const root = document.createElement("div")
    root.innerHTML = "<p>The quick brown fox jumps over the lazy dog.</p>"
    document.body.appendChild(root)
    const text = root.querySelector("p")?.firstChild as Text
    const range = document.createRange()
    range.setStart(text, 4)
    range.setEnd(text, 19)

    const anchor = buildAnchorFromRange(root, range)
    expect(anchor).not.toBeNull()
    expect(anchor?.quote).toBe("quick brown fox")

    const recovered = domRangeFromAnchor(root, anchor!)
    expect(recovered).not.toBeNull()
    expect(recovered?.toString()).toBe("quick brown fox")
  })

  it("returns null for a collapsed selection", () => {
    const root = document.createElement("div")
    root.innerHTML = "<p>hello world</p>"
    document.body.appendChild(root)
    const text = root.querySelector("p")?.firstChild as Text
    const range = document.createRange()
    range.setStart(text, 3)
    range.setEnd(text, 3)

    expect(buildAnchorFromRange(root, range)).toBeNull()
  })

  it("orphans (returns null) an anchor whose quote no longer exists", () => {
    const root = document.createElement("div")
    root.innerHTML = "<p>totally different content now.</p>"
    document.body.appendChild(root)

    expect(
      domRangeFromAnchor(root, { quote: "quick brown fox", prefix: "The ", suffix: " jumps" })
    ).toBeNull()
  })
})
