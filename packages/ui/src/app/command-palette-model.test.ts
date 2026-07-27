import { describe, expect, it } from "vitest"
import {
  fuzzyScore,
  groupPaletteItems,
  itemKeywords,
  matchPaletteChord,
  type PaletteItem,
  scoreItem
} from "./command-palette-model.js"

/** Real `KeyboardEvent`s, for the reason `split-shortcuts.test.ts` gives. */
const chord = (init: KeyboardEventInit) => new KeyboardEvent("keydown", init)

const item = (over: Partial<PaletteItem> = {}): PaletteItem => ({
  id: over.id ?? "id",
  kind: over.kind ?? "action",
  label: over.label ?? "Label",
  detail: over.detail,
  group: over.group ?? "Group",
  hint: over.hint,
  run: over.run ?? (() => {})
})

describe("fuzzyScore", () => {
  /**
   * The reason this module exists rather than reusing `filterSessions`.
   *
   * `matchesQuery` in `session-filters.ts` is `String.includes`, so it answers
   * "no results" to an abbreviation — which is the single most common thing
   * anyone types into a palette.
   */
  it("matches an abbreviation that a substring filter cannot", () => {
    const haystack = "starbase/session-sidebar"
    expect(haystack.includes("ssb")).toBe(false)
    expect(fuzzyScore(haystack, "ssb")).toBeGreaterThan(0)
  })

  it("returns exactly 0 for a non-match, so cmdk hides the row", () => {
    expect(fuzzyScore("theme tokens", "zzz")).toBe(0)
    // Right characters, wrong ORDER — a subsequence is ordered.
    expect(fuzzyScore("abc", "cba")).toBe(0)
  })

  it("returns 1 for an empty or whitespace query", () => {
    expect(fuzzyScore("anything", "")).toBe(1)
    expect(fuzzyScore("anything", "   ")).toBe(1)
  })

  it("never returns 0 for a match, so a real hit is never mistaken for a miss", () => {
    expect(fuzzyScore("z", "z")).toBeGreaterThan(0)
  })

  it("scores within 0..1 so cmdk's ordering stays comparable across rows", () => {
    for (const [haystack, query] of [
      ["theme tokens", "theme"],
      ["starbase/session-sidebar", "ssb"],
      ["a", "a"]
    ] as const) {
      const score = fuzzyScore(haystack, query)
      expect(score).toBeGreaterThan(0)
      expect(score).toBeLessThanOrEqual(1)
    }
  })

  it("is case-insensitive in both directions", () => {
    expect(fuzzyScore("Theme Tokens", "theme")).toBe(fuzzyScore("theme tokens", "THEME"))
  })

  describe("bonuses — the part that decides the ORDER, not just the set", () => {
    it("prefers a prefix over a match buried mid-word", () => {
      expect(fuzzyScore("auth refactor", "auth")).toBeGreaterThan(
        fuzzyScore("reauthorise the client", "auth")
      )
    })

    it("prefers initials at word boundaries over an incidental scatter", () => {
      // "n-s" reads as the initials of "new session"; in "unrelated things" the
      // same characters are just lying around.
      expect(fuzzyScore("new session", "ns")).toBeGreaterThan(
        fuzzyScore("unrelated things", "ns")
      )
    })

    it("prefers consecutive characters over spread-out ones", () => {
      expect(fuzzyScore("xtoken", "tok")).toBeGreaterThan(fuzzyScore("xtaobkc", "tok"))
    })

    it("breaks ties toward the shorter haystack", () => {
      expect(fuzzyScore("theme tokens", "theme")).toBeGreaterThan(
        fuzzyScore("theme tokens for light backgrounds everywhere", "theme")
      )
    })

    it("treats a separator as a word start", () => {
      // The 's' after the slash is a boundary hit; the one inside "grass" is not.
      expect(fuzzyScore("repo/session", "s")).toBeGreaterThan(fuzzyScore("grasses", "s"))
    })
  })
})

describe("scoreItem — the cmdk filter seam", () => {
  it("ignores the opaque value so an id cannot float an unrelated row", () => {
    // A uuid weakly matches almost anything; scoring it would rank rows by
    // accident of identity rather than by what the person typed.
    const id = "8f3ac0de-1234-4bcd-9abc-def012345678"
    expect(scoreItem(id, "abc", [])).toBe(0)
    expect(scoreItem(id, "abc", ["totally unrelated"])).toBe(0)
  })

  it("takes the BEST keyword rather than diluting across all of them", () => {
    const titleOnly = scoreItem("id", "theme", ["theme tokens"])
    const withNoisyBranch = scoreItem("id", "theme", [
      "theme tokens",
      "feat/some-very-long-branch-name-that-mentions-nothing"
    ])
    expect(withNoisyBranch).toBe(titleOnly)
  })

  it("returns 1 for an empty search so every row shows on open", () => {
    expect(scoreItem("id", "", ["anything"])).toBe(1)
  })

  it("returns 0 when a row has no keywords at all", () => {
    expect(scoreItem("id", "theme", undefined)).toBe(0)
  })
})

describe("itemKeywords", () => {
  it("drops an absent detail rather than scoring an empty string", () => {
    expect(itemKeywords(item({ label: "New Session", group: "Actions" }))).toEqual([
      "New Session",
      "Actions"
    ])
  })

  it("includes the detail when there is one", () => {
    expect(
      itemKeywords(item({ label: "auth", detail: "starbase · feat/auth", group: "Sessions" }))
    ).toEqual(["auth", "starbase · feat/auth", "Sessions"])
  })
})

describe("groupPaletteItems", () => {
  it("preserves first-seen order, because caller order IS priority order", () => {
    const groups = groupPaletteItems([
      item({ id: "a", group: "Sessions" }),
      item({ id: "b", group: "Actions" }),
      item({ id: "c", group: "Sessions" })
    ])
    expect(groups.map((g) => g.name)).toEqual(["Sessions", "Actions"])
    expect(groups[0]?.items.map((i) => i.id)).toEqual(["a", "c"])
  })

  it("never yields an empty group", () => {
    for (const group of groupPaletteItems([item()])) {
      expect(group.items.length).toBeGreaterThan(0)
    }
  })

  it("returns nothing for no items", () => {
    expect(groupPaletteItems([])).toEqual([])
  })
})

describe("matchPaletteChord", () => {
  it.each([
    ["KeyK", "k"],
    ["KeyP", "p"]
  ])("matches ⌘ and ⌃ with %s", (code, key) => {
    expect(matchPaletteChord(chord({ code, key, metaKey: true }))).toBe(true)
    expect(matchPaletteChord(chord({ code, key, ctrlKey: true }))).toBe(true)
  })

  it("matches on `key` alone, for a layout that moves the physical key", () => {
    expect(matchPaletteChord(chord({ code: "Unidentified", key: "k", metaKey: true }))).toBe(
      true
    )
  })

  it("does not fire without a modifier, so plain typing is untouched", () => {
    expect(matchPaletteChord(chord({ code: "KeyK", key: "k" }))).toBe(false)
    expect(matchPaletteChord(chord({ code: "KeyP", key: "p" }))).toBe(false)
  })

  it("does not fire with Shift or Alt held", () => {
    // ⌘⇧P is VS Code's palette; here it stays free, and a chord that fires on
    // any modifier combination fires when you meant the one next to it.
    expect(matchPaletteChord(chord({ code: "KeyP", key: "P", metaKey: true, shiftKey: true }))).toBe(
      false
    )
    expect(matchPaletteChord(chord({ code: "KeyK", key: "k", metaKey: true, altKey: true }))).toBe(
      false
    )
  })

  it("leaves the chords the app already owns alone", () => {
    // ⌘N (new session) and ⌘B (sidebar) must not open the palette.
    expect(matchPaletteChord(chord({ code: "KeyN", key: "n", metaKey: true }))).toBe(false)
    expect(matchPaletteChord(chord({ code: "KeyB", key: "b", metaKey: true }))).toBe(false)
    // ⌘F, which this feature hands to the sidebar filter.
    expect(matchPaletteChord(chord({ code: "KeyF", key: "f", metaKey: true }))).toBe(false)
  })
})
