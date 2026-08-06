/**
 * The command palette's rules, with no React in them.
 *
 * Same posture as `session-filters.ts` and `split-shortcuts.ts`: what a query
 * MATCHES, what a chord MEANS, and how rows are bucketed are pure functions
 * here, so the component downstream is only composition over cmdk. The awkward
 * cases — a query that matches nothing, a shifted chord, two sessions with the
 * same title — are cheap to test when they live in a module that never mounts.
 *
 * ## Why the scorer returns a number rather than a match object
 *
 * cmdk owns filtering, sorting and keyboard navigation, and its seam for "how
 * good is this row" is `filter(value, search, keywords) => number`, where 0
 * means hide. Returning that shape directly means there is ONE ranking
 * implementation rather than ours plus cmdk's, and no way for the list we
 * scored and the list cmdk renders to disagree.
 */

import type { LucideIcon } from "lucide-react"
import type { Chord } from "./split-shortcuts.js"

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

/**
 * What kind of thing a row is. Drives the icon and nothing else — the palette
 * deliberately does not branch on this to decide what happens, because `run`
 * already knows.
 */
export type PaletteItemKind = "session" | "action" | "tab" | "plugin" | "file"

/**
 * One row.
 *
 * `run` is the ONLY thing the component knows how to do with an item, which is
 * what keeps the palette from growing a copy of the app's action table. A
 * capability that is unavailable produces no item at all rather than a disabled
 * one: a row you can select that does nothing is indistinguishable from a bug.
 */
export interface PaletteItem {
  /** Unique and stable — cmdk uses it as the row's identity. */
  readonly id: string
  readonly kind: PaletteItemKind
  readonly label: string
  /** The second line: repo, branch, plugin name. Searched as well as shown. */
  readonly detail?: string
  /** The heading this row sits under. Groups render in first-seen order. */
  readonly group: string
  /** A chord to show right-aligned, e.g. `"⌘N"`. Display only. */
  readonly hint?: string
  /**
   * The row's glyph. Optional: the palette falls back to one per `kind`, so a
   * caller only names an icon when the default would be less specific than it
   * could be (Settings, Sign out) rather than for every row.
   *
   * A type-only import, same as `TabContribution.icon` — nothing here renders.
   */
  readonly icon?: LucideIcon
  readonly run: () => void
}

/** Characters that start a new "word" for scoring purposes. */
const SEPARATORS = new Set([" ", "-", "_", "/", ".", ":", "@"])

/**
 * Score `query` against `haystack`, 0 to 1, where **0 means no match**.
 *
 * A subsequence matcher, not a substring one, and that is the entire point:
 * `filterSessions` in `session-filters.ts` uses `String.includes`, so "ssb"
 * finds nothing. In a palette, "ssb" is how a person asks for
 * `jingler/session-sidebar`, and a palette that answers "no results" to an
 * abbreviation is one people stop reaching for.
 *
 * The bonuses matter more than the base rate. A character matched at the start
 * of the string, or just after a separator, is evidence the person is typing
 * initials; a character matched adjacent to the previous one is evidence they
 * are typing a prefix. Without them every subsequence match scores the same and
 * the ordering is arbitrary — which reads as "the palette ignored what I typed".
 *
 * A small term for `query.length / haystack.length` breaks ties toward the
 * shorter, tighter match, so "theme" prefers "theme tokens" over
 * "rewrite the theme mapper for light backgrounds".
 */
export const fuzzyScore = (haystack: string, query: string): number => {
  const q = query.trim().toLowerCase()
  // An empty query matches everything equally — cmdk usually skips the filter
  // entirely in that case, but a caller that does not should still see rows.
  if (q.length === 0) return 1
  const h = haystack.toLowerCase()
  if (h.length === 0) return 0

  // Two alignments, best wins. See `rawScore`.
  const raw = Math.max(rawScore(h, q, false), rawScore(h, q, true))
  if (raw === 0) return 0

  const best = q.length * 5 // 1 base + 4, the largest bonus, per character
  return 0.9 * (raw / best) + 0.1 * (q.length / h.length)
}

/**
 * Score ONE alignment of `q` through `h`. 0 means the subsequence isn't there.
 *
 * ## Why this runs twice
 *
 * Taking the leftmost occurrence of each character is greedy, and greedy throws
 * away the word-boundary bonus the ranking is built on. Search "se" against
 * "case session" and the leftmost `s` is the one inside "case" — no bonus, and
 * the score comes out 4 where the aligning-to-"session" reading scores 7. The
 * docblock above promises that a character after a separator is treated as
 * evidence of initials; under pure greed that promise held only when the two
 * happened to coincide, which is exactly the "the palette ignored what I typed"
 * failure the bonuses exist to prevent.
 *
 * `preferBoundary` runs the same walk but skips each character forward to the
 * next occurrence that starts a word, when there is one. That pass can FAIL
 * where greedy succeeds — "sa" against "case sx" jumps the `s` to the word start
 * and then finds no `a` after it — which is why the caller takes the max of the
 * two rather than trusting either alone. Two linear passes over strings the
 * length of a session title is not a cost worth optimising away.
 */
const rawScore = (h: string, q: string, preferBoundary: boolean): number => {
  const startsWord = (at: number) => at === 0 || SEPARATORS.has(h[at - 1] ?? "")

  let cursor = 0
  let raw = 0
  let previous = -2 // -2 so the first match is never "consecutive"

  for (const needle of q) {
    let at = h.indexOf(needle, cursor)
    if (at === -1) return 0

    if (preferBoundary && !startsWord(at)) {
      for (let probe = at; probe !== -1; probe = h.indexOf(needle, probe + 1)) {
        if (startsWord(probe)) {
          at = probe
          break
        }
      }
    }

    // Ranked, not summed: a character cannot be both at index 0 and adjacent to
    // its predecessor, and stacking the bonuses would let a long weak match beat
    // a short strong one.
    const bonus =
      at === 0 ? 4 : SEPARATORS.has(h[at - 1] ?? "") ? 3 : at === previous + 1 ? 2 : 0

    raw += 1 + bonus
    previous = at
    cursor = at + 1
  }

  return raw
}

/**
 * cmdk's `filter` prop, adapted.
 *
 * `value` is the row's identity — a session id, a `<pluginId>.<command>` — and
 * is deliberately NOT scored: a uuid is a bag of characters that matches almost
 * any query weakly, which would float unrelated rows above real ones. The
 * searchable text arrives as `keywords`, and the best-scoring keyword wins
 * rather than a concatenation of them all, so a query that matches the title
 * cleanly is not diluted by a long branch name sitting beside it.
 */
export const scoreItem = (
  _value: string,
  search: string,
  keywords?: ReadonlyArray<string>
): number => {
  if (search.trim().length === 0) return 1
  let best = 0
  for (const keyword of keywords ?? []) {
    const score = fuzzyScore(keyword, search)
    if (score > best) best = score
  }
  return best
}

/** The strings a row is searched by. Empty ones are dropped, not scored. */
export const itemKeywords = (item: PaletteItem): ReadonlyArray<string> =>
  [item.label, item.detail, item.group].filter(
    (s): s is string => typeof s === "string" && s.length > 0
  )

/**
 * A command a plugin's manifest contributed, flattened for the palette.
 *
 * `CommandContribution` in `@jingler/core` is documented as "an entry in the
 * command palette" and the `Plugins.invoke` RPC has existed alongside it — until
 * now there was simply no palette for it to be an entry in. This is the shape
 * the renderer hands across, because `@jingler/ui` cannot reach the RPC client
 * to fetch it itself.
 */
export interface PluginPaletteCommand {
  readonly pluginId: string
  /** The fully-qualified `<pluginId>.<local>` id `Plugins.invoke` expects. */
  readonly commandId: string
  readonly title: string
  /** The manifest's grouping, e.g. "GitHub". */
  readonly category?: string
  /** The plugin's display name — the group when no category was declared. */
  readonly pluginName: string
}

/**
 * The headings the app itself uses.
 *
 * Exported so `jingler-app.tsx` builds its groups from the same constants this
 * module defends — two lists spelled the same way in two files is how a reserved
 * name stops being reserved.
 */
export const PALETTE_GROUP = {
  sessions: "Sessions",
  actions: "Actions",
  tabs: "Go to tab",
  files: "Files",
  archived: "Archived sessions"
} as const

const BUILTIN_GROUP_NAMES: ReadonlySet<string> = new Set(Object.values(PALETTE_GROUP))

/**
 * The heading a plugin's command sits under, and it always names the plugin.
 *
 * `category` comes from a manifest, and `groupPaletteItems` merges groups by
 * name — so a plugin declaring `category: "Actions"` with the title "Sign out"
 * used to land a row of THIRD-PARTY CODE under the built-in Actions heading,
 * separated from the genuine row only by small print. That is the one row in
 * this palette where provenance matters most.
 *
 * So the plugin's name is always part of the heading, and the bare fallback is
 * checked against the built-ins too — otherwise a plugin merely called "Actions"
 * would walk through the front door instead of the side one.
 */
export const pluginGroupName = (
  category: string | undefined,
  pluginName: string
): string => {
  const trimmed = category?.trim()
  const label = trimmed ? `${trimmed} · ${pluginName}` : pluginName
  return BUILTIN_GROUP_NAMES.has(label) ? `${label} (plugin)` : label
}

/** One heading and its rows, in the order the caller supplied them. */
export interface PaletteGroup {
  readonly name: string
  readonly items: ReadonlyArray<PaletteItem>
}

/**
 * Bucket items by `group`, preserving first-seen order.
 *
 * Not alphabetical: the caller's order IS the priority order (sessions first,
 * then app actions, then the active session's tabs, then plugins), and sorting
 * it would put "Archive" above "Sessions" for no reason a reader could name.
 * Empty groups cannot occur — a group exists because something is in it.
 */
export const groupPaletteItems = (
  items: ReadonlyArray<PaletteItem>
): ReadonlyArray<PaletteGroup> => {
  const byName = new Map<string, Array<PaletteItem>>()
  for (const item of items) {
    const list = byName.get(item.group)
    if (list) list.push(item)
    else byName.set(item.group, [item])
  }
  return [...byName].map(([name, groupItems]) => ({ name, items: groupItems }))
}

// ---------------------------------------------------------------------------
// The chord
// ---------------------------------------------------------------------------

/**
 * `Chord` plus the one field the palette needs that a split shortcut does not.
 *
 * Widened here rather than on the shared `Chord`, which is deliberately the
 * minimum a pure matcher can be tested against — a real `KeyboardEvent`
 * satisfies both, and `matchSplitShortcut` has no business reading this.
 */
export type PaletteChord = Chord & { readonly defaultPrevented?: boolean }

/**
 * Is this a Mac? Read once, from the renderer's own globals.
 *
 * `navigator.platform` is deprecated and `userAgentData` is not in every engine
 * this package is compiled against (Storybook, jsdom), so both are tried and a
 * miss answers "not a Mac" — the branch that keeps Ctrl working, which is the
 * safe way round for a chord nobody can otherwise reach.
 */
const isMacPlatform = (): boolean => {
  const nav: unknown = globalThis.navigator
  if (typeof nav !== "object" || nav === null) return false
  const { platform, userAgent } = nav as { platform?: string; userAgent?: string }
  return /mac/i.test(platform ?? userAgent ?? "")
}

/**
 * Does this keypress ask for the palette? **⌘K/⌘P on macOS, Ctrl+K/Ctrl+P
 * elsewhere** — not either-or.
 *
 * ## Why this one chord breaks the app's `meta || ctrl` rule
 *
 * `matchSplitShortcut` accepts either modifier on every platform, and says so:
 * the same physical gesture should work on macOS and elsewhere. That holds for
 * ITS chords because they are all ⌃⇧-something, and nothing else wants those.
 *
 * K and P are different. On macOS, Ctrl+K and Ctrl+P are Cocoa caret bindings
 * that Chromium implements in every text field — kill-line and previous-line —
 * so accepting bare Ctrl here would take both away from the composer and pop a
 * modal instead, on the platform where ⌘ is already the palette chord and the
 * Ctrl variant buys nothing. They are also readline's kill-line and
 * previous-history, which matters in an app with a terminal dock in it.
 *
 * VS Code draws the line in the same place, and for the same reason.
 *
 * ## `defaultPrevented`
 *
 * Bailing on an already-handled event is what keeps this from stealing a key
 * some nearer handler has claimed. The listener sits on `window` in the bubble
 * phase, so anything closer to the target — a dock, an editor, a plugin's own
 * input — gets first refusal simply by doing its job.
 *
 * Both `code` and `key` are checked for the same reason `matchSplitShortcut`
 * does it: `code` names the physical key and survives layouts, `key` covers a
 * layout that puts K or P somewhere else.
 *
 * Shift and Alt must be ABSENT. ⌘⇧P is VS Code's palette, but here it is free
 * for something else, and a chord that fires on any modifier combination is a
 * chord that fires when you meant something adjacent to it.
 *
 * @param isMac - defaults to the running platform; injected by the tests, which
 * must be able to assert BOTH branches on one machine.
 */
export const matchPaletteChord = (
  e: PaletteChord,
  isMac: boolean = isMacPlatform()
): boolean => {
  if (e.defaultPrevented) return false
  // The one modifier that counts, per platform. Accepting the other as well is
  // what would collide; requiring the absence of it is what makes ⌘K on a Mac
  // unambiguous.
  if (isMac ? !e.metaKey || e.ctrlKey : !e.ctrlKey || e.metaKey) return false
  if (e.shiftKey || e.altKey) return false
  const key = e.key.toLowerCase()
  return e.code === "KeyK" || key === "k" || e.code === "KeyP" || key === "p"
}

/** VS Code-style focused-session file picker: ⌘⇧P (Ctrl+Shift+P elsewhere). */
export const matchFileQuickOpenChord = (
  e: PaletteChord,
  isMac: boolean = isMacPlatform()
): boolean => {
  if (e.defaultPrevented || e.altKey || !e.shiftKey) return false
  if (isMac ? !e.metaKey || e.ctrlKey : !e.ctrlKey || e.metaKey) return false
  return e.code === "KeyP" || e.key.toLowerCase() === "p"
}
