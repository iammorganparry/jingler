// @vitest-environment node
import { describe, expect, it } from "vitest"
import { compareVersions, notesBetween, parseChangelog } from "./release-notes.js"

const CHANGELOG = [
  "# @jingler/desktop",
  "",
  "## 0.3.0",
  "",
  "### Minor Changes",
  "",
  "- a1b2c3d: Review changes in the Explorer.",
  "",
  "### Patch Changes",
  "",
  "- d4e5f60: Send review comments with their code.",
  "",
  "## 0.2.1",
  "",
  "### Patch Changes",
  "",
  "- c2a2490: Make Cloud sessions selectable.",
  "",
  "## 0.2.0",
  "",
  "- b25b115: Add the Linear plugin.",
  ""
].join("\n")

describe("release notes", () => {
  it("parses each version's changes, newest first, without commit prefixes", () => {
    expect(parseChangelog(CHANGELOG)).toEqual([
      {
        version: "0.3.0",
        notes: ["Review changes in the Explorer.", "Send review comments with their code."]
      },
      { version: "0.2.1", notes: ["Make Cloud sessions selectable."] },
      { version: "0.2.0", notes: ["Add the Linear plugin."] }
    ])
  })

  it("collects every version an update skipped over", () => {
    expect(notesBetween(parseChangelog(CHANGELOG), "0.2.0", "0.3.0")).toEqual([
      "Review changes in the Explorer.",
      "Send review comments with their code.",
      "Make Cloud sessions selectable."
    ])
  })

  it("has nothing to say for the same or an older version", () => {
    const entries = parseChangelog(CHANGELOG)
    expect(notesBetween(entries, "0.3.0", "0.3.0")).toEqual([])
    expect(notesBetween(entries, "0.3.0", "0.2.1")).toEqual([])
  })

  it("compares versions numerically, not as text", () => {
    expect(compareVersions("0.10.0", "0.9.9")).toBeGreaterThan(0)
    expect(compareVersions("0.2.1", "0.2.1")).toBe(0)
    expect(compareVersions("0.2.0", "0.2.1")).toBeLessThan(0)
  })
})
