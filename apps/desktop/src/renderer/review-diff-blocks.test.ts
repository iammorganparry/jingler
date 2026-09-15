import { describe, expect, it } from "vitest"
import { diffBlocks, diffForPath } from "./review-diff-blocks.js"

const block = (path: string, body: string, from = path) =>
  `diff --git a/${from} b/${path}\n--- a/${from}\n+++ b/${path}\n@@ -1 +1 @@\n${body}\n`

const patch =
  block("src/a.ts", "+a") +
  block("src/a.tsx", "+ax") +
  block("lib/src/a.ts", "+nested") +
  block("docs/new.md", "+moved", "docs/old.md")

describe("review diff blocks", () => {
  it("splits a multi-file patch into one block per diff --git header, in order", () => {
    const blocks = diffBlocks(patch)
    expect(blocks).toHaveLength(4)
    expect(blocks.every((entry) => entry.startsWith("diff --git "))).toBe(true)
    expect(blocks.join("")).toBe(patch)
    expect(diffBlocks("")).toEqual([])
  })

  it("matches a file by the header's destination path, never by a prefix or suffix", () => {
    const blocks = diffBlocks(patch)
    expect(diffForPath(blocks, "src/a.ts")).toContain("+a\n")
    expect(diffForPath(blocks, "src/a.ts")).not.toContain("+ax")
    expect(diffForPath(blocks, "src/a.tsx")).toContain("+ax")
    expect(diffForPath(blocks, "lib/src/a.ts")).toContain("+nested")
    expect(diffForPath(blocks, "a.ts")).toBe("")
    expect(diffForPath(blocks, null)).toBe("")
  })

  it("resolves a rename by its new path", () => {
    expect(diffForPath(diffBlocks(patch), "docs/new.md")).toContain("+moved")
    expect(diffForPath(diffBlocks(patch), "docs/old.md")).toBe("")
  })

  it("falls back to the +++ line when the header is quoted", () => {
    const quoted = `diff --git "a/sp ace.ts" "b/sp ace.ts"\n--- "a/sp ace.ts"\n+++ b/sp ace.ts\n@@ -1 +1 @@\n+quoted\n`
    expect(diffForPath(diffBlocks(quoted), "sp ace.ts")).toContain("+quoted")
  })
})
