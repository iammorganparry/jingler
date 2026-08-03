import type { MemoryPage } from "./model.js"

/**
 * Shared freshness thresholds (in days since last acceptance) for the dashboard and
 * the graph view. A page accepted within {@link FRESH_MAX_DAYS} is "fresh", within
 * {@link AGING_MAX_DAYS} is "aging", older is "stale". Exported so the dashboard's
 * freshness histogram and the graph node badge can never diverge on where the lines
 * fall.
 */
export const FRESH_MAX_DAYS = 30
export const AGING_MAX_DAYS = 90

/**
 * How many contradictions a page carries, tolerant of both shapes the metadata has
 * historically taken: an array of contradiction ids, or a bare positive count.
 * Anything else (absent, zero, non-numeric) is zero. Shared by the dashboard health
 * roll-up and the graph node health badge so a page's contradiction count is defined
 * exactly once.
 */
export const contradictionCount = (page: MemoryPage | undefined): number => {
  if (page === undefined) return 0
  const value = page.metadata.contradictions
  if (Array.isArray(value)) return value.length
  return typeof value === "number" && value > 0 ? Math.floor(value) : 0
}
