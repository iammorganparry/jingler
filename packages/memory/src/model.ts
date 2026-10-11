import { Schema } from "effect"

/** A stable identifier used by persisted memory records. */
export const MemoryId = Schema.String.pipe(Schema.minLength(1))
export type MemoryId = Schema.Schema.Type<typeof MemoryId>

/** Where evidence stored alongside a page was obtained. */
export const MemorySourceKind = Schema.Literal(
  "web",
  "url",
  "file",
  "conversation",
  "repository",
  "manual",
  "other"
)
export type MemorySourceKind = Schema.Schema.Type<typeof MemorySourceKind>

export const MemorySource = Schema.Struct({
  id: MemoryId,
  kind: MemorySourceKind,
  title: Schema.String,
  uri: Schema.optional(Schema.String),
  retrievedAt: Schema.optional(Schema.String),
  contentHash: Schema.optional(Schema.String)
})
export type MemorySource = Schema.Schema.Type<typeof MemorySource>

/** Why a compiler candidate is expected to remain useful beyond its source turn. */
export const MemoryDurabilityReason = Schema.Literal(
  "decision_with_reason",
  "stable_convention",
  "reusable_gotcha",
  "durable_relationship",
  "verified_finding"
)
export type MemoryDurabilityReason = Schema.Schema.Type<typeof MemoryDurabilityReason>

/**
 * Review sensitivity for a durable candidate. Personal data and credentials are
 * deliberately absent: the compiler must discard them before candidate output.
 */
export const MemorySensitivityClass = Schema.Literal(
  "standard",
  "preference",
  "people_process",
  "security_sensitive",
  "other_sensitive"
)
export type MemorySensitivityClass = Schema.Schema.Type<typeof MemorySensitivityClass>

/** Exact, bounded source evidence supporting one standalone durable claim. */
export const MemoryEvidenceSpan = Schema.Struct({
  sourceId: MemoryId,
  start: Schema.Int.pipe(Schema.greaterThanOrEqualTo(0)),
  end: Schema.Int.pipe(Schema.greaterThan(0)),
  quote: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(600))
}).pipe(Schema.filter((span) => span.end > span.start || "evidence end must be after start"))
export type MemoryEvidenceSpan = Schema.Schema.Type<typeof MemoryEvidenceSpan>

/** The accepted identity to update, or the deterministic identity for a new page. */
export const MemoryCompilerTargetIdentity = Schema.Union(
  Schema.Struct({
    action: Schema.Literal("update"),
    pageId: MemoryId,
    revisionId: MemoryId
  }),
  Schema.Struct({
    action: Schema.Literal("create"),
    pageId: MemoryId,
    path: Schema.String.pipe(Schema.minLength(1)),
    title: Schema.String.pipe(Schema.minLength(1))
  })
)
export type MemoryCompilerTargetIdentity = Schema.Schema.Type<typeof MemoryCompilerTargetIdentity>

/** Semantic page-to-page relationship kinds the compiler may suggest. */
export const MemoryDurableRelationshipKind = Schema.Literal("wikilink", "dependency")
export type MemoryDurableRelationshipKind = Schema.Schema.Type<typeof MemoryDurableRelationshipKind>

export const MemoryCompilerRelationshipSuggestion = Schema.Struct({
  kind: MemoryDurableRelationshipKind,
  target: MemoryId,
  label: Schema.optional(Schema.String)
})
export type MemoryCompilerRelationshipSuggestion = Schema.Schema.Type<
  typeof MemoryCompilerRelationshipSuggestion
>

/** One compiler output claim. Page Markdown is derived later by trusted code. */
export const MemoryCompilerCandidate = Schema.Struct({
  claim: Schema.String.pipe(Schema.minLength(12), Schema.maxLength(600)),
  evidence: MemoryEvidenceSpan,
  durabilityReason: MemoryDurabilityReason,
  sensitivity: MemorySensitivityClass,
  targetIdentity: MemoryCompilerTargetIdentity,
  relationshipSuggestions: Schema.Array(MemoryCompilerRelationshipSuggestion).pipe(Schema.maxItems(8))
})
export type MemoryCompilerCandidate = Schema.Schema.Type<typeof MemoryCompilerCandidate>

export const MemoryCompilerNoLearningReason = Schema.Literal(
  "no_bounded_claims",
  "all_filtered",
  "already_durable",
  "model_declined"
)
export type MemoryCompilerNoLearningReason = Schema.Schema.Type<typeof MemoryCompilerNoLearningReason>

/** Structured model result. An explicit empty result is valid and successful. */
export const MemoryCompilerCandidateResult = Schema.Union(
  Schema.Struct({
    status: Schema.Literal("candidates"),
    candidates: Schema.Array(MemoryCompilerCandidate).pipe(Schema.minItems(1), Schema.maxItems(3))
  }),
  Schema.Struct({
    status: Schema.Literal("no_durable_learning"),
    reason: MemoryCompilerNoLearningReason,
    candidates: Schema.Tuple()
  })
)
export type MemoryCompilerCandidateResult = Schema.Schema.Type<typeof MemoryCompilerCandidateResult>

export const MemoryRelationshipCandidateStatus = Schema.Literal(
  "open",
  "accepted",
  "rejected",
  "superseded"
)
export type MemoryRelationshipCandidateStatus = Schema.Schema.Type<
  typeof MemoryRelationshipCandidateStatus
>

/**
 * A typed semantic link awaiting review independently from the factual page
 * proposal that produced it. Compiler evidence remains provenance only; it is
 * not projected as a graph edge until review accepts a page-anchored span.
 */
export const MemoryRelationshipCandidate = Schema.Struct({
  id: MemoryId,
  kind: MemoryDurableRelationshipKind,
  sourcePageId: MemoryId,
  targetPageId: MemoryId,
  claim: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(600)),
  compilerEvidence: MemoryEvidenceSpan,
  proposedBy: MemoryId,
  createdAt: Schema.String.pipe(Schema.minLength(1)),
  status: MemoryRelationshipCandidateStatus,
  reviewedBy: Schema.optional(MemoryId),
  reviewedAt: Schema.optional(Schema.String.pipe(Schema.minLength(1)))
}).pipe(
  Schema.filter((candidate) =>
    candidate.sourcePageId === candidate.targetPageId
      ? "relationship endpoints must be different accepted pages"
      : candidate.status === "open" &&
          (candidate.reviewedBy !== undefined || candidate.reviewedAt !== undefined)
        ? "open relationship candidates cannot have review metadata"
        : candidate.status !== "open" &&
            (candidate.reviewedBy === undefined || candidate.reviewedAt === undefined)
          ? "settled relationship candidates require complete review metadata"
          : true
  )
)
export type MemoryRelationshipCandidate = Schema.Schema.Type<typeof MemoryRelationshipCandidate>

/**
 * Immutable evidence for one independently accepted semantic edge. The span is
 * measured against the accepted source revision body and remains joinable to
 * the compiler evidence that originally suggested the link.
 */
export const MemoryRelationshipEvidence = Schema.Struct({
  id: MemoryId,
  relationshipId: MemoryId,
  kind: MemoryDurableRelationshipKind,
  sourcePageId: MemoryId,
  targetPageId: MemoryId,
  sourceRevisionId: MemoryId,
  start: Schema.Int.pipe(Schema.greaterThanOrEqualTo(0)),
  end: Schema.Int.pipe(Schema.greaterThan(0)),
  quote: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(600)),
  compilerEvidence: MemoryEvidenceSpan,
  acceptedBy: MemoryId,
  acceptedAt: Schema.String.pipe(Schema.minLength(1))
}).pipe(
  Schema.filter((evidence) =>
    evidence.sourcePageId === evidence.targetPageId
      ? "relationship endpoints must be different accepted pages"
      : evidence.end <= evidence.start
        ? "relationship evidence end must be after start"
        : true
  )
)
export type MemoryRelationshipEvidence = Schema.Schema.Type<typeof MemoryRelationshipEvidence>

/** A page-local citation which points at a registered source. */
export const MemoryCitation = Schema.Struct({
  id: MemoryId,
  sourceId: MemoryId,
  locator: Schema.optional(Schema.String),
  quote: Schema.optional(Schema.String)
})
export type MemoryCitation = Schema.Schema.Type<typeof MemoryCitation>

/** Explicit non-citation relationships declared in page frontmatter. */
export const MemoryRelationshipKind = Schema.Literal("dependency", "schema")
export type MemoryRelationshipKind = Schema.Schema.Type<typeof MemoryRelationshipKind>

export const MemoryRelationship = Schema.Struct({
  kind: MemoryRelationshipKind,
  target: MemoryId,
  label: Schema.optional(Schema.String)
})
export type MemoryRelationship = Schema.Schema.Type<typeof MemoryRelationship>

export const MemoryRoleName = Schema.Literal("owner", "editor", "reviewer", "viewer", "agent")
export type MemoryRoleName = Schema.Schema.Type<typeof MemoryRoleName>

export const MemoryRole = Schema.Struct({
  principalId: MemoryId,
  role: MemoryRoleName,
  scope: Schema.Literal("workspace", "page"),
  pageId: Schema.optional(MemoryId),
  grantedAt: Schema.optional(Schema.String),
  grantedBy: Schema.optional(MemoryId)
}).pipe(
  Schema.filter((assignment) =>
    assignment.scope === "page" && assignment.pageId === undefined
      ? "a page-scoped role must name pageId"
      : assignment.scope === "workspace" && assignment.pageId !== undefined
        ? "a workspace-scoped role cannot name pageId"
        : true
  )
)
export type MemoryRole = Schema.Schema.Type<typeof MemoryRole>

export const MemoryRevisionNumber = Schema.Int.pipe(Schema.greaterThanOrEqualTo(1))
export type MemoryRevisionNumber = Schema.Schema.Type<typeof MemoryRevisionNumber>

/** The canonical, parsed representation of one Markdown memory page. */
export const MemoryPage = Schema.Struct({
  id: MemoryId,
  path: Schema.String,
  title: Schema.String,
  revision: MemoryRevisionNumber,
  aliases: Schema.Array(Schema.String),
  tags: Schema.Array(Schema.String),
  sources: Schema.Array(MemorySource),
  citations: Schema.Array(MemoryCitation),
  relationships: Schema.Array(MemoryRelationship),
  body: Schema.String,
  /** Unrecognised frontmatter is retained here so parsing is lossless. */
  metadata: Schema.Record({ key: Schema.String, value: Schema.Unknown })
})
export type MemoryPage = Schema.Schema.Type<typeof MemoryPage>

export const MemoryRevision = Schema.Struct({
  id: MemoryId,
  pageId: MemoryId,
  revision: MemoryRevisionNumber,
  parentRevisionId: Schema.optional(MemoryId),
  contentHash: Schema.String,
  markdown: Schema.String,
  authorId: MemoryId,
  createdAt: Schema.String,
  message: Schema.optional(Schema.String)
})
export type MemoryRevision = Schema.Schema.Type<typeof MemoryRevision>

export const MemoryProposalStatus = Schema.Literal("open", "accepted", "rejected", "superseded")
export type MemoryProposalStatus = Schema.Schema.Type<typeof MemoryProposalStatus>

export const MemoryProposal = Schema.Struct({
  id: MemoryId,
  pageId: MemoryId,
  baseRevisionId: MemoryId,
  path: Schema.optional(Schema.String),
  markdown: Schema.String,
  proposedBy: MemoryId,
  createdAt: Schema.String,
  status: MemoryProposalStatus,
  summary: Schema.optional(Schema.String)
})
export type MemoryProposal = Schema.Schema.Type<typeof MemoryProposal>

export const MemoryAuditEventType = Schema.Literal(
  "page.created",
  "revision.created",
  "proposal.created",
  "proposal.accepted",
  "proposal.rejected",
  "relationship.proposed",
  "relationship.accepted",
  "relationship.rejected",
  "role.granted",
  "role.revoked",
  "export.created"
)
export type MemoryAuditEventType = Schema.Schema.Type<typeof MemoryAuditEventType>

export const MemoryAuditEvent = Schema.Struct({
  id: MemoryId,
  type: MemoryAuditEventType,
  actorId: MemoryId,
  occurredAt: Schema.String,
  pageId: Schema.optional(MemoryId),
  revisionId: Schema.optional(MemoryId),
  proposalId: Schema.optional(MemoryId),
  details: Schema.Record({ key: Schema.String, value: Schema.String })
})
export type MemoryAuditEvent = Schema.Schema.Type<typeof MemoryAuditEvent>

export const MemoryRepository = Schema.Struct({
  pages: Schema.Array(MemoryPage),
  sources: Schema.Array(MemorySource),
  revisions: Schema.Array(MemoryRevision),
  proposals: Schema.Array(MemoryProposal),
  roles: Schema.Array(MemoryRole),
  auditEvents: Schema.Array(MemoryAuditEvent)
})
export type MemoryRepository = Schema.Schema.Type<typeof MemoryRepository>
