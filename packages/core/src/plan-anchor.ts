import type { PlanAnnotationAnchor } from "./plan-document.js"

/**
 * Resolve a TextQuote anchor against a body of text, returning the character
 * range `[start, end)` the comment should highlight — or `null` when the quoted
 * text can no longer be found (an "orphaned" comment).
 *
 * ## Why quote + context, not offsets
 *
 * Plan comments live inside the MDX source and survive edits and markdown
 * round-trips, so a stored numeric offset would drift the moment anything above
 * it changes. A quoted span with a little surrounding context re-anchors
 * robustly: we prefer the occurrence bracketed by the recorded prefix/suffix,
 * fall back to the nearest bare occurrence, and give up (orphan) only when the
 * quote is gone entirely. Giving up is deliberate — silently snapping a comment
 * to an unrelated identical word would be worse than flagging it detached.
 */
export interface AnchorRange {
  readonly start: number
  readonly end: number
}

const indexOfWithContext = (
  text: string,
  anchor: PlanAnnotationAnchor
): number => {
  // Prefer the occurrence whose neighbours match the recorded context. This is
  // what disambiguates repeated quotes (e.g. the second "the API" of three).
  if (anchor.prefix.length > 0 || anchor.suffix.length > 0) {
    let from = 0
    while (from <= text.length) {
      const at = text.indexOf(anchor.quote, from)
      if (at === -1) break
      const before = text.slice(Math.max(0, at - anchor.prefix.length), at)
      const after = text.slice(at + anchor.quote.length, at + anchor.quote.length + anchor.suffix.length)
      const prefixOk = anchor.prefix.length === 0 || before.endsWith(anchor.prefix)
      const suffixOk = anchor.suffix.length === 0 || after.startsWith(anchor.suffix)
      if (prefixOk && suffixOk) return at
      from = at + 1
    }
  }
  // Fall back to the first bare occurrence of the quote.
  return text.indexOf(anchor.quote)
}

export const resolvePlanAnchor = (
  text: string,
  anchor: PlanAnnotationAnchor
): AnchorRange | null => {
  if (anchor.quote.length === 0) return null
  const start = indexOfWithContext(text, anchor)
  if (start === -1) return null
  return { start, end: start + anchor.quote.length }
}

/** True when the anchor's quoted text no longer exists in `text`. */
export const isOrphanedAnchor = (text: string, anchor: PlanAnnotationAnchor): boolean =>
  resolvePlanAnchor(text, anchor) === null

const CONTEXT = 32

/**
 * Build a TextQuote anchor from a selection: the selected `quote` plus up to
 * `CONTEXT` characters of surrounding text. Kept small so the anchor survives
 * light edits nearby while still disambiguating repeated quotes.
 */
export const buildPlanAnchor = (
  text: string,
  start: number,
  end: number
): PlanAnnotationAnchor => ({
  quote: text.slice(start, end),
  prefix: text.slice(Math.max(0, start - CONTEXT), start),
  suffix: text.slice(end, Math.min(text.length, end + CONTEXT))
})
