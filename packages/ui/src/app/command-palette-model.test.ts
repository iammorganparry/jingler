import { describe, expect, it } from "vitest"
import {
  fuzzyScore,
  groupPaletteItems,
  itemKeywords,
  matchFileQuickOpenChord,
  matchPaletteChord,
  PALETTE_GROUP,
  type PaletteItem,
  pluginGroupName,
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
    const haystack = "jingler/session-sidebar"
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
      ["jingler/session-sidebar", "ssb"],
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

    /**
     * The bug the second alignment pass exists for.
     *
     * Taking the leftmost occurrence of each character is greedy, and greedy
     * throws the word-boundary bonus away: the first `s` in "case session" is
     * inside "case", so the docblock's promise that a post-separator character
     * counts as initials held only when greed happened to land on one.
     */
    it("aligns to a word boundary rather than the leftmost occurrence", () => {
      // The two haystacks are the SAME LENGTH, so the length tie-breaker cannot
      // account for the gap — the only difference is that "case session" offers
      // an "se" that starts a word and "casexsession" does not. Greedy takes the
      // "se" inside "case" in both and scores them alike; this must not.
      expect("case session".length).toBe("casexsession".length)
      expect(fuzzyScore("case session", "se")).toBeGreaterThan(
        fuzzyScore("casexsession", "se")
      )
    })

    it("still matches when the boundary alignment would fail", () => {
      // "xsa sx": greedy takes the `s` at 1 and finds the `a` at 2. The boundary
      // pass jumps to the `s` at 4 (after the space) and then finds no `a` after
      // it at all — so that pass scores 0 and the greedy one has to carry the
      // match. Taking the max of the two is what makes the preference safe.
      expect(fuzzyScore("xsa sx", "sa")).toBeGreaterThan(0)
    })

    it("treats a separator as a word start", () => {
      // The 's' after the slash is a boundary hit; the one inside "grass" is not.
      expect(fuzzyScore("repo/session", "s")).toBeGreaterThan(fuzzyScore("grasses", "s"))
    })
  })
})

describe("matchFileQuickOpenChord", () => {
  it("matches Cmd+Shift+P on macOS without colliding with the ordinary palette", () => {
    const event = chord({ key: "P", code: "KeyP", metaKey: true, shiftKey: true })
    expect(matchFileQuickOpenChord(event, true)).toBe(true)
    expect(matchPaletteChord(event, true)).toBe(false)
  })

  it("matches Ctrl+Shift+P off macOS and refuses the other platform modifier", () => {
    expect(
      matchFileQuickOpenChord(
        chord({ key: "P", code: "KeyP", ctrlKey: true, shiftKey: true }),
        false
      )
    ).toBe(true)
    expect(
      matchFileQuickOpenChord(
        chord({ key: "P", code: "KeyP", metaKey: true, shiftKey: true }),
        false
      )
    ).toBe(false)
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
      itemKeywords(item({ label: "auth", detail: "jingler · feat/auth", group: "Sessions" }))
    ).toEqual(["auth", "jingler · feat/auth", "Sessions"])
  })
})

describe("pluginGroupName", () => {
  /**
   * A plugin command is the one row in this palette that runs third-party code,
   * and `groupPaletteItems` merges groups by name — so a manifest declaring
   * `category: "Actions"` with the title "Sign out" used to sit under the real
   * Actions heading, told apart only by small print.
   */
  it("never lets a category impersonate a built-in heading", () => {
    for (const builtin of Object.values(PALETTE_GROUP)) {
      const group = pluginGroupName(builtin, "Evil Plugin")
      expect(group).not.toBe(builtin)
      expect(group).toContain("Evil Plugin")
    }
  })

  it("catches a plugin merely NAMED after a built-in, with no category", () => {
    expect(pluginGroupName(undefined, PALETTE_GROUP.actions)).not.toBe(PALETTE_GROUP.actions)
  })

  it("keeps the author's category, with the plugin named alongside it", () => {
    expect(pluginGroupName("Issues", "GitHub Issues")).toBe("Issues · GitHub Issues")
  })

  it("falls back to the plugin's name when no category was declared", () => {
    expect(pluginGroupName(undefined, "GitHub Issues")).toBe("GitHub Issues")
    expect(pluginGroupName("   ", "GitHub Issues")).toBe("GitHub Issues")
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
  // The platform is INJECTED in every case below. A matcher whose result depends
  // on the machine running the suite is a matcher only half of which is ever
  // tested, and the two branches are the whole point of this function.
  const MAC = true
  const PC = false

  it.each([
    ["KeyK", "k"],
    ["KeyP", "p"]
  ])("matches ⌘%s on macOS and Ctrl+%s elsewhere", (code, key) => {
    expect(matchPaletteChord(chord({ code, key, metaKey: true }), MAC)).toBe(true)
    expect(matchPaletteChord(chord({ code, key, ctrlKey: true }), PC)).toBe(true)
  })

  /**
   * The regression this signature exists for.
   *
   * Ctrl+K and Ctrl+P are Cocoa caret bindings Chromium implements in every
   * macOS text field (kill-line, previous-line) and readline's equivalents in
   * the terminal dock. Accepting bare Ctrl on macOS — which the app's usual
   * `meta || ctrl` posture would — takes both away and pops a modal instead, on
   * the one platform where ⌘K already works.
   */
  it.each([
    ["KeyK", "k"],
    ["KeyP", "p"]
  ])("does NOT take Ctrl+%s on macOS, where it is an editing key", (code, key) => {
    expect(matchPaletteChord(chord({ code, key, ctrlKey: true }), MAC)).toBe(false)
  })

  it("does not take ⌘K on a non-Mac, where ⌘ is not the app modifier", () => {
    expect(matchPaletteChord(chord({ code: "KeyK", key: "k", metaKey: true }), PC)).toBe(false)
  })

  it("does not fire when both modifiers are held, on either platform", () => {
    const both = chord({ code: "KeyK", key: "k", metaKey: true, ctrlKey: true })
    expect(matchPaletteChord(both, MAC)).toBe(false)
    expect(matchPaletteChord(both, PC)).toBe(false)
  })

  /**
   * The listener sits on `window` in the bubble phase, so anything nearer the
   * target that has already claimed the key — a terminal, an editor, a plugin's
   * input — keeps it simply by doing its job.
   */
  it("bails on an event some nearer handler already claimed", () => {
    const e = chord({ code: "KeyK", key: "k", metaKey: true, cancelable: true })
    expect(matchPaletteChord(e, MAC)).toBe(true)
    e.preventDefault()
    expect(e.defaultPrevented).toBe(true)
    expect(matchPaletteChord(e, MAC)).toBe(false)
  })

  it("matches on `key` alone, for a layout that moves the physical key", () => {
    expect(
      matchPaletteChord(chord({ code: "Unidentified", key: "k", metaKey: true }), MAC)
    ).toBe(true)
  })

  it("does not fire without a modifier, so plain typing is untouched", () => {
    expect(matchPaletteChord(chord({ code: "KeyK", key: "k" }), MAC)).toBe(false)
    expect(matchPaletteChord(chord({ code: "KeyP", key: "p" }), PC)).toBe(false)
  })

  it("does not fire with Shift or Alt held", () => {
    // ⌘⇧P is VS Code's palette; here it stays free, and a chord that fires on
    // any modifier combination fires when you meant the one next to it.
    expect(
      matchPaletteChord(chord({ code: "KeyP", key: "P", metaKey: true, shiftKey: true }), MAC)
    ).toBe(false)
    expect(
      matchPaletteChord(chord({ code: "KeyK", key: "k", metaKey: true, altKey: true }), MAC)
    ).toBe(false)
  })

  it("leaves the chords the app already owns alone", () => {
    // ⌘N (new session) and ⌘B (sidebar) must not open the palette.
    expect(matchPaletteChord(chord({ code: "KeyN", key: "n", metaKey: true }), MAC)).toBe(false)
    expect(matchPaletteChord(chord({ code: "KeyB", key: "b", metaKey: true }), MAC)).toBe(false)
    // ⌘F, which this feature hands to the sidebar filter.
    expect(matchPaletteChord(chord({ code: "KeyF", key: "f", metaKey: true }), MAC)).toBe(false)
  })

  it("defaults to the running platform when none is injected", () => {
    // jsdom's navigator reports a non-Mac UA, so the Ctrl branch is the live one
    // here. The assertion is that the default is READ at all, not what it says.
    expect(matchPaletteChord(chord({ code: "KeyK", key: "k", ctrlKey: true }))).toBe(true)
  })
})
