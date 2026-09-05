import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { FileChange, FileChangeSet, boundFileChangePreviews, fileChangeTotals } from "./file-change.js"

const change = (status: "A" | "M" | "D" | "R", path: string) => ({
  status,
  path,
  oldPath: status === "R" ? "old.ts" : null,
  added: 2,
  removed: 1,
  binary: false,
  noNewlineAtEnd: false,
  beforeBytes: status === "A" ? null : 10,
  afterBytes: status === "D" ? null : 20,
  preview: "+line",
  patchArtifactId: "patch-1"
})

describe("canonical file changes", () => {
  it("decodes create modify delete and rename records", () => {
    const changes = [change("A", "new.ts"), change("M", "edit.ts"), change("D", "old.ts"), change("R", "renamed.ts")]
    expect(changes.map((item) => Schema.decodeUnknownSync(FileChange)(item).status)).toEqual(["A", "M", "D", "R"])
  })

  it("aggregates normalized line statistics", () => {
    expect(fileChangeTotals([change("A", "a"), change("D", "b")])).toEqual({ added: 4, removed: 2 })
  })

  it("keeps artifact metadata separate from patch source", () => {
    const set = Schema.decodeUnknownSync(FileChangeSet)({
      id: "set-1",
      callId: null,
      changes: [change("M", "a.ts")],
      totals: { added: 2, removed: 1 },
      authoritative: true,
      reconciledAt: "2026-08-10T00:00:00.000Z"
    })
    expect(JSON.stringify(set)).not.toContain("diff --git")
  })
})

describe("boundFileChangePreviews", () => {
  const withPreview = (path: string, preview: string | null) => ({ ...change("M", path), preview })

  it("returns the same array when every preview fits the budget", () => {
    const changes = [withPreview("a.ts", "+a"), withPreview("b.ts", "+bb")]
    expect(boundFileChangePreviews(changes, 5)).toBe(changes)
  })

  it("keeps the first previews that fit and nulls the rest without reordering", () => {
    const changes = [
      withPreview("a.ts", "+aaaa"),
      withPreview("b.ts", null),
      withPreview("c.ts", "+ccc"),
      withPreview("d.ts", "+dd")
    ]
    const bounded = boundFileChangePreviews(changes, 6)
    expect(bounded.map((item) => item.path)).toEqual(["a.ts", "b.ts", "c.ts", "d.ts"])
    expect(bounded.map((item) => item.preview)).toEqual(["+aaaa", null, null, null])
    // Untouched entries are the same objects; only the trimmed ones are copies.
    expect(bounded[0]).toBe(changes[0])
    expect(bounded[3]).not.toBe(changes[3])
    expect(bounded[3]!.patchArtifactId).toBe("patch-1")
  })

  it("does not let a later small preview squeeze past a large one that overflowed", () => {
    const bounded = boundFileChangePreviews([withPreview("big.ts", "x".repeat(10)), withPreview("small.ts", "+s")], 5)
    // The big one overflows and is dropped; the small one still fits.
    expect(bounded.map((item) => item.preview)).toEqual([null, "+s"])
  })
})
