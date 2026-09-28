/**
 * Release notes for the "Updated to vX" card, read from the CHANGELOG that
 * Changesets writes on every release (`pnpm version-packages`). The file is
 * bundled at build time, so the notes always match the version that shipped.
 */

export interface ChangelogEntry {
  readonly version: string
  /** One-line changes in CHANGELOG order, commit prefixes stripped. */
  readonly notes: readonly string[]
}

const VERSION_HEADING = /^## (\d+\.\d+\.\d+)\s*$/
const BULLET = /^- (.+)$/
/** Changesets prefixes each entry with the commit that added it: `- c2a2490: …`. */
const COMMIT_PREFIX = /^[0-9a-f]{7,40}: /

/** Parse a Changesets CHANGELOG into its version sections, newest first. */
export const parseChangelog = (markdown: string): ChangelogEntry[] => {
  const entries: { version: string; notes: string[] }[] = []
  for (const line of markdown.split("\n")) {
    const heading = VERSION_HEADING.exec(line)
    if (heading) {
      entries.push({ version: heading[1]!, notes: [] })
      continue
    }
    const bullet = BULLET.exec(line)
    const current = entries.at(-1)
    if (bullet && current) current.notes.push(bullet[1]!.replace(COMMIT_PREFIX, "").trim())
  }
  return entries
}

/** Compare dotted numeric versions; negative when `a` is older than `b`. */
export const compareVersions = (a: string, b: string): number => {
  const left = a.split(".").map(Number)
  const right = b.split(".").map(Number)
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/**
 * Every change shipped after `previous` up to and including `current` — an
 * update can skip versions, and the operator should hear about all of them.
 */
export const notesBetween = (
  entries: readonly ChangelogEntry[],
  previous: string,
  current: string
): string[] =>
  entries
    .filter(
      (entry) =>
        compareVersions(entry.version, previous) > 0 &&
        compareVersions(entry.version, current) <= 0
    )
    .flatMap((entry) => entry.notes)
