import { describe, expect, it } from "vitest"
import { planDocViewportFractions } from "./plan-doc-editor.js"

describe("planDocViewportFractions", () => {
  it("positions the viewport top against the whole document", () => {
    expect(
      planDocViewportFractions({
        scrollTop: 250,
        clientHeight: 500,
        scrollHeight: 1_000
      })
    ).toEqual({ start: 0.25, size: 0.5 })
  })
})
