// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("../../CHANGELOG.md?raw", () => ({ default: "" }))

const { LAST_RUN_VERSION_KEY, useReleaseNotes } = await import("./use-release-notes.js")

const CHANGELOG = [
  "## 0.3.0",
  "- a1b2c3d: Review changes in the Explorer.",
  "## 0.2.2",
  "- d4e5f60: Send review comments with their code.",
  "## 0.2.1",
  "- c2a2490: Make Cloud sessions selectable."
].join("\n")

afterEach(() => localStorage.clear())

describe("useReleaseNotes", () => {
  it("records the first launch without announcing anything", () => {
    const { result } = renderHook(() => useReleaseNotes("0.3.0", CHANGELOG))
    expect(result.current.announcement).toBeUndefined()
    expect(localStorage.getItem(LAST_RUN_VERSION_KEY)).toBe("0.3.0")
  })

  it("announces every change since the last version that ran, until dismissed", () => {
    localStorage.setItem(LAST_RUN_VERSION_KEY, "0.2.1")
    const { result } = renderHook(() => useReleaseNotes("0.3.0", CHANGELOG))

    expect(result.current.announcement?.version).toBe("0.3.0")
    expect(result.current.announcement?.notes).toEqual([
      "Review changes in the Explorer.",
      "Send review comments with their code."
    ])

    act(() => result.current.announcement?.onDismiss())
    expect(result.current.announcement).toBeUndefined()
    expect(localStorage.getItem(LAST_RUN_VERSION_KEY)).toBe("0.3.0")
  })

  it("lists every skipped version in What's new, and still does after dismissal", () => {
    localStorage.setItem(LAST_RUN_VERSION_KEY, "0.2.1")
    const { result } = renderHook(() => useReleaseNotes("0.3.0", CHANGELOG))
    const skipped = [
      { version: "0.3.0", notes: ["Review changes in the Explorer."] },
      { version: "0.2.2", notes: ["Send review comments with their code."] }
    ]
    expect(result.current.whatsNew).toEqual(skipped)

    act(() => result.current.announcement?.onDismiss())
    expect(result.current.announcement).toBeUndefined()
    expect(result.current.whatsNew).toEqual(skipped)
  })

  it("shows the current version's notes when nothing was skipped", () => {
    localStorage.setItem(LAST_RUN_VERSION_KEY, "0.3.0")
    const { result } = renderHook(() => useReleaseNotes("0.3.0", CHANGELOG))
    expect(result.current.announcement).toBeUndefined()
    expect(result.current.whatsNew).toEqual([
      { version: "0.3.0", notes: ["Review changes in the Explorer."] }
    ])
  })

  it("stays quiet on a downgrade", () => {
    localStorage.setItem(LAST_RUN_VERSION_KEY, "0.3.0")
    expect(renderHook(() => useReleaseNotes("0.2.2", CHANGELOG)).result.current.announcement).toBeUndefined()
    expect(localStorage.getItem(LAST_RUN_VERSION_KEY)).toBe("0.2.2")
  })
})
