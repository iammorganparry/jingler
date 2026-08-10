import { Schema } from "effect"

export const ManagedResourceId = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(160),
  Schema.pattern(/^[a-z0-9][a-z0-9._-]*$/u),
  Schema.brand("ManagedResourceId")
)
export type ManagedResourceId = Schema.Schema.Type<typeof ManagedResourceId>

export const ManagedResourceKind = Schema.Literal("skill", "prompt", "mcp")
export type ManagedResourceKind = Schema.Schema.Type<typeof ManagedResourceKind>

export const ManagedResourceTrust = Schema.Literal("untrusted", "operator-approved")
export type ManagedResourceTrust = Schema.Schema.Type<typeof ManagedResourceTrust>

export const ManagedResourceOrigin = Schema.Literal(
  "claude",
  "codex",
  "opencode",
  "pi",
  "shared",
  "jingler"
)
export type ManagedResourceOrigin = Schema.Schema.Type<typeof ManagedResourceOrigin>

export const ManagedResourceProvenance = Schema.Struct({
  origin: ManagedResourceOrigin,
  sourceRoot: Schema.String,
  sourcePath: Schema.String,
  importedAt: Schema.NullOr(Schema.String)
})
export type ManagedResourceProvenance = Schema.Schema.Type<
  typeof ManagedResourceProvenance
>

export const ManagedResourceScope = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("portable"),
    allowedTargets: Schema.Array(Schema.String).pipe(Schema.maxItems(64))
  }),
  Schema.Struct({
    kind: Schema.Literal("device-local"),
    targetId: Schema.String
  })
)
export type ManagedResourceScope = Schema.Schema.Type<typeof ManagedResourceScope>

export const ManagedResourceAvailability = Schema.Struct({
  state: Schema.Literal("available", "unavailable", "disabled"),
  targetId: Schema.String,
  reason: Schema.NullOr(Schema.String)
})
export type ManagedResourceAvailability = Schema.Schema.Type<
  typeof ManagedResourceAvailability
>

const ManagedResourceBase = {
  id: ManagedResourceId,
  name: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(160)),
  enabled: Schema.Boolean,
  trust: ManagedResourceTrust,
  scope: ManagedResourceScope,
  provenance: ManagedResourceProvenance
}

export const ManagedFileResource = Schema.Struct({
  ...ManagedResourceBase,
  kind: Schema.Literal("skill", "prompt"),
  description: Schema.String.pipe(Schema.maxLength(2_000)),
  managedPath: Schema.String,
  byteLength: Schema.Int.pipe(Schema.nonNegative())
})
export type ManagedFileResource = Schema.Schema.Type<typeof ManagedFileResource>

const ManagedMcpBase = {
  ...ManagedResourceBase,
  kind: Schema.Literal("mcp"),
  availability: ManagedResourceAvailability
}

export const ManagedMcpServer = Schema.Union(
  Schema.Struct({
    ...ManagedMcpBase,
    transport: Schema.Literal("http", "sse"),
    url: Schema.String,
    headerKeys: Schema.Array(Schema.String).pipe(Schema.maxItems(64))
  }),
  Schema.Struct({
    ...ManagedMcpBase,
    transport: Schema.Literal("stdio"),
    command: Schema.String,
    args: Schema.Array(Schema.String).pipe(Schema.maxItems(256)),
    envKeys: Schema.Array(Schema.String).pipe(Schema.maxItems(128))
  })
)
export type ManagedMcpServer = Schema.Schema.Type<typeof ManagedMcpServer>

export const ManagedResource = Schema.Union(ManagedFileResource, ManagedMcpServer)
export type ManagedResource = Schema.Schema.Type<typeof ManagedResource>

export const ResourceImportDiagnostic = Schema.Struct({
  sourcePath: Schema.String,
  kind: Schema.NullOr(ManagedResourceKind),
  code: Schema.Literal(
    "malformed",
    "oversized",
    "escaping-path",
    "unsupported",
    "duplicate",
    "reserved-name",
    "unavailable-target"
  ),
  message: Schema.String
})
export type ResourceImportDiagnostic = Schema.Schema.Type<
  typeof ResourceImportDiagnostic
>

export const DetectedResourceCandidate = Schema.Struct({
  id: ManagedResourceId,
  kind: ManagedResourceKind,
  name: Schema.String,
  description: Schema.String,
  byteLength: Schema.Int.pipe(Schema.nonNegative()),
  provenance: ManagedResourceProvenance
})
export type DetectedResourceCandidate = Schema.Schema.Type<
  typeof DetectedResourceCandidate
>

export const ResourceDetectionResult = Schema.Struct({
  candidates: Schema.Array(DetectedResourceCandidate),
  skipped: Schema.Array(ResourceImportDiagnostic)
})
export type ResourceDetectionResult = Schema.Schema.Type<
  typeof ResourceDetectionResult
>

export const ResourceImportResult = Schema.Struct({
  imported: Schema.Array(ManagedResourceId),
  skipped: Schema.Array(ResourceImportDiagnostic)
})
export type ResourceImportResult = Schema.Schema.Type<typeof ResourceImportResult>
