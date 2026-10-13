import { describe, expect, it } from "vitest"
import { matchBrowserChord, matchChangesChord, matchHeaderViewChord, matchSplitEditorChord, matchTerminalChord, tabShortcutHint } from "./app-shortcuts.js"

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

describe("header view chords", () => {
  const key = (over: Partial<Parameters<typeof matchSplitEditorChord>[0]>) => chord({ metaKey: false, ...over })

  it("opens Changes on ⌘⇧D and Browser on ⌘⇧B, by physical key", () => {
    expect(matchChangesChord(key({ metaKey: true, shiftKey: true, key: "D", code: "KeyD" }))).toBe(true)
    expect(matchBrowserChord(key({ metaKey: true, shiftKey: true, key: "B", code: "KeyB" }))).toBe(true)
    expect(matchBrowserChord(key({ ctrlKey: true, shiftKey: true, key: "B", code: "KeyB" }))).toBe(true)
    expect(matchChangesChord(key({ metaKey: true, key: "d", code: "KeyD" }))).toBe(false)
  })

  it("keeps ⌘⇧E, ⌘⇧L, ⌘L and ⌘P off the new chords", () => {
    for (const [k, c] of [["E", "KeyE"], ["L", "KeyL"], ["P", "KeyP"]] as const) {
      const e = key({ metaKey: true, shiftKey: true, key: k, code: c })
      expect(matchChangesChord(e) || matchBrowserChord(e)).toBe(false)
    }
    expect(matchChangesChord(key({ metaKey: true, key: "l", code: "KeyL" }))).toBe(false)
  })

  it("shows ⌘⇧D beside Changes only, since Code Review merged into it", () => {
    expect(tabShortcutHint("changes")).toBe("⌘⇧D")
    expect(tabShortcutHint("review")).toBeUndefined()
  })

  it("opens Terminal on ⌃`", () => {
    expect(matchTerminalChord(key({ ctrlKey: true, key: "`", code: "Backquote" }))).toBe(true)
  })

  it("maps ⌥1–⌥9 to a zero-based pin position, even when macOS rewrites key", () => {
    expect(matchHeaderViewChord(key({ altKey: true, key: "¡", code: "Digit1" }))).toBe(0)
    expect(matchHeaderViewChord(key({ altKey: true, key: "9", code: "Digit9" }))).toBe(8)
    expect(matchHeaderViewChord(key({ altKey: true, key: "0", code: "Digit0" }))).toBeNull()
    expect(matchHeaderViewChord(key({ key: "1", code: "Digit1" }))).toBeNull()
    expect(matchHeaderViewChord(key({ altKey: true, shiftKey: true, key: "1", code: "Digit1" }))).toBeNull()
    expect(matchHeaderViewChord(key({ altKey: true, metaKey: true, key: "1", code: "Digit1" }))).toBeNull()
  })
})
