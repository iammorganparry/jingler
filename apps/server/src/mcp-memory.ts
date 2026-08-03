import {
  MEMORY_MCP_ERROR,
  MEMORY_MCP_PROTOCOL_VERSION,
  MEMORY_MCP_SERVER_INFO,
  MemoryAcceptedPageRequest,
  type MemoryGrantClaims,
  MemoryMcpRequestMetadata,
  type MemoryMcpToolName,
  type MemoryPrivilege
} from "@jingler/core"
import { createHash, randomUUID } from "node:crypto"
import { Effect, JSONSchema, Match, Schema } from "effect"
import type { JsonValue, MemoryClient, MemoryClientRequest } from "./memory-client.js"

type JsonRpcId = string | number | null

export interface MemoryMcpDependencies {
  // Awaitable so the route can compose a synchronous HMAC-grant verifier with an
  // asynchronous Personal Access Token verifier (which hits the DB + paid gate).
  // A sync verifier still satisfies this — awaiting a plain value is a no-op.
  readonly verifyGrant: (
    grant: string,
    organizationId: string
  ) => MemoryGrantClaims | Promise<MemoryGrantClaims>
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
  }, Schema.Struct({ range: Schema.optional(Schema.String) }), (args, claims, requestId) =>
    getRequest(
      claims,
      requestId,
      `/internal/memory/analytics${args.range === undefined ? "" : `?range=${encodeURIComponent(args.range)}`}`
    )),
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
  }, Schema.Struct({ nodeId: NonEmptyString, limit: Schema.optional(limit(100)) }),
  (args, claims, requestId) => getRequest(
    claims,
    requestId,
    // The Worker (and desktop) clamp neighborhood expansion to
    // MAX_NEIGHBORHOOD_LIMIT = 100; the published schema bound must match so a
    // client is never told a 101–500 limit is honoured when it is silently cut.
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
    description: "Compile a new memory or create an explicit revision proposal.",
    privilege: "propose"
  }, Schema.Struct({
    pageId: NonEmptyString,
    baseRevisionId: NonEmptyString,
    markdown: NonEmptyString
  }), (args, claims, requestId) => {
    const identity = createHash("sha256")
      .update([claims.subject, args.pageId, args.baseRevisionId, args.markdown].join("\u0000"))
      .digest("hex")

    // Existing-page proposals require a real accepted head. A brand-new memory
    // has neither a head nor a citation source, so ingest it as a manual source;
    // the Worker starts the durable compiler and returns its workflow handle.
    if (args.baseRevisionId === "new") {
      const sourceId = `source:proposal-${identity}`
      return {
        organizationId: claims.organizationId,
        requestId,
        method: "POST",
        path: "/internal/memory/sources",
        body: {
          source: {
            id: sourceId,
            kind: "manual",
            title: `Agent memory proposal: ${args.pageId}`,
            uri: `jingler://memory-proposal/${identity}`,
            retrievedAt: new Date().toISOString(),
            contentHash: createHash("sha256").update(args.markdown).digest("hex")
          },
          content: args.markdown
        }
      }
    }

    return {
      organizationId: claims.organizationId,
      requestId,
      method: "POST",
      path: "/internal/memory/proposals",
      body: {
      // The proposal id is derived SERVER-SIDE from the grant subject plus the
      // proposal content — never from a client-supplied header. This removes
      // client control over the durable id (a grant holder could otherwise
      // collide with a teammate's in-flight proposal, which the vault rejects
      // with a same-id/different-content 409), namespaces the id by subject so
      // two users can never collide, and keeps idempotent replay: the same
      // subject + same content always hashes to the same id, so the vault's
      // same-id/same-content dedup returns the existing proposal. `requestId`
      // (the x-request-id header) is retained for tracing only.
        id: `proposal-${identity}`,
        ...args,
        proposedBy: claims.subject,
        createdAt: new Date().toISOString()
      }
    }
  }),
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
      acceptedStatuses: args.action === "approve" ? [409] : [],
      body: args.action === "approve"
        ? { reviewerId: claims.subject, acceptedAt: occurredAt }
        : { reviewerId: claims.subject, rejectedAt: occurredAt }
    }
  }),
  defineTool({
    name: "memory_schema_publish",
    description: "Publish a schema-governed accepted page.",
    privilege: "schema"
  }, Schema.Struct({ revisionId: NonEmptyString, markdown: NonEmptyString }),
  (args, claims, requestId) => ({
    organizationId: claims.organizationId,
    requestId,
    method: "POST",
    path: "/internal/memory/pages",
    body: Schema.decodeUnknownSync(MemoryAcceptedPageRequest)({
      revisionId: args.revisionId,
      markdown: args.markdown,
      actorId: claims.subject,
      createdAt: new Date().toISOString()
    })
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
    name: "memory_suggestions",
    description:
      "Read advisory 'related pages' relatedness suggestions. These are hints only, never accepted graph edges.",
    privilege: "read"
  }, Schema.Struct({
    limit: Schema.optional(limit(50)),
    pageId: Schema.optional(NonEmptyString)
  }), (args, claims, requestId) =>
    getRequest(
      claims,
      requestId,
      `/internal/memory/suggestions?limit=${args.limit ?? 5}${
        args.pageId === undefined ? "" : `&pageId=${encodeURIComponent(args.pageId)}`
      }`
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

/**
 * Serialisable view of the MCP tool surface — name, one-line description,
 * privilege, and the already-computed JSON Schema for arguments. This is the
 * single source of truth for the distributable `jingler-team-memory` skill's tool
 * catalog: `apps/server/scripts/generate-memory-skill.ts` reads it to regenerate
 * the skill's references/tools.md, so the skill never drifts from the server. Add
 * or change a tool above and the generator (and its CI `--check`) picks it up.
 */
export const memoryMcpToolManifest: ReadonlyArray<{
  readonly name: MemoryMcpToolName
  readonly description: string
  readonly privilege: MemoryPrivilege
  readonly inputSchema: ToolDefinition["inputSchema"]
}> = tools.map(({ name, description, privilege, inputSchema }) => ({
  name,
  description,
  privilege,
  inputSchema
}))

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
  let workerRequest: MemoryClientRequest | null
  try {
    // A request builder can throw AFTER argument decode — e.g.
    // memory_schema_publish re-decodes with `Schema.decodeUnknownSync`. Contain
    // it as a JSON-RPC error so it never escapes as a bare 500 or a mislabeled
    // 401 "Invalid memory grant".
    workerRequest = definition.request(args, claims, requestId)
  } catch {
    return errorResult(parsed.id, -32603, "Tool request could not be constructed", { requestId })
  }
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

/** Fallback MCP revision if a standard client's `initialize` omits one; we echo theirs when present. */
const STANDARD_MCP_DEFAULT_VERSION = "2025-06-18"

/**
 * Serve a STANDARD MCP client — the harnesses' native codex / opencode / Claude
 * clients. Unlike the bespoke stateless protocol above, they send no `Mcp-*`
 * headers and no per-request `_meta`, may omit `params`/`id`, and open with the
 * spec `initialize` handshake (+ `notifications/initialized`) before ever calling
 * `tools/list`. Without answering that handshake their client aborts and never
 * discovers the tools. We answer it and reuse the same grant-gated dispatch, so
 * the tools load. Still stateless — no session id is minted or required.
 */
const handleStandardMcpRequest = async (
  body: unknown,
  organizationId: string,
  grant: string,
  dependencies: MemoryMcpDependencies,
  requestId: string
): Promise<Response> => {
  if (!isStringRecord(body) || typeof body.method !== "string") {
    return jsonResponse(errorResult(null, -32600, "Invalid request"), 400, requestId)
  }
  const method = body.method
  const id = typeof body.id === "string" || typeof body.id === "number" ? body.id : null
  const params = isStringRecord(body.params) ? body.params : {}

  // Notifications (initialized, cancelled, …) carry no id and expect no result.
  if (id === null || method.startsWith("notifications/")) {
    return new Response(null, {
      status: 202,
      headers: { "x-request-id": requestId, "cache-control": "no-store" }
    })
  }
  if (method === "initialize") {
    const protocolVersion =
      typeof params.protocolVersion === "string" ? params.protocolVersion : STANDARD_MCP_DEFAULT_VERSION
    return jsonResponse(
      {
        jsonrpc: "2.0",
        id,
        result: { protocolVersion, capabilities: { tools: {} }, serverInfo: MEMORY_MCP_SERVER_INFO }
      },
      200,
      requestId
    )
  }
  if (method === "ping") {
    return jsonResponse({ jsonrpc: "2.0", id, result: {} }, 200, requestId)
  }
  if (method !== "tools/list" && method !== "tools/call") {
    return jsonResponse(errorResult(id, -32601, "Method not found"), 404, requestId)
  }
  let claims: MemoryGrantClaims
  try {
    claims = await dependencies.verifyGrant(grant, organizationId)
  } catch {
    return jsonResponse(errorResult(id, -32000, "Invalid memory grant"), 401, requestId)
  }
  try {
    return await dispatchAuthenticatedRequest({ id, method, params }, claims, dependencies.client, requestId)
  } catch {
    return jsonResponse(
      errorResult(id, -32603, "Internal memory service error", { requestId }),
      500,
      requestId
    )
  }
}

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

  // A standard MCP client (native codex/opencode/Claude) sends none of Jingler's
  // bespoke `Mcp-*` headers. Route it through the spec-compliant handshake path so
  // its client can actually discover the tools; the strict path below stays for
  // the stateless `Mcp-Method`-tagged protocol.
  if (request.headers.get("mcp-method") === null) {
    return handleStandardMcpRequest(body, organizationId, grant, dependencies, requestId)
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
  let claims: MemoryGrantClaims
  try {
    claims = await dependencies.verifyGrant(grant, organizationId)
  } catch {
    // Only a grant-verification failure is a 401. Errors raised while dispatching
    // must not be relabeled as an invalid grant.
    return jsonResponse(errorResult(parsed.id, -32000, "Invalid memory grant"), 401, requestId)
  }
  try {
    // `await` so a rejected dispatch is caught here rather than escaping the
    // handler as an enveloped-less Next 500 with no x-request-id.
    return await dispatchAuthenticatedRequest(parsed, claims, dependencies.client, requestId)
  } catch {
    return jsonResponse(
      errorResult(parsed.id, -32603, "Internal memory service error", { requestId }),
      500,
      requestId
    )
  }
}

export const rejectMemoryMcpGet = (): Response =>
  Response.json(errorResult(null, -32601, "HTTP GET transport is not supported"), {
    status: 405,
    headers: { allow: "POST", "cache-control": "no-store" }
  })
