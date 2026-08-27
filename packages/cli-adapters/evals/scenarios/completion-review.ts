import { completionReviewGate, requiresCompletionReview, type ReviewFinding } from "@jingler/core"

export const COMPLETION_REVIEW_CASES = {
  trivialSkip: requiresCompletionReview({ changedFiles: ["src/a.ts"], verificationRetries: 0 }),
  multiFileReview: requiresCompletionReview({ changedFiles: ["src/a.ts", "src/b.ts"], verificationRetries: 0 }),
  majorBlocks: completionReviewGate([{
    id: "major-1",
    path: "src/a.ts",
    line: 1,
    endLine: null,
    severity: "major",
    title: "Wrong return path",
    rationale: "The function returns stale data.",
    suggestion: null,
    resolvedBy: null
  } satisfies ReviewFinding]).blocked
} as const
