export const ADVERSARIAL_QUALITY_PROBES = [
  "invalid semantic rename leaves files unchanged",
  "shadowed identifiers are excluded from semantic references",
  "comments and strings are excluded from structural matches",
  "stale structural preview fails before writing",
  "read-only roles cannot see mutating tools",
  "missing scanners return actionable errors",
  "scanner output above one megabyte is rejected",
  "ambient Pi resources remain excluded",
  "plain text tasks skip code tools"
] as const
