import { describe, expect, it } from "vitest"
import type { PrFileChange } from "@jingler/core"
import { filterReviewFiles, reviewFileKindOf } from "./review-file-filter.js"

const file = (path: string): PrFileChange => ({
  path,
  additions: 1,
  deletions: 0,
  commentCount: 0,
  viewed: false
})

describe("review file filters", () => {
  it.each([
    ["src/auth.test.ts", "tests"],
    ["src/__tests__/auth.ts", "tests"],
    ["package.json", "json"],
    ["docs/review.md", "docs"],
    ["src/app.css", "styles"],
    ["src/app.ts", "code"]
  ] as const)("classifies %s as %s", (path, kind) => {
    expect(reviewFileKindOf(path)).toBe(kind)
  })

  it("combines path search, type, and feedback filters", () => {
    const files = [file("src/auth.test.ts"), file("src/app.test.ts"), file("package.json")]
    expect(
      filterReviewFiles(files, {
        query: "auth",
        kind: "tests",
        feedbackPaths: new Set(["src/auth.test.ts"])
      }).map((entry) => entry.path)
    ).toEqual(["src/auth.test.ts"])
  })
})
