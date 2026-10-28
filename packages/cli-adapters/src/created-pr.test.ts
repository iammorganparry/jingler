import { describe, expect, it } from "vitest"
import { createdPrFromToolOutput } from "./created-pr.js"

const slugs = new Set(["acme/widget"])
const url = "https://github.com/Acme/Widget/pull/7\n"

describe("createdPrFromToolOutput", () => {
  it("links the URL gh pr create printed", () => {
    expect(createdPrFromToolOutput("cd ../x && gh pr create --fill", url, slugs)).toBe(7)
  })
  it("ignores gh pr list output", () => {
    expect(createdPrFromToolOutput("gh pr list", url, slugs)).toBeNull()
  })
  it("ignores another repo", () => {
    expect(createdPrFromToolOutput("gh pr create", "https://github.com/other/repo/pull/7", slugs)).toBeNull()
  })
  it("ignores output without a URL", () => {
    expect(createdPrFromToolOutput("gh pr create", "failed", slugs)).toBeNull()
  })
})
