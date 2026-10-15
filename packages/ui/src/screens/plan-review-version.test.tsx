// @vitest-environment jsdom
import type { PlanDocument } from "@jingler/core"
import { act, renderHook } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { approvalBlockedReason, isPlanStale, REVISING_REASON, STALE_REASON, usePlanVersion } from "./plan-review-version.js"

const doc = (patch: Partial<PlanDocument>): PlanDocument => ({
  id: "plannotator:PLAN.md", sessionId: "s", producingChatId: "c", revision: 1, reviewId: "r1", status: "proposed",
  plan: { title: "Plan", sections: [], stages: [], annotations: [] }, updatedAt: "2026-01-01T00:00:00.000Z", updatedBy: "agent",
  ...patch
})

describe("plan version", () => {
  it("is stale only when a different review replaces an open one", () => {
    expect(isPlanStale(doc({}), doc({ reviewId: "r2" }))).toBe(true)
    expect(isPlanStale(doc({}), doc({ reviewId: undefined, status: "revising" }))).toBe(false)
    expect(isPlanStale(doc({ reviewId: undefined, status: "revising" }), doc({ reviewId: "r2" }))).toBe(false)
  })

  it("explains why approval is blocked", () => {
    expect(approvalBlockedReason(doc({ status: "revising", reviewId: undefined }), false)).toBe(REVISING_REASON)
    expect(approvalBlockedReason(doc({ reviewId: "r2" }), true)).toBe(STALE_REASON)
    expect(approvalBlockedReason(doc({}), false)).toBeUndefined()
  })

  it("pins the opened plan until reload", () => {
    const { result, rerender } = renderHook(({ latest }) => usePlanVersion(latest), { initialProps: { latest: doc({}) } })
    rerender({ latest: doc({ reviewId: "r2", revision: 2 }) })
    expect(result.current.stale).toBe(true)
    expect(result.current.document.revision).toBe(1)
    act(() => result.current.reload())
    expect(result.current.stale).toBe(false)
    expect(result.current.document.revision).toBe(2)
  })

  it("follows a replacement that comes after the reviewer's own decision", () => {
    const { result, rerender } = renderHook(({ latest }) => usePlanVersion(latest), { initialProps: { latest: doc({}) } })
    act(() => result.current.markDecided())
    rerender({ latest: doc({ reviewId: undefined, status: "revising" }) })
    rerender({ latest: doc({ reviewId: "r2", revision: 2 }) })
    expect(result.current.stale).toBe(false)
    expect(result.current.document.revision).toBe(2)
  })
})
