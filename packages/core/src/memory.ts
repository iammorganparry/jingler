import { Schema } from "effect";

/** The only MCP revision exposed by the stateless team-memory endpoint. */
export const MEMORY_MCP_PROTOCOL_VERSION = "2026-07-28";

/** Stable identity stamped on discovery and every successful MCP result. */
export const MEMORY_MCP_SERVER_INFO = {
  name: "jingler-team-memory",
  title: "Jingler Team Memory",
  version: "1.0.0",
};

export const MemoryPrivilege = Schema.Literal(
  "read",
  "propose",
  "review",
  "schema",
);
export type MemoryPrivilege = Schema.Schema.Type<typeof MemoryPrivilege>;

export const MemoryOrganizationRole = Schema.Literal(
  "member",
  "admin",
  "owner",
);
export type MemoryOrganizationRole = Schema.Schema.Type<
  typeof MemoryOrganizationRole
>;

/**
 * The authorization ladder is deliberately monotonic. Members can retrieve and
 * propose, admins can additionally review, and only owners can change schemas.
 */
export const memoryPrivilegesForRole = (
  role: MemoryOrganizationRole,
): ReadonlyArray<MemoryPrivilege> => {
  switch (role) {
    case "member":
      return ["read", "propose"];
    case "admin":
      return ["read", "propose", "review"];
    case "owner":
      return ["read", "propose", "review", "schema"];
  }
};

/** Short-lived, audience-bound claims issued by the Next.js grant route. */
export const MemoryGrantClaims = Schema.Struct({
  version: Schema.Literal(1),
  issuer: Schema.Literal("jingler"),
  audience: Schema.String,
  subject: Schema.String,
  organizationId: Schema.String,
  privileges: Schema.Array(MemoryPrivilege),
  issuedAt: Schema.Int,
  expiresAt: Schema.Int,
  grantId: Schema.String,
});
export type MemoryGrantClaims = Schema.Schema.Type<typeof MemoryGrantClaims>;

export const MemoryRolloutHarness = Schema.Literal(
  "claude",
  "codex",
  "opencode",
  "cursor",
  "unknown",
);
export type MemoryRolloutHarness = Schema.Schema.Type<
  typeof MemoryRolloutHarness
>;

export const MemorySessionLengthCohort = Schema.Literal(
  "short",
  "long",
  "unknown",
);
export type MemorySessionLengthCohort = Schema.Schema.Type<
  typeof MemorySessionLengthCohort
>;

export const MemoryRolloutArm = Schema.Literal(
  "control",
  "reflection",
  "extraction_shadow",
  "extraction_review",
  "auto_publication",
  "relationship_review",
);
export type MemoryRolloutArm = Schema.Schema.Type<typeof MemoryRolloutArm>;

export const MemorySourcePublicationMode = Schema.Literal(
  "disabled",
  "review",
  "auto",
);
export type MemorySourcePublicationMode = Schema.Schema.Type<
  typeof MemorySourcePublicationMode
>;

export const MemorySourcePublicationPolicy = Schema.Struct({
  web: MemorySourcePublicationMode,
  url: MemorySourcePublicationMode,
  file: MemorySourcePublicationMode,
  conversation: MemorySourcePublicationMode,
  repository: MemorySourcePublicationMode,
  manual: MemorySourcePublicationMode,
  other: MemorySourcePublicationMode,
});
export type MemorySourcePublicationPolicy = Schema.Schema.Type<
  typeof MemorySourcePublicationPolicy
>;

/**
 * Runtime rollout policy delivered with a grant. Percentages are basis points so
 * allocations are exact, stable, and independent of floating-point rounding.
 * Setting any arm to zero is a reversible circuit-breaker and never rewrites data.
 */
export const MemoryRolloutPolicy = Schema.Struct({
  version: Schema.Literal(1),
  revision: Schema.String.pipe(Schema.minLength(1)),
  allocationSalt: Schema.String.pipe(Schema.minLength(1)),
  reflectionBasisPoints: Schema.Int.pipe(Schema.between(0, 10_000)),
  extractionBasisPoints: Schema.Int.pipe(Schema.between(0, 10_000)),
  extractionMode: Schema.Literal("shadow", "review"),
  autoPublicationBasisPoints: Schema.Int.pipe(Schema.between(0, 10_000)),
  relationshipBasisPoints: Schema.Int.pipe(Schema.between(0, 10_000)),
  sourcePublication: MemorySourcePublicationPolicy,
});
export type MemoryRolloutPolicy = Schema.Schema.Type<
  typeof MemoryRolloutPolicy
>;

export const MEMORY_ROLLOUT_POLICY_DEFAULT: MemoryRolloutPolicy = {
  version: 1,
  revision: "baseline-review",
  allocationSalt: "jingler-memory-rollout-v1",
  reflectionBasisPoints: 0,
  extractionBasisPoints: 10_000,
  extractionMode: "review",
  autoPublicationBasisPoints: 0,
  relationshipBasisPoints: 0,
  sourcePublication: {
    web: "review",
    url: "review",
    file: "review",
    conversation: "review",
    repository: "review",
    manual: "auto",
    other: "review",
  },
};

export const MemoryRolloutAssignment = Schema.Struct({
  version: Schema.Literal(1),
  policyRevision: Schema.String.pipe(Schema.minLength(1)),
  allocationId: Schema.String.pipe(Schema.minLength(1)),
  harness: MemoryRolloutHarness,
  sessionLengthCohort: MemorySessionLengthCohort,
  arms: Schema.Array(MemoryRolloutArm),
});
export type MemoryRolloutAssignment = Schema.Schema.Type<
  typeof MemoryRolloutAssignment
>;

const FNV_64_OFFSET = 0xcbf29ce484222325n;
const FNV_64_PRIME = 0x100000001b3n;
const FNV_64_MASK = 0xffffffffffffffffn;

/** Stable, non-cryptographic allocation hash. It is an analytics join key, never authentication. */
export const memoryRolloutHash = (value: string): string => {
  let hash = FNV_64_OFFSET;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= BigInt(byte);
    hash = (hash * FNV_64_PRIME) & FNV_64_MASK;
  }
  return hash.toString(16).padStart(16, "0");
};

const rolloutBucket = (
  policy: MemoryRolloutPolicy,
  allocationId: string,
  arm: string,
): number =>
  Number.parseInt(
    memoryRolloutHash(
      `${policy.allocationSalt}\u0000${allocationId}\u0000${arm}`,
    ).slice(-4),
    16,
  ) % 10_000;

export const memoryRolloutArms = (
  policy: MemoryRolloutPolicy,
  allocationId: string,
): ReadonlyArray<MemoryRolloutArm> => {
  const arms: Array<MemoryRolloutArm> = [];
  if (
    rolloutBucket(policy, allocationId, "reflection") <
    policy.reflectionBasisPoints
  ) {
    arms.push("reflection");
  }
  if (
    rolloutBucket(policy, allocationId, "extraction") <
    policy.extractionBasisPoints
  ) {
    arms.push(
      policy.extractionMode === "shadow"
        ? "extraction_shadow"
        : "extraction_review",
    );
  }
  if (
    rolloutBucket(policy, allocationId, "publication") <
    policy.autoPublicationBasisPoints
  ) {
    arms.push("auto_publication");
  }
  if (
    rolloutBucket(policy, allocationId, "relationships") <
    policy.relationshipBasisPoints
  ) {
    arms.push("relationship_review");
  }
  return arms.length === 0 ? ["control"] : arms;
};

/** Allocate once per organization/session boundary; all turns reuse the same allocation id. */
export const allocateMemoryRollout = (input: {
  readonly organizationId: string;
  readonly sessionId: string;
  readonly harness?: MemoryRolloutHarness;
  readonly sessionLengthCohort?: MemorySessionLengthCohort;
  readonly policy?: MemoryRolloutPolicy;
}): MemoryRolloutAssignment => {
  const policy = input.policy ?? MEMORY_ROLLOUT_POLICY_DEFAULT;
  const allocationId = memoryRolloutHash(
    `${policy.allocationSalt}\u0000${input.organizationId}\u0000${input.sessionId}`,
  );
  return {
    version: 1,
    policyRevision: policy.revision,
    allocationId,
    harness: input.harness ?? "unknown",
    sessionLengthCohort: input.sessionLengthCohort ?? "unknown",
    arms: [...memoryRolloutArms(policy, allocationId)],
  };
};

export const MemoryGrantResponse = Schema.Struct({
  grant: Schema.String,
  claims: MemoryGrantClaims,
  rolloutPolicy: Schema.optional(MemoryRolloutPolicy),
});
export type MemoryGrantResponse = Schema.Schema.Type<
  typeof MemoryGrantResponse
>;

/** Shared wire contract for publishing one accepted Markdown revision. */
export const MemoryAcceptedPageRequest = Schema.Struct({
  revisionId: Schema.String.pipe(Schema.minLength(1)),
  markdown: Schema.String.pipe(Schema.minLength(1)),
  actorId: Schema.String.pipe(Schema.minLength(1)),
  createdAt: Schema.String.pipe(Schema.minLength(1)),
});
export type MemoryAcceptedPageRequest = Schema.Schema.Type<
  typeof MemoryAcceptedPageRequest
>;

export const McpClientInfo = Schema.Struct({
  name: Schema.String,
  version: Schema.String,
});
export type McpClientInfo = Schema.Schema.Type<typeof McpClientInfo>;

/** Required request-local metadata replacing MCP's former initialize session. */
export const MemoryMcpRequestMetadata = Schema.Struct({
  "io.modelcontextprotocol/protocolVersion": Schema.Literal(
    MEMORY_MCP_PROTOCOL_VERSION,
  ),
  "io.modelcontextprotocol/clientInfo": McpClientInfo,
  "io.modelcontextprotocol/clientCapabilities": Schema.Record({
    key: Schema.String,
    value: Schema.Unknown,
  }),
});
export type MemoryMcpRequestMetadata = Schema.Schema.Type<
  typeof MemoryMcpRequestMetadata
>;

export const MemoryMcpRequest = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  id: Schema.Union(Schema.String, Schema.Number),
  method: Schema.String,
  params: Schema.Struct({
    _meta: MemoryMcpRequestMetadata,
  }).pipe(
    Schema.extend(
      Schema.Record({
        key: Schema.String,
        value: Schema.Unknown,
      }),
    ),
  ),
});
export type MemoryMcpRequest = Schema.Schema.Type<typeof MemoryMcpRequest>;

export const MemoryMcpServerInfo = Schema.Struct({
  name: Schema.String,
  title: Schema.optional(Schema.String),
  version: Schema.String,
});
export type MemoryMcpServerInfo = Schema.Schema.Type<
  typeof MemoryMcpServerInfo
>;

/** Stateless MCP response proving that a request completed successfully. */
export const MemoryMcpCompleteResponse = Schema.Struct({
  result: Schema.Struct({
    resultType: Schema.Literal("complete"),
  }),
});
export type MemoryMcpCompleteResponse = Schema.Schema.Type<
  typeof MemoryMcpCompleteResponse
>;

/** Successful tool response shape; tool data remains intentionally polymorphic. */
export const MemoryMcpToolResponse = Schema.Struct({
  result: Schema.Struct({
    resultType: Schema.Literal("complete"),
    structuredContent: Schema.Struct({ data: Schema.Unknown }),
  }),
});
export type MemoryMcpToolResponse = Schema.Schema.Type<
  typeof MemoryMcpToolResponse
>;

/** Aggregate-only agent retrieval activity; no query, result, timing, or credential data. */
export const MemoryRetrievalSummary = Schema.Struct({
  searches: Schema.Int.pipe(Schema.between(0, 1_000_000)),
  reads: Schema.Int.pipe(Schema.between(0, 1_000_000)),
  navigation: Schema.Int.pipe(Schema.between(0, 1_000_000)),
  graphReads: Schema.Int.pipe(Schema.between(0, 1_000_000)),
  proposals: Schema.Int.pipe(Schema.between(0, 1_000_000)),
});
export type MemoryRetrievalSummary = Schema.Schema.Type<
  typeof MemoryRetrievalSummary
>;

/** Safe, content-free compiler validation categories exposed across service boundaries. */
export const MemoryCompilerPermanentFailureCode = Schema.Literal(
  "invalid_workflow_input",
  "source_identity_mismatch",
  "source_content_bounds",
  "credential_shaped_content",
  "invalid_proposal",
  "lint_validation",
);
export type MemoryCompilerPermanentFailureCode = Schema.Schema.Type<
  typeof MemoryCompilerPermanentFailureCode
>;

const MemoryCompilerProposalResultFields = {
  workflowId: Schema.String,
  proposalId: Schema.String,
  proposalIds: Schema.Array(Schema.String),
};

/** Typed compiler output. Validation failures are successful workflow outputs, not platform errors. */
export const MemoryCompilerWorkflowResult = Schema.Union(
  Schema.Struct({
    ...MemoryCompilerProposalResultFields,
    status: Schema.Literal(
      "pending_review",
      "published",
      "conflict",
      "rejected",
    ),
  }),
  Schema.Struct({
    workflowId: Schema.String,
    sourceId: Schema.String,
    status: Schema.Literal("no_durable_learning"),
    reason: Schema.Literal(
      "no_bounded_claims",
      "already_durable",
      "no_page_edits",
    ),
  }),
  Schema.Struct({
    workflowId: Schema.String,
    sourceId: Schema.String,
    status: Schema.Literal("extraction_shadowed"),
    candidateCount: Schema.Int.pipe(Schema.nonNegative()),
  }),
  Schema.Struct({
    workflowId: Schema.String,
    sourceId: Schema.String,
    status: Schema.Literal("permanent_failure"),
    code: MemoryCompilerPermanentFailureCode,
    issueCodes: Schema.Array(Schema.String),
  }),
);
export type MemoryCompilerWorkflowResult = Schema.Schema.Type<
  typeof MemoryCompilerWorkflowResult
>;

export const MemoryWorkflowPlatformResult = Schema.Struct({
  workflowId: Schema.String,
  status: Schema.Literal(
    "queued",
    "running",
    "paused",
    "waiting",
    "errored",
    "terminated",
    "unknown",
  ),
});

export const MemoryWorkflowStatusResponse = Schema.Struct({
  workflowId: Schema.String,
  state: Schema.String,
  result: Schema.Union(
    MemoryCompilerWorkflowResult,
    MemoryWorkflowPlatformResult,
    Schema.Null,
  ),
});
export type MemoryWorkflowStatusResponse = Schema.Schema.Type<
  typeof MemoryWorkflowStatusResponse
>;

/** Content-free lifecycle evidence for the memory creation funnel. */
export const MemoryFunnelStage = Schema.Literal(
  "capture",
  "delivery",
  "compilation",
  "review",
  "publication",
);
export type MemoryFunnelStage = Schema.Schema.Type<typeof MemoryFunnelStage>;

export const MemoryFunnelOutcome = Schema.Literal(
  "captured",
  "delivered",
  "delivery_retry",
  "delivery_failed",
  "delivery_expired",
  "membership_dropped",
  "compilation_started",
  "proposal_created",
  "pending_review",
  "published",
  "no_durable_learning",
  "extraction_shadowed",
  "rollout_stopped",
  "conflict",
  "rejected",
  "permanent_failure",
  "infrastructure_failure",
  "quality_sampled",
);
export type MemoryFunnelOutcome = Schema.Schema.Type<
  typeof MemoryFunnelOutcome
>;

export const MemoryFunnelSourceKind = Schema.Literal(
  "web",
  "url",
  "file",
  "conversation",
  "repository",
  "manual",
  "other",
);
export type MemoryFunnelSourceKind = Schema.Schema.Type<
  typeof MemoryFunnelSourceKind
>;

/** Reviewer-entered aggregate labels only; no claim, transcript, or page text. */
export const MemoryQualityCounters = Schema.Struct({
  reviewedCandidates: Schema.Int.pipe(Schema.nonNegative()),
  durablePositiveCandidates: Schema.Int.pipe(Schema.nonNegative()),
  submittedCandidates: Schema.Int.pipe(Schema.nonNegative()),
  returnedHandles: Schema.Int.pipe(Schema.nonNegative()),
  terminalPolls: Schema.Int.pipe(Schema.nonNegative()),
  acceptedAsIs: Schema.Int.pipe(Schema.nonNegative()),
  rejected: Schema.Int.pipe(Schema.nonNegative()),
  nearDuplicates: Schema.Int.pipe(Schema.nonNegative()),
  exactDuplicates: Schema.Int.pipe(Schema.nonNegative()),
  sensitiveEscapes: Schema.Int.pipe(Schema.nonNegative()),
  brokenEvidence: Schema.Int.pipe(Schema.nonNegative()),
});
export type MemoryQualityCounters = Schema.Schema.Type<
  typeof MemoryQualityCounters
>;

export const MemoryQualitySample = Schema.Struct({
  id: Schema.String.pipe(Schema.minLength(1)),
  occurredAt: Schema.String.pipe(Schema.minLength(1)),
  sourceId: Schema.String.pipe(Schema.minLength(1)),
  sourceKind: MemoryFunnelSourceKind,
  rollout: MemoryRolloutAssignment,
  quality: MemoryQualityCounters,
});
export type MemoryQualitySample = Schema.Schema.Type<
  typeof MemoryQualitySample
>;

export const MemoryFunnelTransition = Schema.Struct({
  id: Schema.String.pipe(Schema.minLength(1)),
  occurredAt: Schema.String.pipe(Schema.minLength(1)),
  stage: MemoryFunnelStage,
  outcome: MemoryFunnelOutcome,
  sourceId: Schema.String.pipe(Schema.minLength(1)),
  sourceKind: MemoryFunnelSourceKind,
  rollout: Schema.optional(MemoryRolloutAssignment),
  quality: Schema.optional(MemoryQualityCounters),
  workflowId: Schema.optional(Schema.String),
  proposalSetId: Schema.optional(Schema.String),
  publicationIds: Schema.optional(Schema.Array(Schema.String)),
  failureCode: Schema.optional(Schema.String),
  attempt: Schema.optional(Schema.Int.pipe(Schema.nonNegative())),
});
export type MemoryFunnelTransition = Schema.Schema.Type<
  typeof MemoryFunnelTransition
>;

/** Public, content-bounded handle for reviewing a semantic edge independently. */
export const MemoryRelationshipReview = Schema.Struct({
  proposalId: Schema.String.pipe(Schema.minLength(1)),
  kind: Schema.Literal("wikilink", "dependency"),
  sourcePageId: Schema.String.pipe(Schema.minLength(1)),
  targetPageId: Schema.String.pipe(Schema.minLength(1)),
  claim: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(600)),
  status: Schema.Literal("open", "accepted", "rejected", "superseded"),
});
export type MemoryRelationshipReview = Schema.Schema.Type<
  typeof MemoryRelationshipReview
>;

/** Review result for a durable relationship; factual-page results remain unchanged. */
export const MemoryRelationshipReviewResult = Schema.Union(
  Schema.Struct({
    status: Schema.Literal("accepted"),
    proposalId: Schema.String,
    evidenceId: Schema.String,
    sourceRevisionId: Schema.String,
  }),
  Schema.Struct({
    status: Schema.Literal("rejected"),
    proposalId: Schema.String,
  }),
  Schema.Struct({
    status: Schema.Literal("conflict"),
    proposalId: Schema.String,
    reason: Schema.String,
  }),
);
export type MemoryRelationshipReviewResult = Schema.Schema.Type<
  typeof MemoryRelationshipReviewResult
>;

/** Delivery metadata sent beside a digest; it contains no transcript or query material. */
export const MemoryCaptureDeliveryMetadata = Schema.Struct({
  attempt: Schema.Int.pipe(Schema.greaterThanOrEqualTo(1)),
  failedAttempts: Schema.Int.pipe(Schema.nonNegative()),
  firstSeenAt: Schema.Int.pipe(Schema.nonNegative()),
  deliveredAt: Schema.String.pipe(Schema.minLength(1)),
});
export type MemoryCaptureDeliveryMetadata = Schema.Schema.Type<
  typeof MemoryCaptureDeliveryMetadata
>;

export const MemoryMcpToolName = Schema.Literal(
  "memory_search",
  "memory_read",
  "memory_navigation",
  "memory_export",
  "memory_graph",
  "memory_graph_neighborhood",
  "memory_edge_evidence",
  "memory_dashboard",
  "memory_reviews",
  "memory_propose",
  "memory_workflow_status",
  "memory_review",
  "memory_schema_publish",
  "memory_suggestions",
);
export type MemoryMcpToolName = Schema.Schema.Type<typeof MemoryMcpToolName>;

export const MemoryMcpCacheScope = Schema.Literal("private", "public");
export type MemoryMcpCacheScope = Schema.Schema.Type<
  typeof MemoryMcpCacheScope
>;

export const MEMORY_MCP_ERROR = {
  headerMismatch: -32020,
  missingClientCapability: -32021,
  unsupportedProtocolVersion: -32022,
};
