import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { AssetHover, isLanguageHoverPath } from "./index.js"

describe("isLanguageHoverPath", () => {
  it("accepts supported extensions case-insensitively and rejects lookalikes", () => {
    expect(isLanguageHoverPath("src/Foo.TS")).toBe(true)
    expect(isLanguageHoverPath("src/Foo.mts")).toBe(true)
    expect(isLanguageHoverPath("src/Foo.JAVA")).toBe(true)
    expect(isLanguageHoverPath("src/Foo.mtsx")).toBe(false)
    expect(isLanguageHoverPath("src/Foo.ctsx")).toBe(false)
  })

  it("represents operational failures separately from no hover", () => {
    expect(Schema.decodeUnknownSync(AssetHover)({ unavailable: "JDT.LS could not start" }))
      .toEqual({ unavailable: "JDT.LS could not start" })
  })
})
