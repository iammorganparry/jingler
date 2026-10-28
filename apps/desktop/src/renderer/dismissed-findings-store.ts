import type { ReviewFinding } from "@jingler/core"

const DISMISSED_PREFIX = "sb.review.dismissed."

export const dismissedStorageKey = (sessionId: string, prNumber: number | null): string =>
  `${DISMISSED_PREFIX}${sessionId}.${prNumber ?? "none"}`

/**
 * What identifies a finding across review runs.
 *
 * Finding ids are positional (`f1`, `f2`, …) and only unique within one review, so
 * a re-run can hand `f1` to a different problem. The fingerprint is the finding's
 * own content instead: a re-run that raises the same problem on the same lines
 * stays dismissed, while a materially different finding (other title, severity or
 * location) shows again.
 */
export const findingFingerprint = (finding: ReviewFinding): string =>
  [finding.path ?? "", finding.line ?? "", finding.endLine ?? "", finding.severity, finding.title].join("\0")

/** Read dismissed fingerprints; missing, corrupt or unavailable storage reads as none. */
export const readDismissedFindings = (
  sessionId: string,
  prNumber: number | null
): ReadonlySet<string> => {
  try {
    const raw = localStorage.getItem(dismissedStorageKey(sessionId, prNumber))
    if (raw === null) return new Set()
    const parsed = JSON.parse(raw) as unknown
    return new Set(
      Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : []
    )
  } catch {
    return new Set()
  }
}

export const writeDismissedFindings = (
  sessionId: string,
  prNumber: number | null,
  dismissed: ReadonlySet<string>
): void => {
  try {
    localStorage.setItem(dismissedStorageKey(sessionId, prNumber), JSON.stringify([...dismissed]))
  } catch {
    /* storage unavailable: the dismissal still holds for this run */
  }
}

/** Remove every PR-scoped dismissal owned by a deleted session. */
export const clearDismissedFindings = (sessionId: string): void => {
  try {
    const prefix = `${DISMISSED_PREFIX}${sessionId}.`
    const keys = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)).filter(
      (key): key is string => key !== null && key.startsWith(prefix)
    )
    for (const key of keys) localStorage.removeItem(key)
  } catch {
    /* storage unavailable: nothing persisted to clean up */
  }
}
