import { describe, expect, it } from "vitest"
import { matchSplitEditorChord } from "./app-shortcuts.js"

const chord = (over: Partial<Parameters<typeof matchSplitEditorChord>[0]>) => ({
  key: "\\",
  code: "Backslash",
  metaKey: true,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...over
})

describe("matchSplitEditorChord", () => {
  it("splits right on ⌘\\ and down on ⌘⇧\\, matching the physical key", () => {
    expect(matchSplitEditorChord(chord({}))).toBe("split-right")
    expect(matchSplitEditorChord(chord({ shiftKey: true, key: "|" }))).toBe("split-down")
    expect(matchSplitEditorChord(chord({ metaKey: false, ctrlKey: true }))).toBe("split-right")
  })

  it("ignores the key without a modifier, or with Alt", () => {
    expect(matchSplitEditorChord(chord({ metaKey: false }))).toBeNull()
    expect(matchSplitEditorChord(chord({ altKey: true }))).toBeNull()
    expect(matchSplitEditorChord(chord({ key: "a", code: "KeyA" }))).toBeNull()
  })
})
