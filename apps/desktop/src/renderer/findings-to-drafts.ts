import type { AdversarialReview } from "@jingler/core"
import type { ReviewFindingDraft } from "@jingler/ui"

/** Findings anchored to a line become drafts; critical/major are Issues, minor/nit are Nits. */
export function findingsToDrafts(review: Pick<AdversarialReview, "findings">): ReadonlyArray<ReviewFindingDraft> {
  return review.findings.flatMap((f) =>
    f.path === null || f.line === null
      ? []
      : [{
          id: f.id,
          severity: f.severity === "critical" || f.severity === "major" ? ("issue" as const) : ("nit" as const),
          path: f.path,
          line: f.line,
          body: f.suggestion === null ? `${f.title} ${f.rationale}` : `${f.title} ${f.rationale} Suggestion: ${f.suggestion}`
        }]
  )
}
