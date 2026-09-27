// @vitest-environment node
import { describe, expect, it } from "vitest"
import { reviewCommentReference, reviewCommentsContext } from "./review-references.js"

const path = "src/auth/session.ts"
const patch = [
  `diff --git a/${path} b/${path}`,
  `--- a/${path}`,
  `+++ b/${path}`,
  "@@ -31,4 +31,6 @@",
  " export async function session(req, next) {",
  "   const s = req.session",
  "-  if (!s.token) return next()",
  "+  if (isExpired(s.token)) {",
  "+    await refresh(s)",
  "+  }",
  "   return next()",
  ""
].join("\n")

describe("review comment references", () => {
  it("captures the new-side lines a comment points at", () => {
    expect(reviewCommentReference(patch, { path, line: 33, endLine: 34 })).toEqual({
      path,
      startLine: 33,
      endLine: 34,
      source: "  if (isExpired(s.token)) {\n    await refresh(s)\n"
    })
  })

  it("treats a single-line comment as a one-line range", () => {
    expect(reviewCommentReference(patch, { path, line: 36, endLine: null })?.source).toBe(
      "  return next()\n"
    )
  })

  it("serializes every capturable comment and skips ranges the diff can't supply", () => {
    const context = reviewCommentsContext(() => patch, [
      { path, line: 33, endLine: null },
      { path, line: 90, endLine: null }
    ])
    expect(context).toContain("<repository-code-references>")
    expect(context).toContain("Lines: 33 (inclusive)")
    expect(context).toContain("if (isExpired(s.token)) {")
    expect(context).not.toContain("Lines: 90")
  })

  it("adds no context when nothing can be captured", () => {
    expect(reviewCommentsContext(() => "", [{ path, line: 1, endLine: null }])).toBe("")
  })
})
