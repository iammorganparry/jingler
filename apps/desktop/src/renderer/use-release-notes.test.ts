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
    expect(result.current).toBeUndefined()
    expect(localStorage.getItem(LAST_RUN_VERSION_KEY)).toBe("0.3.0")
  })

  it("announces every change since the last version that ran, until dismissed", () => {
    localStorage.setItem(LAST_RUN_VERSION_KEY, "0.2.1")
    const { result } = renderHook(() => useReleaseNotes("0.3.0", CHANGELOG))

    expect(result.current?.version).toBe("0.3.0")
    expect(result.current?.notes).toEqual([
      "Review changes in the Explorer.",
      "Send review comments with their code."
    ])

    act(() => result.current?.onDismiss())
    expect(result.current).toBeUndefined()
    expect(localStorage.getItem(LAST_RUN_VERSION_KEY)).toBe("0.3.0")
  })

  it("stays quiet on the same version and on a downgrade", () => {
    localStorage.setItem(LAST_RUN_VERSION_KEY, "0.3.0")
    expect(renderHook(() => useReleaseNotes("0.3.0", CHANGELOG)).result.current).toBeUndefined()
    expect(renderHook(() => useReleaseNotes("0.2.2", CHANGELOG)).result.current).toBeUndefined()
    expect(localStorage.getItem(LAST_RUN_VERSION_KEY)).toBe("0.2.2")
  })
})
