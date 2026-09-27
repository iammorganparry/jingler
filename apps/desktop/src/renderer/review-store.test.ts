// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest"
import { act, renderHook } from "@testing-library/react"
import {
  addReviewDraft,
  clearReviewDrafts,
  removeReviewDraft,
  resetReviewStore,
  setReviewFilter,
  setReviewFocused,
  setReviewViewed,
  useReviewFocused,
  useSessionReviewState
} from "./review-store.js"
import { viewedStorageKey } from "./viewed-store.js"

afterEach(() => {
  resetReviewStore()
  localStorage.clear()
})

describe("review store", () => {
  it("shares one session's filter and drafts across every mounted surface", () => {
    const explorer = renderHook(() => useSessionReviewState("s1", 7))
    const tray = renderHook(() => useSessionReviewState("s1", 7))
    act(() => {
      setReviewFilter("s1", 7, "pr")
      addReviewDraft("s1", 7, { path: "a.ts", line: 3, endLine: null, body: "why?", routeToAgent: true })
    })
    expect(explorer.result.current.filter).toBe("pr")
    expect(tray.result.current.drafts).toHaveLength(1)
    expect(tray.result.current.drafts[0]).toMatchObject({ path: "a.ts", body: "why?" })

    act(() => removeReviewDraft("s1", 7, tray.result.current.drafts[0]!.id))
    expect(explorer.result.current.drafts).toHaveLength(0)
  })

  it("keeps sessions and PRs apart", () => {
    act(() => {
      setReviewFilter("s1", 7, "local")
      addReviewDraft("s1", 7, { path: "a.ts", line: 1, endLine: null, body: "x", routeToAgent: false })
    })
    const other = renderHook(() => useSessionReviewState("s2", 7))
    const nextPr = renderHook(() => useSessionReviewState("s1", 8))
    expect(other.result.current.filter).toBe("all")
    expect(nextPr.result.current.drafts).toHaveLength(0)
  })

  it("persists viewed markers per PR and returns the same state for no-op writes", () => {
    const view = renderHook(() => useSessionReviewState("s1", 7))
    act(() => setReviewViewed("s1", 7, "a.ts", true))
    expect(view.result.current.viewed.has("a.ts")).toBe(true)
    expect(JSON.parse(localStorage.getItem(viewedStorageKey("s1", 7)) ?? "[]")).toEqual(["a.ts"])

    const before = view.result.current
    act(() => {
      setReviewViewed("s1", 7, "a.ts", true)
      clearReviewDrafts("s1", 7)
      setReviewFilter("s1", 7, "all")
    })
    expect(view.result.current).toBe(before)
  })

  it("holds one app-wide focus flag", () => {
    const focus = renderHook(() => useReviewFocused())
    expect(focus.result.current).toBe(false)
    act(() => setReviewFocused(true))
    expect(focus.result.current).toBe(true)
  })
})
