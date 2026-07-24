const VIEWED_PREFIX = "sb.review.viewed."

const legacyViewedStorageKey = (sessionId: string): string =>
  `${VIEWED_PREFIX}${sessionId}`

export const viewedStorageKey = (
  sessionId: string,
  prNumber: number | null
): string => `${VIEWED_PREFIX}${sessionId}.${prNumber ?? "none"}`

const parseViewed = (raw: string): ReadonlySet<string> => {
  try {
    const parsed = JSON.parse(raw) as unknown
    return new Set(
      Array.isArray(parsed)
        ? parsed.filter((value): value is string => typeof value === "string")
        : []
    )
  } catch {
    return new Set()
  }
}

/**
 * Read PR-scoped viewed markers, migrating the old session-only key once.
 *
 * The legacy key is removed only after the scoped write succeeds. If storage is
 * unavailable or full, the old value remains available for a later retry.
 */
export const readViewedPaths = (
  sessionId: string,
  prNumber: number | null
): ReadonlySet<string> => {
  try {
    const scopedKey = viewedStorageKey(sessionId, prNumber)
    const legacyKey = legacyViewedStorageKey(sessionId)
    const scoped = localStorage.getItem(scopedKey)
    if (scoped !== null) {
      // A scoped value proves migration is no longer needed. Drop any leftover
      // legacy copy so it cannot seed a later replacement PR.
      localStorage.removeItem(legacyKey)
      return parseViewed(scoped)
    }

    const legacy = localStorage.getItem(legacyKey)
    if (legacy === null) return new Set()

    const viewed = parseViewed(legacy)
    localStorage.setItem(scopedKey, JSON.stringify([...viewed]))
    localStorage.removeItem(legacyKey)
    return viewed
  } catch {
    return new Set()
  }
}

/** Remove legacy and PR-scoped viewed markers owned by a deleted session. */
export const clearViewedPaths = (sessionId: string): void => {
  try {
    const legacyKey = legacyViewedStorageKey(sessionId)
    const scopedPrefix = `${legacyKey}.`
    const keys = Array.from(
      { length: localStorage.length },
      (_, index) => localStorage.key(index)
    ).filter(
      (key): key is string =>
        key !== null && (key === legacyKey || key.startsWith(scopedPrefix))
    )
    for (const key of keys) localStorage.removeItem(key)
  } catch {
    // Storage is unavailable; there is no persisted state to clean up.
  }
}
