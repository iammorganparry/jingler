import type { PrFileChange, PrReviewThread } from "@jingler/core"
import { describe, expect, it } from "vitest"
import { pierreActiveCodeItemPath } from "../diff/pierre-provider.js"
import type { JinglerLineSelection } from "../diff/pierre-selection.js"
import {
  createReviewCodeFiles,
  createReviewCodeItems,
  newSideRangeForReviewSelection
} from "./review-code-view.js"

const modifiedPatch = [
  "diff --git a/src/auth/session.ts b/src/auth/session.ts",
  "--- a/src/auth/session.ts",
  "+++ b/src/auth/session.ts",
  "@@ -1,2 +1,2 @@",
  "-const token = oldToken",
  "+const token = nextToken",
  " export { token }"
].join("\n")

const addedPatch = [
  "diff --git a/src/auth/store.ts b/src/auth/store.ts",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/src/auth/store.ts",
  "@@ -0,0 +1,1 @@",
  "+export const store = new Map()"
].join("\n")

const files: readonly PrFileChange[] = [
  {
    path: "src/auth/session.ts",
    additions: 1,
    deletions: 1,
    commentCount: 0,
    viewed: true
  },
  {
    path: "src/auth/store.ts",
    additions: 1,
    deletions: 0,
    commentCount: 0,
    viewed: false
  }
]

const thread: PrReviewThread = {
  id: "thread-1",
  reviewId: null,
  path: "src/auth/session.ts",
  line: 2,
  startLine: null,
  originalLine: null,
  originalStartLine: null,
  diffHunk: "",
  isResolved: false,
  isOutdated: false,
  resolvedBy: null,
  comments: []
}

describe("review CodeView model", () => {
  it("does not relabel an unrelated file from a multi-file patch", () => {
    const [entry] = createReviewCodeFiles(files.slice(0, 1), [
      { path: files[0]!.path, diff: `${addedPatch}\n${modifiedPatch.replaceAll("session.ts", "other.ts")}` }
    ])

    expect(entry?.fileDiff.name).toBe(files[0]!.path)
    expect(entry?.fileDiff.hunks).toEqual([])
  })

  it("keeps status, collapsed viewed files, and persistent annotations in controlled items", () => {
    const entries = createReviewCodeFiles(files, [
      { path: files[0]!.path, diff: modifiedPatch },
      { path: files[1]!.path, diff: addedPatch }
    ])
    expect(entries.map((entry) => entry.status)).toEqual(["modified", "added"])

    const selection: JinglerLineSelection = {
      path: files[0]!.path,
      side: "old",
      startLine: 1,
      endLine: 1,
      endSide: "old"
    }
    const items = createReviewCodeItems({
      entries,
      selection,
      collapseViewed: true,
      connected: true,
      routeTargetSession: "Auth session",
      drafts: [
        {
          id: "draft-1",
          path: files[0]!.path,
          line: 2,
          endLine: null,
          body: "Keep the public export stable.",
          routeToAgent: true
        }
      ],
      reviewThreads: [thread]
    })

    const session = items[0]!
    expect(session.collapsed).toBe(true)
    expect(session.type).toBe("diff")
    if (session.type !== "diff") throw new Error("expected a diff item")
    expect(
      session.annotations?.map((annotation) => ({
        kind: annotation.metadata.payload.kind,
        side: annotation.side,
        line: annotation.lineNumber
      }))
    ).toEqual([
      { kind: "inline-composer", side: "deletions", line: 1 },
      { kind: "saved-draft", side: "additions", line: 2 },
      { kind: "review-thread", side: "additions", line: 2 }
    ])
  })

  it("derives viewport focus from CodeView item offsets", () => {
    const entries = createReviewCodeFiles(files, [
      { path: files[0]!.path, diff: modifiedPatch },
      { path: files[1]!.path, diff: addedPatch }
    ])
    const items = createReviewCodeItems({
      entries,
      drafts: [],
      reviewThreads: [],
      selection: null,
      collapseViewed: false,
      connected: true,
      routeTargetSession: null
    })
    const tops = new Map([
      [items[0]!.id, 0],
      [items[1]!.id, 480]
    ])

    expect(pierreActiveCodeItemPath(items, 300, (id) => tops.get(id))).toBe(
      files[0]!.path
    )
    expect(pierreActiveCodeItemPath(items, 500, (id) => tops.get(id))).toBe(
      files[1]!.path
    )
  })

  it("translates an old-side selection to its new-side hunk range", () => {
    const shiftedPatch = [
      "diff --git a/src/auth/session.ts b/src/auth/session.ts",
      "--- a/src/auth/session.ts",
      "+++ b/src/auth/session.ts",
      "@@ -1,2 +1,3 @@",
      "+const inserted = true",
      " const stable = true",
      " const other = true",
      "@@ -20,2 +21,2 @@",
      "-const token = oldToken",
      "+const token = nextToken",
      " export { token }"
    ].join("\n")
    const [entry] = createReviewCodeFiles(files.slice(0, 1), [
      { path: files[0]!.path, diff: shiftedPatch }
    ])

    expect(
      newSideRangeForReviewSelection(
        {
          path: files[0]!.path,
          side: "old",
          startLine: 20,
          endLine: 20,
          endSide: "old"
        },
        entry!.fileDiff
      )
    ).toEqual({ startLine: 21, endLine: 22 })
  })

  it("ignores a GitHub thread whose live and original anchors are both absent", () => {
    const entries = createReviewCodeFiles(files.slice(0, 1), [
      { path: files[0]!.path, diff: modifiedPatch }
    ])
    const items = createReviewCodeItems({
      entries,
      drafts: [],
      reviewThreads: [
        {
          ...thread,
          line: null,
          originalLine: null
        }
      ],
      selection: null,
      collapseViewed: false,
      connected: true,
      routeTargetSession: null
    })

    expect(items[0]?.annotations).toEqual([])
  })
})
