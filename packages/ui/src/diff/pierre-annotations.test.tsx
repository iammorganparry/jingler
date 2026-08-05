import { cleanup, render, screen } from "@testing-library/react"
import type { PrReviewThread, ReviewFinding } from "@jingler/core"
import { afterEach, describe, expect, it } from "vitest"
import {
  createPierreDiffAnnotation,
  pierreAnnotationLocation,
  PierreAnnotationRegion,
  type PierreAnnotationPayload
} from "./pierre-annotations.js"

afterEach(cleanup)

const thread: PrReviewThread = {
  id: "thread-1",
  reviewId: null,
  path: "src/review.ts",
  line: null,
  startLine: null,
  originalLine: 17,
  originalStartLine: null,
  diffHunk: "",
  isResolved: false,
  isOutdated: true,
  resolvedBy: null,
  comments: []
}

const finding: ReviewFinding = {
  id: "finding-1",
  path: "src/review.ts",
  line: 20,
  endLine: 23,
  severity: "major",
  title: "Unsafe fallback",
  rationale: "The fallback skips validation.",
  suggestion: null,
  resolvedBy: null
}

describe("Pierre annotations", () => {
  it.each([
    {
      payload: {
        id: "composer",
        kind: "inline-composer",
        selection: {
          path: "src\\review.ts",
          side: "old",
          startLine: 4,
          endLine: 7,
          endSide: "old"
        },
        connected: true,
        routeTargetSession: "Agent"
      },
      expected: { path: "src/review.ts", lineNumber: 7, side: "old" }
    },
    {
      payload: {
        id: "draft",
        kind: "saved-draft",
        draft: {
          id: "draft-1",
          path: "src/review.ts",
          line: 10,
          endLine: 12,
          body: "Please explain this.",
          routeToAgent: false
        }
      },
      expected: { path: "src/review.ts", lineNumber: 12, side: "new" }
    },
    {
      payload: { id: "thread", kind: "review-thread", thread },
      expected: { path: "src/review.ts", lineNumber: 17, side: "new" }
    },
    {
      payload: { id: "finding", kind: "finding", finding },
      expected: { path: "src/review.ts", lineNumber: 23, side: "new" }
    }
  ] satisfies ReadonlyArray<{
    payload: PierreAnnotationPayload
    expected: { path: string; lineNumber: number; side: "old" | "new" }
  }>)("anchors $payload.kind through Pierre's line annotation model", ({ payload, expected }) => {
    expect(pierreAnnotationLocation(payload)).toEqual(expected)
    expect(createPierreDiffAnnotation(payload)).toMatchObject({
      lineNumber: expected.lineNumber,
      side: expected.side === "old" ? "deletions" : "additions",
      metadata: { payload }
    })
  })

  it("keeps repository-wide and invalid coordinates out of line annotations", () => {
    expect(createPierreDiffAnnotation({
      id: "general",
      kind: "finding",
      finding: { ...finding, path: null, line: null, endLine: null }
    })).toBeNull()
    expect(createPierreDiffAnnotation({
      id: "invalid",
      kind: "saved-draft",
      draft: {
        id: "draft-0",
        path: "src/review.ts",
        line: 0,
        endLine: null,
        body: "Invalid",
        routeToAgent: false
      }
    })).toBeNull()
  })

  it("exposes a stable labelled region without leaking Pierre slots", () => {
    const payload: PierreAnnotationPayload = {
      id: "actions",
      kind: "selected-range-actions",
      selection: {
        path: "src/review.ts",
        side: "new",
        startLine: 2,
        endLine: 3,
        endSide: "new"
      },
      actions: [{ id: "comment", label: "Comment", accessibleLabel: "Comment on lines" }]
    }
    render(
      <PierreAnnotationRegion label="Actions on selected lines" payload={payload}>
        <button type="button">Comment</button>
      </PierreAnnotationRegion>
    )

    const region = screen.getByRole("region", { name: "Actions on selected lines" })
    expect(region.dataset.jinglerPierreAnnotation).toBe("selected-range-actions")
    expect(screen.getByRole("button", { name: "Comment" })).toBeTruthy()
  })
})
