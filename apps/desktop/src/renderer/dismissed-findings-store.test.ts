// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import { act, renderHook } from "@testing-library/react"
import type { ReviewFinding } from "@jingler/core"
import {
  clearDismissedFindings,
  dismissedStorageKey,
  findingFingerprint,
  readDismissedFindings
} from "./dismissed-findings-store.js"
import { resetReviewStore, setFindingDismissed, useSessionReviewState } from "./review-store.js"

const finding = (over: Partial<ReviewFinding> = {}): ReviewFinding =>
  ({
    id: "f1",
    path: "a.ts",
    line: 3,
    endLine: null,
    severity: "major",
    title: "Off by one",
    rationale: "r",
    suggestion: null,
    ...over
  }) as ReviewFinding

afterEach(() => {
  resetReviewStore()
  localStorage.clear()
  vi.restoreAllMocks()
})

describe("dismissed findings", () => {
  it("survives a re-mount (reload) of the store", () => {
    const fp = findingFingerprint(finding())
    act(() => setFindingDismissed("s1", 7, fp, true))
    resetReviewStore() // drops in-memory state, keeps localStorage
    const view = renderHook(() => useSessionReviewState("s1", 7))
    expect(view.result.current.dismissedFindings.has(fp)).toBe(true)
  })

  it("is keyed per session and PR", () => {
    const fp = findingFingerprint(finding())
    act(() => setFindingDismissed("s1", 7, fp, true))
    expect(readDismissedFindings("s2", 7).size).toBe(0)
    expect(readDismissedFindings("s1", 8).size).toBe(0)
  })

  it("shows a materially different finding on the same line, even with a reused id", () => {
    const a = findingFingerprint(finding())
    expect(findingFingerprint(finding({ title: "Null deref" }))).not.toBe(a)
    expect(findingFingerprint(finding({ severity: "minor" }))).not.toBe(a)
    expect(findingFingerprint(finding({ id: "f9" }))).toBe(a)
  })

  it("restores a finding when un-dismissed", () => {
    const fp = findingFingerprint(finding())
    act(() => setFindingDismissed("s1", 7, fp, true))
    act(() => setFindingDismissed("s1", 7, fp, false))
    expect(readDismissedFindings("s1", 7).size).toBe(0)
  })

  it("tolerates corrupt, wrong-shaped and missing storage", () => {
    expect(readDismissedFindings("s1", 7).size).toBe(0)
    localStorage.setItem(dismissedStorageKey("s1", 7), "{not json")
    expect(readDismissedFindings("s1", 7).size).toBe(0)
    localStorage.setItem(dismissedStorageKey("s1", 7), JSON.stringify({ a: 1 }))
    expect(readDismissedFindings("s1", 7).size).toBe(0)
    localStorage.setItem(dismissedStorageKey("s1", 7), JSON.stringify(["ok", 3]))
    expect([...readDismissedFindings("s1", 7)]).toEqual(["ok"])
  })

  it("still dismisses for this run when storage throws", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("full")
    })
    const view = renderHook(() => useSessionReviewState("s1", 7))
    const fp = findingFingerprint(finding())
    act(() => setFindingDismissed("s1", 7, fp, true))
    expect(view.result.current.dismissedFindings.has(fp)).toBe(true)
  })

  it("clears every PR scope of a deleted session only", () => {
    localStorage.setItem(dismissedStorageKey("s1", 7), "[]")
    localStorage.setItem(dismissedStorageKey("s1", null), "[]")
    localStorage.setItem(dismissedStorageKey("s10", 7), "[]")
    clearDismissedFindings("s1")
    expect(localStorage.getItem(dismissedStorageKey("s1", 7))).toBeNull()
    expect(localStorage.getItem(dismissedStorageKey("s1", null))).toBeNull()
    expect(localStorage.getItem(dismissedStorageKey("s10", 7))).toBe("[]")
  })
})
