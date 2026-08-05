import { describe, expect, it } from "vitest"
import { planDraftPost } from "./review-post.js"

/**
 * The reviewer's own drafts becoming REAL inline comments on the PR.
 *
 * The thing worth protecting is the all-or-nothing failure mode: GitHub rejects
 * the ENTIRE review when one comment names a line that isn't on the diff's NEW
 * side, so a draft written on a line the agent has since pushed over must fold
 * into the body rather than be sent. Losing one comment's anchor is a nuisance;
 * losing the whole review is the bug.
 */

// Two files. `a.ts` has new-side lines 1-3; `b.ts` has new-side lines 1-2.
const DIFF = [
  "diff --git a/a.ts b/a.ts",
  "--- a/a.ts",
  "+++ b/a.ts",
  "@@ -1,2 +1,3 @@",
  " const one = 1",
  "+const two = 2",
  " const three = 3",
  "diff --git a/b.ts b/b.ts",
  "--- a/b.ts",
  "+++ b/b.ts",
  "@@ -1,1 +1,2 @@",
  " const x = 1",
  "+const y = 2"
].join("\n")

const draft = (over: Partial<{ path: string; line: number; startLine: number | null; body: string }> = {}) => ({
  path: "a.ts",
  line: 2,
  startLine: null,
  body: "tighten this",
  ...over
})

describe("planDraftPost", () => {
  it("returns null when there are no drafts", () => {
    expect(planDraftPost([], DIFF)).toBeNull()
  })

  it("anchors a single-line draft, leaving startLine off", () => {
    const plan = planDraftPost([draft({ line: 2 })], DIFF)
    expect(plan?.comments).toStrictEqual([
      { path: "a.ts", line: 2, startLine: null, body: "tighten this" }
    ])
    expect(plan?.unanchoredCount).toBe(0)
  })

  it("keeps a multi-line range when BOTH ends are on the diff", () => {
    const plan = planDraftPost([draft({ startLine: 1, line: 3 })], DIFF)
    // GitHub anchors at the range END, with start_line above it.
    expect(plan?.comments).toStrictEqual([
      { path: "a.ts", line: 3, startLine: 1, body: "tighten this" }
    ])
  })

  it("degrades a half-valid range to a single-line comment rather than 422-ing", () => {
    // startLine 1 is on the diff, line 99 is not — the range end is what GitHub
    // validates most strictly, so fall back to the end we know is good.
    const plan = planDraftPost([draft({ startLine: 1, line: 99 })], DIFF)
    expect(plan?.comments).toStrictEqual([
      { path: "a.ts", line: 1, startLine: null, body: "tighten this" }
    ])
    expect(plan?.unanchoredCount).toBe(0)
  })

  it("folds a draft on a line that's no longer in the diff into the body", () => {
    const plan = planDraftPost([draft({ line: 42 })], DIFF)
    expect(plan?.comments).toStrictEqual([])
    expect(plan?.unanchoredCount).toBe(1)
    // The words survive, with the anchor spelled out.
    expect(plan?.body).toContain("a.ts:42")
    expect(plan?.body).toContain("tighten this")
  })

  it("folds a draft on a file outside the diff", () => {
    const plan = planDraftPost([draft({ path: "gone.ts", line: 1 })], DIFF)
    expect(plan?.unanchoredCount).toBe(1)
    expect(plan?.body).toContain("gone.ts:1")
  })

  it("renders an unanchored range as start-end", () => {
    const plan = planDraftPost([draft({ startLine: 40, line: 42 })], DIFF)
    expect(plan?.body).toContain("a.ts:40-42")
  })

  it("posts the anchorable half and folds the rest, in one review", () => {
    const plan = planDraftPost(
      [
        draft({ path: "a.ts", line: 2, body: "keeps its line" }),
        draft({ path: "a.ts", line: 99, body: "moved off the diff" }),
        draft({ path: "b.ts", line: 2, body: "other file" })
      ],
      DIFF
    )
    expect(plan?.comments).toStrictEqual([
      { path: "a.ts", line: 2, startLine: null, body: "keeps its line" },
      { path: "b.ts", line: 2, startLine: null, body: "other file" }
    ])
    expect(plan?.unanchoredCount).toBe(1)
    expect(plan?.body).toContain("moved off the diff")
    // The ones that DID anchor must not be duplicated into the body — they'd
    // then read twice on the PR, once inline and once in the summary.
    expect(plan?.body).not.toContain("keeps its line")
  })
})
