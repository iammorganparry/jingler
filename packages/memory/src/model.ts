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
