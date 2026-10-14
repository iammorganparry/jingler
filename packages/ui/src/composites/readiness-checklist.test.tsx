import { cleanup, render, screen } from "@testing-library/react"
import type { PullRequest } from "@jingler/core"
import { afterEach, describe, expect, it } from "vitest"
import { openTodoCount, ReadinessChecklist, readinessRows } from "./readiness-checklist.js"

const pr = {
  baseRefName: "main",
  body: "Fixes the thing.",
  checks: [{ name: "build", status: "pass", detailsUrl: null, durationMs: 1 }],
  reviewThreads: [],
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN"
} as unknown as PullRequest

const withPr = (patch: Partial<PullRequest>) => ({ ...pr, ...patch }) as PullRequest
const label = (p: PullRequest, id: string) => readinessRows(p).find((r) => r.id === id)

afterEach(cleanup)

describe("ReadinessChecklist", () => {
  it("renders five rows, all satisfied for a clean PR", () => {
    render(<ReadinessChecklist pr={pr} />)
    for (const text of ["No conflicts with main", "All 1 check passed", "All review threads resolved", "No open todos", "Description added"]) {
      expect(screen.getByText(text)).toBeTruthy()
    }
    expect(readinessRows(pr).every((r) => r.done && !r.failed)).toBe(true)
  })

  it("marks only conflicts and failing checks as failed", () => {
    const bad = withPr({
      mergeable: "CONFLICTING",
      checks: [{ name: "lint", status: "fail", detailsUrl: null, durationMs: null }],
      reviewThreads: [{ isResolved: false }] as unknown as PullRequest["reviewThreads"]
    })
    expect(label(bad, "git")?.failed).toBe(true)
    expect(label(bad, "ci")).toMatchObject({ failed: true, label: "1 of 1 check failing" })
    expect(label(bad, "threads")).toMatchObject({ done: false, label: "1 unresolved review thread" })
    expect(label(bad, "threads")?.failed).toBeUndefined()
  })

  it("counts unchecked todos in the description and flags a missing one", () => {
    expect(openTodoCount("- [ ] a\n- [x] b\n* [ ] c")).toBe(2)
    expect(label(withPr({ body: null }), "description")).toMatchObject({ done: false, label: "No description" })
  })
})
