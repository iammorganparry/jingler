import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { FileChange, FileChangeSet, fileChangeTotals } from "./file-change.js"

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
