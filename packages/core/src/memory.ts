import { Schema } from "effect"

/** The only MCP revision exposed by the stateless team-memory endpoint. */
export const MEMORY_MCP_PROTOCOL_VERSION = "2026-07-28"

/** Stable identity stamped on discovery and every successful MCP result. */
export const MEMORY_MCP_SERVER_INFO = {
  name: "jingler-team-memory",
  title: "Jingler Team Memory",
  version: "1.0.0"
}

export const MemoryPrivilege = Schema.Literal("read", "propose", "review", "schema")
export type MemoryPrivilege = Schema.Schema.Type<typeof MemoryPrivilege>

export const MemoryOrganizationRole = Schema.Literal("member", "admin", "owner")
export type MemoryOrganizationRole = Schema.Schema.Type<typeof MemoryOrganizationRole>

/**
 * The authorization ladder is deliberately monotonic. Members can retrieve and
 * propose, admins can additionally review, and only owners can change schemas.
 */
export const memoryPrivilegesForRole = (
  role: MemoryOrganizationRole
): ReadonlyArray<MemoryPrivilege> => {
  switch (role) {
    case "member":
      return ["read", "propose"]
    case "admin":
      return ["read", "propose", "review"]
    case "owner":
      return ["read", "propose", "review", "schema"]
  }
}

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
  grantId: Schema.String
})
export type MemoryGrantClaims = Schema.Schema.Type<typeof MemoryGrantClaims>

export const MemoryGrantResponse = Schema.Struct({
  grant: Schema.String,
  claims: MemoryGrantClaims
})
export type MemoryGrantResponse = Schema.Schema.Type<typeof MemoryGrantResponse>

/** Shared wire contract for publishing one accepted Markdown revision. */
export const MemoryAcceptedPageRequest = Schema.Struct({
  revisionId: Schema.String.pipe(Schema.minLength(1)),
  markdown: Schema.String.pipe(Schema.minLength(1)),
  actorId: Schema.String.pipe(Schema.minLength(1)),
  createdAt: Schema.String.pipe(Schema.minLength(1))
})
export type MemoryAcceptedPageRequest = Schema.Schema.Type<typeof MemoryAcceptedPageRequest>

export const McpClientInfo = Schema.Struct({
  name: Schema.String,
  version: Schema.String
})
export type McpClientInfo = Schema.Schema.Type<typeof McpClientInfo>

/** Required request-local metadata replacing MCP's former initialize session. */
export const MemoryMcpRequestMetadata = Schema.Struct({
  "io.modelcontextprotocol/protocolVersion": Schema.Literal(MEMORY_MCP_PROTOCOL_VERSION),
  "io.modelcontextprotocol/clientInfo": McpClientInfo,
  "io.modelcontextprotocol/clientCapabilities": Schema.Record({
    key: Schema.String,
    value: Schema.Unknown
  })
})
export type MemoryMcpRequestMetadata = Schema.Schema.Type<typeof MemoryMcpRequestMetadata>

export const MemoryMcpRequest = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  id: Schema.Union(Schema.String, Schema.Number),
  method: Schema.String,
  params: Schema.Struct({
    _meta: MemoryMcpRequestMetadata
  }).pipe(
    Schema.extend(
      Schema.Record({
        key: Schema.String,
        value: Schema.Unknown
      })
    )
  )
})
export type MemoryMcpRequest = Schema.Schema.Type<typeof MemoryMcpRequest>

export const MemoryMcpServerInfo = Schema.Struct({
  name: Schema.String,
  title: Schema.optional(Schema.String),
  version: Schema.String
})
export type MemoryMcpServerInfo = Schema.Schema.Type<typeof MemoryMcpServerInfo>

/** Stateless MCP response proving that a request completed successfully. */
export const MemoryMcpCompleteResponse = Schema.Struct({
  result: Schema.Struct({
    resultType: Schema.Literal("complete")
  })
})
export type MemoryMcpCompleteResponse = Schema.Schema.Type<
  typeof MemoryMcpCompleteResponse
>

/** Successful tool response shape; tool data remains intentionally polymorphic. */
export const MemoryMcpToolResponse = Schema.Struct({
  result: Schema.Struct({
    resultType: Schema.Literal("complete"),
    structuredContent: Schema.Struct({ data: Schema.Unknown })
  })
})
export type MemoryMcpToolResponse = Schema.Schema.Type<typeof MemoryMcpToolResponse>

/** Aggregate-only agent retrieval activity; no query, result, timing, or credential data. */
export const MemoryRetrievalSummary = Schema.Struct({
  searches: Schema.Int.pipe(Schema.between(0, 1_000_000)),
  reads: Schema.Int.pipe(Schema.between(0, 1_000_000)),
  navigation: Schema.Int.pipe(Schema.between(0, 1_000_000)),
  graphReads: Schema.Int.pipe(Schema.between(0, 1_000_000)),
  proposals: Schema.Int.pipe(Schema.between(0, 1_000_000))
})
export type MemoryRetrievalSummary = Schema.Schema.Type<typeof MemoryRetrievalSummary>

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
  "memory_suggestions"
)
export type MemoryMcpToolName = Schema.Schema.Type<typeof MemoryMcpToolName>

export const MemoryMcpCacheScope = Schema.Literal("private", "public")
export type MemoryMcpCacheScope = Schema.Schema.Type<typeof MemoryMcpCacheScope>

export const MEMORY_MCP_ERROR = {
  headerMismatch: -32020,
  missingClientCapability: -32021,
  unsupportedProtocolVersion: -32022
}
