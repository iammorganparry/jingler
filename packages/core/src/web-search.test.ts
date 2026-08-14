import { Either, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { WebSearchConfig } from "./web-search.js"

const decode = Schema.decodeUnknownEither(WebSearchConfig)

describe("WebSearch config", () => {
  it.each([
    { setup: "pending", provider: null },
    { setup: "pending", provider: "exa" },
    { setup: "skipped", provider: null },
    { setup: "configured", provider: "exa" },
    { setup: "configured", provider: "firecrawl" }
  ])("accepts supported state $setup/$provider", (value) => {
    expect(Either.isRight(decode(value))).toBe(true)
  })

  it.each([
    { setup: "configured", provider: null },
    { setup: "skipped", provider: "exa" },
    { setup: "skipped", provider: "firecrawl" }
  ])("rejects contradictory state $setup/$provider", (value) => {
    expect(Either.isLeft(decode(value))).toBe(true)
  })
})
