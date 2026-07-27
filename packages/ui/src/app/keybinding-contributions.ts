/**
 * Keybinding contributions — a plugin claiming a chord.
 *
 * ## A claim, not a grant
 *
 * Built-ins win every collision, and the loss is REPORTED rather than swallowed.
 * A plugin whose shortcut silently does nothing is indistinguishable, from the
 * operator's side, from a plugin that is broken — and the author will have
 * tested it on a machine where nothing else wanted that chord.
 *
 * Between two plugins, the first to load wins and the second is told. That is
 * arbitrary but deterministic, which is the property that matters: the same two
 * plugins must not swap the binding between launches depending on directory
 * order.
 *
 * ## Why parsing is here and not in the manifest schema
 *
 * `"ctrl+shift+l"` is a string in `jingler.plugin.json` because that is the
 * notation VS Code authors already know. Turning it into a predicate over a
 * keyboard event needs to know about `code` vs `key`, which is a renderer
 * concern — the schema's job is to accept a plausible string, and this module's
 * is to decide whether a given keypress is it.
 */

/** The subset of a keyboard event a chord is matched against. */
export interface Chord {
  readonly key: string
  readonly code: string
  readonly metaKey: boolean
  readonly ctrlKey: boolean
  readonly shiftKey: boolean
  readonly altKey: boolean
}

/** A parsed chord: modifiers plus one key. */
export interface ParsedChord {
  readonly mod: boolean
  readonly shift: boolean
  readonly alt: boolean
  readonly key: string
}

/** One binding a plugin asked for, and the command it runs. */
export interface KeybindingContribution {
  readonly pluginId: string
  readonly commandId: string
  /** The chord as written in the manifest, e.g. `"ctrl+shift+l"`. */
  readonly key: string
}

/** A binding that made it into the active map. */
export interface ActiveKeybinding extends KeybindingContribution {
  readonly chord: ParsedChord
}

/** A binding that did not, and why — surfaced so the author can see it. */
export interface RejectedKeybinding extends KeybindingContribution {
  readonly reason: string
}

/**
 * Parse `"ctrl+shift+l"` into modifiers and a key. Null if unparseable.
 *
 * `cmd`, `ctrl` and `mod` all fold to one `mod` flag, matching how the app's own
 * chords are matched (`metaKey || ctrlKey`) — an author on macOS writing `cmd`
 * and one on Linux writing `ctrl` should not produce a plugin that only works on
 * the machine it was written on.
 */
export const parseChord = (spec: string): ParsedChord | null => {
  const parts = spec
    .toLowerCase()
    .split("+")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)

  if (parts.length === 0) return null

  let mod = false
  let shift = false
  let alt = false
  let key: string | null = null

  for (const part of parts) {
    if (part === "cmd" || part === "ctrl" || part === "mod" || part === "meta") mod = true
    else if (part === "shift") shift = true
    else if (part === "alt" || part === "option") alt = true
    else if (key !== null) return null // two non-modifier keys is not a chord
    else key = part
  }

  if (!key) return null
  // A bare letter with no modifier would swallow ordinary typing.
  if (!mod && !alt) return null
  return { mod, shift, alt, key }
}

/** Does this keypress match that chord? */
export const chordMatches = (chord: ParsedChord, event: Chord): boolean => {
  if (chord.mod !== (event.metaKey || event.ctrlKey)) return false
  if (chord.shift !== event.shiftKey) return false
  if (chord.alt !== event.altKey) return false

  // `key` is compared case-insensitively AND against `code`, because Shift
  // changes `key` ("l" becomes "L", "=" becomes "+") while `code` stays put.
  // Matching only one of the two makes a shifted binding fire unpredictably.
  const pressed = event.key.toLowerCase()
  const code = event.code.toLowerCase()
  return pressed === chord.key || code === `key${chord.key}` || code === chord.key
}

/**
 * Resolve every requested binding against the chords already spoken for.
 *
 * `reserved` is the app's own set, in the same notation. Built-ins are not
 * enumerated here — passing them in keeps this module free of the split
 * shortcuts' specifics, and means the caller can decide what counts as taken.
 */
export const resolveKeybindings = (
  requested: ReadonlyArray<KeybindingContribution>,
  reserved: ReadonlyArray<string>
): { active: ReadonlyArray<ActiveKeybinding>; rejected: ReadonlyArray<RejectedKeybinding> } => {
  const active: ActiveKeybinding[] = []
  const rejected: RejectedKeybinding[] = []

  const taken = new Map<string, string>()
  for (const spec of reserved) {
    const parsed = parseChord(spec)
    if (parsed) taken.set(chordKey(parsed), "Jingler")
  }

  // Sorted so the winner between two plugins is stable across launches rather
  // than decided by whichever directory the filesystem listed first.
  const ordered = [...requested].toSorted(
    (a, b) => a.pluginId.localeCompare(b.pluginId) || a.commandId.localeCompare(b.commandId)
  )

  for (const binding of ordered) {
    const parsed = parseChord(binding.key)
    if (!parsed) {
      rejected.push({
        ...binding,
        reason: `"${binding.key}" is not a chord Jingler understands. Use a form like "ctrl+shift+l".`
      })
      continue
    }

    const owner = taken.get(chordKey(parsed))
    if (owner) {
      rejected.push({
        ...binding,
        reason: `"${binding.key}" is already used by ${owner}.`
      })
      continue
    }

    taken.set(chordKey(parsed), binding.pluginId)
    active.push({ ...binding, chord: parsed })
  }

  return { active, rejected }
}

/** A canonical string for a parsed chord, for collision lookups. */
const chordKey = (chord: ParsedChord): string =>
  `${chord.mod ? "mod+" : ""}${chord.shift ? "shift+" : ""}${chord.alt ? "alt+" : ""}${chord.key}`

/** The binding a keypress should run, if any. */
export const matchKeybinding = (
  bindings: ReadonlyArray<ActiveKeybinding>,
  event: Chord
): ActiveKeybinding | null =>
  bindings.find((binding) => chordMatches(binding.chord, event)) ?? null
