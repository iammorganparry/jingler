import {
  MEMORY_MCP_ERROR,
  MEMORY_MCP_PROTOCOL_VERSION,
  MEMORY_MCP_SERVER_INFO,
  type MemoryGrantClaims,
  MemoryMcpRequestMetadata,
  type MemoryMcpToolName,
  type MemoryPrivilege
} from "@jingler/core"
import { randomUUID } from "node:crypto"
import { Effect, JSONSchema, Match, Schema } from "effect"
import type { JsonValue, MemoryClient, MemoryClientRequest } from "./memory-client.js"

type JsonRpcId = string | number | null

export interface MemoryMcpDependencies {
  readonly verifyGrant: (grant: string, organizationId: string) => MemoryGrantClaims
  readonly client: MemoryClient<JsonValue>
  readonly requestId?: () => string
}

interface ParsedRequest {
  readonly id: JsonRpcId
  readonly method: string
  readonly params: Record<string, unknown>
}

interface ToolDefinition {
  readonly name: MemoryMcpToolName
  readonly description: string
  readonly inputSchema: ReturnType<typeof JSONSchema.make>
  readonly privilege: MemoryPrivilege
  readonly request: (
    value: unknown,
    claims: MemoryGrantClaims,
    requestId: string
  ) => MemoryClientRequest | null
}

const NonEmptyString = Schema.String.pipe(Schema.minLength(1))
const limit = (maximum: number) => Schema.Int.pipe(Schema.between(1, maximum))
const EmptyArguments = Schema.Struct({})
const defineTool = <Arguments, Encoded>(
  definition: Omit<ToolDefinition, "inputSchema" | "request">,
  argumentsSchema: Schema.Schema<Arguments, Encoded>,
  buildRequest: (
    args: Arguments,
    claims: MemoryGrantClaims,
    requestId: string
  ) => MemoryClientRequest
): ToolDefinition => ({
  ...definition,
  inputSchema: JSONSchema.make(argumentsSchema),
  request: (value, claims, requestId) => {
    const args = Schema.decodeUnknownEither(argumentsSchema)(value, { onExcessProperty: "error" })
    return args._tag === "Left" ? null : buildRequest(args.right, claims, requestId)
  }
})

const getRequest = (
  claims: MemoryGrantClaims,
  requestId: string,
  path: string
): MemoryClientRequest => ({
  organizationId: claims.organizationId,
  requestId,
  method: "GET",
  path
})

const tools: ReadonlyArray<ToolDefinition> = [
  defineTool({
    name: "memory_dashboard",
    description: "Read the pre-aggregated private team-memory dashboard.",
    privilege: "read"
  }, EmptyArguments, (_args, claims, requestId) =>
    getRequest(claims, requestId, "/internal/memory/analytics")),
  defineTool({
    name: "memory_graph",
    description: "Read a bounded team-memory graph manifest without page bodies.",
    privilege: "read"
  }, Schema.Struct({ limit: Schema.optional(limit(500)) }), (args, claims, requestId) =>
    getRequest(claims, requestId, `/internal/memory/graph?limit=${args.limit ?? 200}`)),
  defineTool({
    name: "memory_graph_neighborhood",
    description: "Expand one graph node by one hop without returning the complete graph.",
    privilege: "read"
  }, Schema.Struct({ nodeId: NonEmptyString, limit: Schema.optional(limit(500)) }),
  (args, claims, requestId) => getRequest(
    claims,
    requestId,
    `/internal/memory/neighborhood/${encodeURIComponent(args.nodeId)}?limit=${args.limit ?? 100}`
  )),
  defineTool({
    name: "memory_edge_evidence",
    description: "Read the exact accepted evidence for one explicit graph edge.",
    privilege: "read"
  }, Schema.Struct({ edgeId: NonEmptyString }), (args, claims, requestId) =>
    getRequest(
      claims,
      requestId,
      `/internal/memory/edges/${encodeURIComponent(args.edgeId)}/evidence`
    )),
  defineTool({
    name: "memory_navigation",
    description: "Read deterministic index and backlink navigation.",
    privilege: "read"
  }, EmptyArguments, (_args, claims, requestId) =>
    getRequest(claims, requestId, "/internal/memory/navigation")),
  defineTool({
    name: "memory_export",
    description: "Export accepted team-memory pages as an Obsidian-compatible vault.",
    privilege: "read"
  }, EmptyArguments, (_args, claims, requestId) =>
    getRequest(claims, requestId, "/internal/memory/export")),
  defineTool({
    name: "memory_propose",
    description: "Create an explicit revision proposal and return its workflow handle.",
    privilege: "propose"
  }, Schema.Struct({
    pageId: NonEmptyString,
    baseRevisionId: NonEmptyString,
    markdown: NonEmptyString
  }), (args, claims, requestId) => ({
    organizationId: claims.organizationId,
    requestId,
    method: "POST",
    path: "/internal/memory/proposals",
    body: {
      id: `proposal-${requestId}`,
      ...args,
      proposedBy: claims.subject,
      createdAt: new Date().toISOString()
    }
  })),
  defineTool({
    name: "memory_reviews",
    description: "List bounded proposal sets for the private review inbox.",
    privilege: "review"
  }, Schema.Struct({ limit: Schema.optional(limit(100)) }), (args, claims, requestId) =>
    getRequest(claims, requestId, `/internal/memory/reviews?limit=${args.limit ?? 50}`)),
  defineTool({
    name: "memory_read",
    description: "Read one accepted page with stable page, revision, source, and citation ids.",
    privilege: "read"
  }, Schema.Struct({ pageId: NonEmptyString }), (args, claims, requestId) =>
    getRequest(claims, requestId, `/internal/memory/pages/${encodeURIComponent(args.pageId)}`)),
  defineTool({
    name: "memory_review",
    description: "Approve or reject an explicit proposal handle.",
    privilege: "review"
  }, Schema.Struct({ proposalId: NonEmptyString, action: Schema.Literal("approve", "reject") }),
  (args, claims, requestId) => {
    const occurredAt = new Date().toISOString()
    return {
      organizationId: claims.organizationId,
      requestId,
      method: "POST",
      path: `/internal/memory/proposals/${encodeURIComponent(args.proposalId)}/${args.action}`,
      body: args.action === "approve"
        ? { reviewerId: claims.subject, acceptedAt: occurredAt }
        : { reviewerId: claims.subject, rejectedAt: occurredAt }
    }
  }),
  defineTool({
    name: "memory_schema_publish",
    description: "Publish a schema-governed accepted page.",
    privilege: "schema"
  }, Schema.Struct({ page: Schema.Record({ key: Schema.String, value: Schema.Unknown }) }),
  (args, claims, requestId) => ({
    organizationId: claims.organizationId,
    requestId,
    method: "POST",
    path: "/internal/memory/pages",
    body: args.page
  })),
  defineTool({
    name: "memory_search",
    description: "Search accepted team-memory pages using private lexical search.",
    privilege: "read"
  }, Schema.Struct({ query: NonEmptyString, limit: Schema.optional(limit(100)) }),
  (args, claims, requestId) => getRequest(
    claims,
    requestId,
    `/internal/memory/search?q=${encodeURIComponent(args.query)}&limit=${args.limit ?? 20}`
  )),
  defineTool({
    name: "memory_workflow_status",
    description: "Poll a proposal or publication workflow by its explicit handle.",
    privilege: "read"
  }, Schema.Struct({ workflowId: NonEmptyString }), (args, claims, requestId) =>
    getRequest(
      claims,
      requestId,
      `/internal/memory/workflows/${encodeURIComponent(args.workflowId)}`
    ))
]

const StringRecord = Schema.Record({ key: Schema.String, value: Schema.Unknown })
const isStringRecord = Schema.is(StringRecord)
const JsonRpcRequest = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  id: Schema.Union(Schema.String, Schema.Number),
  method: Schema.String,
  params: StringRecord
})

const parseRequest = (value: unknown): ParsedRequest | null => {
  const parsed = Schema.decodeUnknownEither(JsonRpcRequest)(value)
  return parsed._tag === "Left" ? null : parsed.right
}

const resultMetadata = {
  "io.modelcontextprotocol/serverInfo": MEMORY_MCP_SERVER_INFO
}

const successfulResult = (id: JsonRpcId, result: Record<string, unknown>): Record<string, unknown> => ({
  jsonrpc: "2.0",
  id,
  result: {
    resultType: "complete",
    ...result,
    _meta: {
      ...(isStringRecord(result._meta) ? result._meta : {}),
      ...resultMetadata
    }
  }
})

const errorResult = (
  id: JsonRpcId,
  code: number,
  message: string,
  data?: Record<string, unknown>
): Record<string, unknown> => ({
  jsonrpc: "2.0",
  id,
  error: { code, message, ...(data ? { data } : {}) }
})

const jsonResponse = (
  body: Record<string, unknown>,
  status: number,
  requestId: string,
  cacheable = false
): Response =>
  Response.json(body, {
    status,
    headers: {
      "cache-control": cacheable ? "private, max-age=60" : "no-store",
      "x-request-id": requestId
    }
  })

const bearerFrom = (request: Request): string | null => {
  const header = request.headers.get("authorization")
  if (!header?.startsWith("Bearer ")) return null
  const token = header.slice("Bearer ".length)
  return token.length > 0 ? token : null
}

const validateHeaders = (
  request: Request,
  parsed: ParsedRequest
): { readonly code: number; readonly message: string } | null => {
  const protocol = request.headers.get("mcp-protocol-version")
  if (protocol !== MEMORY_MCP_PROTOCOL_VERSION) {
    return {
      code: MEMORY_MCP_ERROR.unsupportedProtocolVersion,
      message: `Unsupported protocol version: ${protocol ?? "missing"}`
    }
  }
  const declaredMethod = request.headers.get("mcp-method")
  if (declaredMethod !== parsed.method) {
    return { code: MEMORY_MCP_ERROR.headerMismatch, message: "Mcp-Method does not match method" }
  }
  const bodyName = typeof parsed.params.name === "string" ? parsed.params.name : null
  const declaredName = request.headers.get("mcp-name")
  if (bodyName !== null && declaredName !== bodyName) {
    return { code: MEMORY_MCP_ERROR.headerMismatch, message: "Mcp-Name does not match name" }
  }
  if (bodyName === null && declaredName !== null) {
    return { code: MEMORY_MCP_ERROR.headerMismatch, message: "Mcp-Name is not valid for this method" }
  }
  return null
}

const validateMetadata = (
  params: Record<string, unknown>
): { readonly code: number; readonly message: string } | null => {
  const metadata = params._meta
  if (!isStringRecord(metadata)) {
    return {
      code: MEMORY_MCP_ERROR.missingClientCapability,
      message: "Per-request MCP metadata is required"
    }
  }
  const protocolVersion = metadata["io.modelcontextprotocol/protocolVersion"]
  if (protocolVersion === undefined) {
    return {
      code: MEMORY_MCP_ERROR.missingClientCapability,
      message: "Per-request protocol version is required"
    }
  }
  if (protocolVersion !== MEMORY_MCP_PROTOCOL_VERSION) {
    return {
      code: MEMORY_MCP_ERROR.unsupportedProtocolVersion,
      message: "Unsupported protocol version in request metadata"
    }
  }
  if (Schema.decodeUnknownEither(MemoryMcpRequestMetadata)(metadata)._tag === "Left") {
    return {
      code: MEMORY_MCP_ERROR.missingClientCapability,
      message: "Client identity and capabilities are required on every request"
    }
  }
  return null
}

const hasPrivilege = (claims: MemoryGrantClaims, privilege: MemoryPrivilege): boolean =>
  claims.privileges.includes(privilege)

const visibleTools = (claims: MemoryGrantClaims): ReadonlyArray<ToolDefinition> =>
  tools.filter((tool) => hasPrivilege(claims, tool.privilege))

const findTool = (name: string): ToolDefinition | null =>
  tools.find((tool) => tool.name === name) ?? null

const callTool = async (
  parsed: ParsedRequest,
  claims: MemoryGrantClaims,
  client: MemoryClient<JsonValue>,
  requestId: string
): Promise<Record<string, unknown>> => {
  const name = typeof parsed.params.name === "string" ? parsed.params.name : ""
  const definition = findTool(name)
  if (!(definition && hasPrivilege(claims, definition.privilege))) {
    return errorResult(parsed.id, -32602, "Unknown or unauthorized tool")
  }
  const args = isStringRecord(parsed.params.arguments) ? parsed.params.arguments : {}
  const workerRequest = definition.request(args, claims, requestId)
  if (!workerRequest) return errorResult(parsed.id, -32602, "Invalid tool arguments")
  try {
    const data = await Effect.runPromise(client.request(workerRequest))
    return successfulResult(parsed.id, {
      content: [{ type: "text", text: JSON.stringify(data) }],
      structuredContent: { data }
    })
  } catch {
    return errorResult(parsed.id, -32603, "Private memory service request failed", { requestId })
  }
}

const dispatchAuthenticatedRequest = async (
  parsed: ParsedRequest,
  claims: MemoryGrantClaims,
  client: MemoryClient<JsonValue>,
  requestId: string
): Promise<Response> =>
  Promise.resolve(Match.value(parsed.method).pipe(
    Match.when("server/discover", () => jsonResponse(
      successfulResult(parsed.id, {
        supportedVersions: [MEMORY_MCP_PROTOCOL_VERSION],
        capabilities: { tools: {} },
        serverInfo: MEMORY_MCP_SERVER_INFO,
        instructions: "Search accepted team memory and use proposal handles for changes.",
        ttlMs: 60_000,
        cacheScope: "private"
      }),
      200,
      requestId,
      true
    )),
    Match.when("tools/list", () => jsonResponse(
      successfulResult(parsed.id, {
        tools: visibleTools(claims).map(({ name, description, inputSchema }) => ({
          name,
          description,
          inputSchema
        })),
        ttlMs: 60_000,
        cacheScope: "private"
      }),
      200,
      requestId,
      true
    )),
    Match.when("tools/call", async () =>
      jsonResponse(await callTool(parsed, claims, client, requestId), 200, requestId)
    ),
    Match.orElse(() =>
      jsonResponse(errorResult(parsed.id, -32601, "Method not found"), 404, requestId)
    )
  ))

export const handleMemoryMcpRequest = async (
  request: Request,
  dependencies: MemoryMcpDependencies
): Promise<Response> => {
  const requestId = request.headers.get("x-request-id") ?? (dependencies.requestId ?? randomUUID)()
  const organizationId = request.headers.get("x-jingler-organization-id")
  const grant = bearerFrom(request)
  if (!(organizationId && grant)) {
    return jsonResponse(errorResult(null, -32000, "Memory grant and organization scope required"), 401, requestId)
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return jsonResponse(errorResult(null, -32700, "Invalid JSON"), 400, requestId)
  }
  const parsed = parseRequest(body)
  if (!parsed) return jsonResponse(errorResult(null, -32600, "Invalid request"), 400, requestId)
  const validationError = validateHeaders(request, parsed) ?? validateMetadata(parsed.params)
  if (validationError) {
    return jsonResponse(
      errorResult(parsed.id, validationError.code, validationError.message),
      400,
      requestId
    )
  }
  try {
    const claims = dependencies.verifyGrant(grant, organizationId)
    return dispatchAuthenticatedRequest(parsed, claims, dependencies.client, requestId)
  } catch {
    return jsonResponse(errorResult(parsed.id, -32000, "Invalid memory grant"), 401, requestId)
  }
}

export const rejectMemoryMcpGet = (): Response =>
  Response.json(errorResult(null, -32601, "HTTP GET transport is not supported"), {
    status: 405,
    headers: { allow: "POST", "cache-control": "no-store" }
  })
