// @vitest-environment node
import { describe, expect, it } from "vitest"
import {
  agentEditAnnotations,
  agentFollowDiffSelection,
  captureDiffCodeReference,
  resolveAgentFollowPath
} from "./file-diff-context.js"

const patch = [
  "diff --git a/src/config.ts b/src/config.ts",
  "--- a/src/config.ts",
  "+++ b/src/config.ts",
  "@@ -2,3 +2,3 @@",
  " unchanged",
  "-export const mode = 'legacy'",
  "+export const mode = 'modern'",
  " tail",
  "@@ -40,2 +40,3 @@",
  " context",
  "+export const retries = 3",
  "+export const timeout = 2000",
  ""
].join("\n")

describe("file diff context", () => {
  it("resolves a followed source path to the destination of a Git rename", () => {
    const renamePatch = [
      "diff --git a/src/config.ts b/src/settings/config.ts",
      "similarity index 100%",
      "rename from src/config.ts",
      "rename to src/settings/config.ts",
      ""
    ].join("\n")

    expect(resolveAgentFollowPath(renamePatch, "src/config.ts")).toBe(
      "src/settings/config.ts"
    )
  })

  it("focuses the exact changed range described by an agent tool preview", () => {
    expect(
      agentFollowDiffSelection(
        patch,
        "src/config.ts",
        " context\n+export const retries = 3\n+export const timeout = 2000"
      )
    ).toEqual({
      path: "src/config.ts",
      side: "new",
      startLine: 41,
      endLine: 42,
      endSide: "new"
    })
  })

  it("captures selected additions and deletions from a partial patch", () => {
    expect(
      captureDiffCodeReference(patch, {
        path: "src/config.ts",
        side: "new",
        startLine: 41,
        endLine: 42,
        endSide: "new"
      })
    ).toEqual({
      path: "src/config.ts",
      startLine: 41,
      endLine: 42,
      source: "export const retries = 3\nexport const timeout = 2000\n"
    })
    expect(
      captureDiffCodeReference(patch, {
        path: "src/config.ts",
        side: "old",
        startLine: 3,
        endLine: 3,
        endSide: "old"
      })
    ).toEqual({
      path: "src/config.ts",
      startLine: 3,
      endLine: 3,
      source: "export const mode = 'legacy'\n"
    })
  })
})

describe("agentEditAnnotations", () => {
  it("anchors each edit under its changed lines and skips edits without a preview", () => {
    const edits = [
      { id: "t1:0", turnId: "a1", label: "Agent edit · Turn 1", preview: "-export const mode = 'legacy'\n+export const mode = 'modern'" },
      { id: "t3:0", turnId: "a3", label: "Agent edit · Turn 3", preview: "+export const retries = 3" },
      { id: "t4:0", turnId: "a4", label: "Agent edit · Turn 4", preview: null }
    ]
    expect(agentEditAnnotations(patch, "src/config.ts", edits)).toEqual([
      { kind: "agent-edit", id: "agent-edit:t1:0", path: "src/config.ts", side: "new", lineNumber: 3, label: "Agent edit · Turn 1", turnId: "a1" },
      { kind: "agent-edit", id: "agent-edit:t3:0", path: "src/config.ts", side: "new", lineNumber: 41, label: "Agent edit · Turn 3", turnId: "a3" }
    ])
  })
})
