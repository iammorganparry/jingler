import { describe, expect, it } from "vitest"
import {
  chordMatches,
  matchKeybinding,
  parseChord,
  resolveKeybindings,
  type Chord
} from "./keybinding-contributions.js"

const press = (over: Partial<Chord> = {}): Chord => ({
  key: "l",
  code: "KeyL",
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...over
})

describe("parseChord", () => {
  it("folds cmd, ctrl, meta and mod to one modifier", () => {
    // An author on macOS writing `cmd` and one on Linux writing `ctrl` should
    // not produce a plugin that only works on the machine it was written on.
    for (const spec of ["cmd+l", "ctrl+l", "meta+l", "mod+l"]) {
      expect(parseChord(spec)).toMatchObject({ mod: true, key: "l" })
    }
  })

  it("parses shift and alt", () => {
    expect(parseChord("ctrl+shift+alt+k")).toEqual({
      mod: true,
      shift: true,
      alt: true,
      key: "k"
    })
  })

  it("is case- and whitespace-insensitive", () => {
    expect(parseChord(" Ctrl + Shift + L ")).toMatchObject({ mod: true, shift: true, key: "l" })
  })

  it.each([
    ["a bare letter, which would swallow ordinary typing", "l"],
    ["shift alone, same problem", "shift+l"],
    ["two non-modifier keys", "ctrl+k+l"],
    ["nothing at all", ""],
    ["modifiers with no key", "ctrl+shift"]
  ])("rejects %s", (_why, spec) => {
    expect(parseChord(spec)).toBeNull()
  })
})

describe("chordMatches", () => {
  it("matches the intended keypress", () => {
    const chord = parseChord("ctrl+shift+l")!
    expect(chordMatches(chord, press({ ctrlKey: true, shiftKey: true }))).toBe(true)
  })

  it("accepts either meta or ctrl for a mod chord", () => {
    const chord = parseChord("mod+shift+l")!
    expect(chordMatches(chord, press({ metaKey: true, shiftKey: true }))).toBe(true)
    expect(chordMatches(chord, press({ ctrlKey: true, shiftKey: true }))).toBe(true)
  })

  it("matches on `code` when shift has rewritten `key`", () => {
    // Shift turns "l" into "L" and "=" into "+". Matching only `key` makes a
    // shifted binding fire unpredictably.
    const chord = parseChord("ctrl+shift+l")!
    expect(chordMatches(chord, press({ key: "L", ctrlKey: true, shiftKey: true }))).toBe(true)
  })

  it("does not fire when a modifier differs", () => {
    const chord = parseChord("ctrl+shift+l")!
    expect(chordMatches(chord, press({ ctrlKey: true }))).toBe(false)
    expect(chordMatches(chord, press({ ctrlKey: true, shiftKey: true, altKey: true }))).toBe(false)
    expect(chordMatches(chord, press({ shiftKey: true }))).toBe(false)
  })
})

describe("resolveKeybindings", () => {
  const binding = (over: Partial<{ pluginId: string; commandId: string; key: string }> = {}) => ({
    pluginId: "linear",
    commandId: "linear.sync",
    key: "ctrl+shift+l",
    ...over
  })

  it("activates a binding nothing else wants", () => {
    const { active, rejected } = resolveKeybindings([binding()], [])
    expect(active).toHaveLength(1)
    expect(rejected).toHaveLength(0)
  })

  it("lets a built-in win, and SAYS SO", () => {
    // A shortcut that silently does nothing is indistinguishable from a broken
    // plugin, and the author will have tested it where nothing else wanted it.
    const { active, rejected } = resolveKeybindings([binding()], ["ctrl+shift+l"])
    expect(active).toHaveLength(0)
    expect(rejected[0]?.reason).toContain("already used by Starbase")
  })

  it("matches a reserved chord written in different notation", () => {
    // `cmd+shift+l` and `ctrl+shift+l` are the same chord to this app.
    const { rejected } = resolveKeybindings([binding({ key: "cmd+shift+l" })], ["ctrl+shift+l"])
    expect(rejected).toHaveLength(1)
  })

  it("reports an unparseable chord rather than dropping it", () => {
    const { rejected } = resolveKeybindings([binding({ key: "wat" })], [])
    expect(rejected[0]?.reason).toContain("not a chord Starbase understands")
    expect(rejected[0]?.reason).toContain("ctrl+shift+l")
  })

  it("resolves two plugins wanting the same chord deterministically", () => {
    // Arbitrary is fine; unstable is not. The same two plugins must not swap
    // the binding between launches depending on directory order.
    const forward = resolveKeybindings(
      [binding({ pluginId: "zeta" }), binding({ pluginId: "alpha" })],
      []
    )
    const reversed = resolveKeybindings(
      [binding({ pluginId: "alpha" }), binding({ pluginId: "zeta" })],
      []
    )

    expect(forward.active[0]?.pluginId).toBe("alpha")
    expect(forward.active.map((a) => a.pluginId)).toEqual(
      reversed.active.map((a) => a.pluginId)
    )
    expect(forward.rejected[0]?.pluginId).toBe("zeta")
    expect(forward.rejected[0]?.reason).toContain("already used by alpha")
  })

  it("lets one plugin hold several distinct chords", () => {
    const { active } = resolveKeybindings(
      [binding(), binding({ commandId: "linear.open", key: "ctrl+shift+o" })],
      []
    )
    expect(active).toHaveLength(2)
  })
})

describe("matchKeybinding", () => {
  it("finds the binding a keypress should run", () => {
    const { active } = resolveKeybindings(
      [{ pluginId: "linear", commandId: "linear.sync", key: "ctrl+shift+l" }],
      []
    )
    const hit = matchKeybinding(active, press({ ctrlKey: true, shiftKey: true }))
    expect(hit?.commandId).toBe("linear.sync")
  })

  it("returns null for an unclaimed keypress", () => {
    const { active } = resolveKeybindings(
      [{ pluginId: "linear", commandId: "linear.sync", key: "ctrl+shift+l" }],
      []
    )
    expect(matchKeybinding(active, press({ ctrlKey: true }))).toBeNull()
  })
})
