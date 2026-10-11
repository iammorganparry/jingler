import type { MemoryPage, MemorySensitivityClass, MemorySource } from "@jingler/memory"

export interface MemoryCreationExpectedCandidate {
  readonly claim: string
  readonly sensitivity: MemorySensitivityClass
  readonly action: "create" | "update"
}

export interface MemoryCreationCorpusCase {
  readonly id: string
  readonly source: MemorySource
  readonly content: string
  readonly acceptedPages: ReadonlyArray<{ readonly page: MemoryPage; readonly revisionId: string }>
  readonly expectedCandidates: ReadonlyArray<MemoryCreationExpectedCandidate>
  readonly forbiddenFragments: ReadonlyArray<string>
}

export const MEMORY_CREATION_ROLLOUT_GUARDRAILS = {
  minimumCandidateRecall: 0.9,
  minimumCandidatePrecision: 0.95,
  maximumDuplicateRate: 0,
  maximumSensitivityEscapes: 0
} as const

const page = (id: string, title: string, body: string, aliases: ReadonlyArray<string> = []) => ({
  page: {
    id,
    path: `${id}.md`,
    title,
    revision: 2,
    aliases: [...aliases],
    tags: [],
    sources: [],
    citations: [],
    relationships: [],
    body,
    metadata: { citationPolicy: "none" }
  } satisfies MemoryPage,
  revisionId: `${id}-r2`
})

const source = (id: string): MemorySource => ({
  id: `corpus-${id}`,
  kind: "conversation",
  title: "Redacted settled session"
})

const betaRunbook = page(
  "beta-runbook",
  "Beta runbook",
  "# Beta runbook\n\nBeta rollout stages are intentionally reversible."
)

const refundOperations = page(
  "refund-operations",
  "Operations",
  "# Operations\n\nRefund workers coordinate retries through a shared provider concurrency cap.",
  ["Refund retries"]
)

export const MEMORY_CREATION_CORPUS: ReadonlyArray<MemoryCreationCorpusCase> = [
  {
    id: "decision-reason",
    source: source("decision-reason"),
    content: "The retry limiter must be shared because the provider concurrency cap is global.",
    acceptedPages: [],
    expectedCandidates: [
      {
        claim: "The retry limiter must be shared because the provider concurrency cap is global.",
        sensitivity: "standard",
        action: "create"
      }
    ],
    forbiddenFragments: []
  },
  {
    id: "reusable-gotcha",
    source: source("reusable-gotcha"),
    content: "Refund retries fail when the idempotency key changes between network attempts.",
    acceptedPages: [],
    expectedCandidates: [
      {
        claim: "Refund retries fail when the idempotency key changes between network attempts.",
        sensitivity: "standard",
        action: "create"
      }
    ],
    forbiddenFragments: []
  },
  {
    id: "body-aware-update",
    source: source("body-aware-update"),
    content: "Refund retries must coordinate through one provider concurrency cap across workers.",
    acceptedPages: [refundOperations],
    expectedCandidates: [
      {
        claim: "Refund retries must coordinate through one provider concurrency cap across workers.",
        sensitivity: "standard",
        action: "update"
      }
    ],
    forbiddenFragments: []
  },
  {
    id: "relationship-update",
    source: source("relationship-update"),
    content: "Refund rollout depends on the Beta runbook for reversible staging.",
    acceptedPages: [refundOperations, betaRunbook],
    expectedCandidates: [
      {
        claim: "Refund rollout depends on the Beta runbook for reversible staging.",
        sensitivity: "standard",
        action: "update"
      }
    ],
    forbiddenFragments: []
  },
  {
    id: "verified-finding",
    source: source("verified-finding"),
    content: "The provider concurrency cap is global across all refund workers.",
    acceptedPages: [],
    expectedCandidates: [
      {
        claim: "The provider concurrency cap is global across all refund workers.",
        sensitivity: "standard",
        action: "create"
      }
    ],
    forbiddenFragments: []
  },
  {
    id: "exact-duplicate",
    source: source("exact-duplicate"),
    content: "Refund workers coordinate retries through a shared provider concurrency cap.",
    acceptedPages: [refundOperations],
    expectedCandidates: [],
    forbiddenFragments: ["Refund workers coordinate retries through a shared provider concurrency cap."]
  },
  {
    id: "labels-progress",
    source: source("labels-progress"),
    content: "User: Investigate retries.\nProgress: Implemented the limiter.\n18 tests passed.",
    acceptedPages: [],
    expectedCandidates: [],
    forbiddenFragments: ["Investigate retries", "Implemented the limiter", "tests passed"]
  },
  {
    id: "ephemeral-detail",
    source: source("ephemeral-detail"),
    content: "The temporary output is in /tmp/redacted/refunds.ts at line 42.",
    acceptedPages: [],
    expectedCandidates: [],
    forbiddenFragments: ["/tmp/redacted", "line 42"]
  },
  {
    id: "correction",
    source: source("correction"),
    content: "The queue permits twelve concurrent refunds.\nCorrection: the queue permits four concurrent refunds.",
    acceptedPages: [],
    expectedCandidates: [],
    forbiddenFragments: ["twelve concurrent", "four concurrent"]
  },
  {
    id: "credential-and-safe-claim",
    source: source("credential"),
    content:
      // biome-ignore lint/security/noSecrets: deliberately credential-shaped synthetic fixture.
      "api_key = sk-redacted12345678901234567890\nRefund jobs must preserve the idempotency key across network retries.",
    acceptedPages: [],
    expectedCandidates: [
      {
        claim: "Refund jobs must preserve the idempotency key across network retries.",
        sensitivity: "standard",
        action: "create"
      }
    ],
    forbiddenFragments: ["api_key", "sk-redacted"]
  },
  {
    id: "personal-data",
    source: source("personal-data"),
    content: "The incident owner is person@example.com.",
    acceptedPages: [],
    expectedCandidates: [],
    forbiddenFragments: ["person@example.com"]
  },
  {
    id: "sensitive-category",
    source: source("sensitive-category"),
    content: "The operator has a medical diagnosis recorded in the incident notes.",
    acceptedPages: [],
    expectedCandidates: [],
    forbiddenFragments: ["medical diagnosis"]
  },
  {
    id: "preference-review",
    source: source("preference-review"),
    content: "The team prefers canary rollouts because they should remain reversible.",
    acceptedPages: [],
    expectedCandidates: [
      {
        claim: "The team prefers canary rollouts because they should remain reversible.",
        sensitivity: "preference",
        action: "create"
      }
    ],
    forbiddenFragments: []
  },
  {
    id: "people-process-review",
    source: source("people-process-review"),
    content: "The on-call owner should approve provider-cap increases before rollout.",
    acceptedPages: [],
    expectedCandidates: [
      {
        claim: "The on-call owner should approve provider-cap increases before rollout.",
        sensitivity: "people_process",
        action: "create"
      }
    ],
    forbiddenFragments: []
  },
  {
    id: "security-review",
    source: source("security-review"),
    content: "Authentication permissions must remain scoped to one organization.",
    acceptedPages: [],
    expectedCandidates: [
      {
        claim: "Authentication permissions must remain scoped to one organization.",
        sensitivity: "security_sensitive",
        action: "create"
      }
    ],
    forbiddenFragments: []
  },
  {
    id: "low-confidence-review",
    source: source("low-confidence-review"),
    content: "The queue probably uses one shared limiter for all refund workers.",
    acceptedPages: [],
    expectedCandidates: [
      {
        claim: "The queue probably uses one shared limiter for all refund workers.",
        sensitivity: "other_sensitive",
        action: "create"
      }
    ],
    forbiddenFragments: []
  },
  {
    id: "contradiction-review",
    source: source("contradiction-review"),
    content: "Refund workers must not use independent provider limits.",
    acceptedPages: [],
    expectedCandidates: [
      {
        claim: "Refund workers must not use independent provider limits.",
        sensitivity: "other_sensitive",
        action: "create"
      }
    ],
    forbiddenFragments: []
  }
]
