import type { PlanDocument } from "@jingler/core"
import { useEffect, useState } from "react"

export const REVISING_REASON = "Agent is revising this plan"
export const STALE_REASON = "Reload the latest plan before approving"

/**
 * A new submission (a different `reviewId`) replaced a review the reviewer had open. Progress ticks, the
 * revising gap (no review id) and a first submission (nothing opened yet) never raise the banner.
 */
export const isPlanStale = (opened: PlanDocument, latest: PlanDocument): boolean =>
  opened.reviewId !== undefined && latest.reviewId !== undefined && latest.reviewId !== opened.reviewId

export const approvalBlockedReason = (latest: PlanDocument, stale: boolean): string | undefined =>
  latest.status === "revising" ? REVISING_REASON : stale ? STALE_REASON : undefined

/**
 * Pins the plan the reviewer opened once a newer submission arrives from somewhere else (e.g. main-chat
 * feedback); `reload` adopts the latest. A replacement that follows the reviewer's own decision is adopted
 * silently. `markDecided` records that decision.
 */
export function usePlanVersion(latest: PlanDocument) {
  const [opened, setOpened] = useState(latest)
  const [decidedReviewId, setDecidedReviewId] = useState<string | undefined>()
  const stale = isPlanStale(opened, latest) && opened.reviewId !== decidedReviewId
  useEffect(() => {
    if (!stale && latest.reviewId !== undefined && latest.reviewId !== opened.reviewId) setOpened(latest)
  }, [stale, latest, opened.reviewId])
  return {
    document: stale ? opened : latest,
    stale,
    blockedReason: approvalBlockedReason(latest, stale),
    reload: () => setOpened(latest),
    markDecided: () => setDecidedReviewId(opened.reviewId)
  }
}
