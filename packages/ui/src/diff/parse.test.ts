import { describe, expect, it } from "vitest"
import {
  normalizeDiffPreviewPatch,
  normalizePatchHunkCounts,
  parsePierreFileDiffs,
  parseUnifiedDiffForPath
} from "./parse.js"

const patch = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 1111111..2222222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1 +1 @@",
  "-export const value = 1",
  "+export const value = 2",
  "diff --git a/src/b.ts b/src/b.ts",
  "index 3333333..4444444 100644",
  "--- a/src/b.ts",
  "+++ b/src/b.ts",
  "@@ -1 +1 @@",
  "-export const other = 1",
  "+export const other = 2"
].join("\n")

describe("parseUnifiedDiffForPath", () => {
  it("keeps only the requested file's header and diff rows", () => {
    const rows = parseUnifiedDiffForPath(patch, "./src/a.ts")

    expect(rows[0]).toMatchObject({ kind: "file", path: "src/a.ts" })
    expect(rows.some((row) => row.kind === "line" && row.content.includes("value = 2"))).toBe(true)
    expect(rows.some((row) => row.kind === "line" && row.content.includes("other"))).toBe(false)
  })

  it("returns no rows when the file is unchanged", () => {
    expect(parseUnifiedDiffForPath(patch, "src/missing.ts")).toEqual([])
  })
})

describe("Pierre patch normalization", () => {
  it("keeps truncation notices as hunk context rather than source lines", () => {
    const [file] = parsePierreFileDiffs(
      normalizeDiffPreviewPatch("-before\n+after\n…12 more diff line(s)")
    )

    expect(file?.hunks).toHaveLength(2)
    expect(file?.hunks[1]).toMatchObject({
      hunkContent: [],
      hunkContext: "…12 more diff line(s)"
    })
    expect(file?.additionLines).not.toContain("…12 more diff line(s)\n")
  })

  it("does not count a blank separator before the next file as context", () => {
    const normalized = normalizePatchHunkCounts(`${patch}\n\n${patch}`)
    expect(normalized.match(/@@ -1,1 \+1,1 @@/g)).toHaveLength(4)
  })
})
