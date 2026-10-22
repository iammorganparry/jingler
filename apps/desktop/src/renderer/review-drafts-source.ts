import type { ReviewFindingDraft } from "@jingler/ui"

const E2E_KEY = "jingler:e2e-review-drafts"
const NONE: ReadonlyArray<ReviewFindingDraft> = []

/**
 * Draft findings for the Review drawer. The live read-only review agent is not wired yet,
 * so the only source is the scripted e2e agent (drafts seeded in localStorage).
 */
function readDrafts(): ReadonlyArray<ReviewFindingDraft> {
  if (!window.jingler.isE2E) return NONE
  const raw = localStorage.getItem(E2E_KEY)
  return raw ? (JSON.parse(raw) as ReadonlyArray<ReviewFindingDraft>) : NONE
}

export const reviewDraftsSource: ReadonlyArray<ReviewFindingDraft> = readDrafts()
