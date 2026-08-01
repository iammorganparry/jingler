import { createHash } from "node:crypto"
import type {
  CliKind,
  MemoryGrantResponse,
  MemoryOrganizationRole,
  MemoryPrivilege,
  MemoryRetrievalSummary
} from "@jingler/core"
import {
  MEMORY_CONFIG_DEFAULT,
  MEMORY_MCP_PROTOCOL_VERSION,
  MemoryMcpCompleteResponse,
  MemoryMcpToolResponse,
  MemoryGrantResponse as MemoryGrantResponseSchema
} from "@jingler/core"
import type { FileSystem } from "@effect/platform"
import { Data, Effect, Either, Schema } from "effect"
import type { RemoteMcpServer } from "./adapter.js"
import type { AppPaths } from "./app-paths.js"
import { ConfigService } from "./config.js"
import { memoryPrompt } from "./memory-prompt.js"
import { SecretStore } from "./secret-store.js"

const MEMORY_SERVER_NAME = "jingler-memory"
const MEMORY_AUTH_ENVIRONMENT = "JINGLER_MEMORY_AUTHORIZATION"
const DEFAULT_TIMEOUT_MS = 1_500
const MAX_DIGEST_CHARACTERS = 8_000
const MAX_CAPTURED_DIGESTS = 1_024
const MCP_TOOL_PREFIX_PATTERN = /^mcp__jingler-memory__/
const LEADING_SLASH_PATTERN = /^\/+/
const PRIVATE_KEY_PATTERN = /-----BEGIN [^-\r\n]+-----[\s\S]*?-----END [^-\r\n]+-----/g
const AUTH_VALUE_PATTERN = /\b(authorization|proxy-authorization|cookie|set-cookie|mcp-session-id)\s*[:=]\s*(?:bearer\s+)?[^\s,;]+/gi
const CREDENTIAL_VALUE_PATTERN = /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret)\s*[:=]\s*["']?[^\s,"';]+["']?/gi
const PROVIDER_TOKEN_PATTERN = /\b(?:sk|pk|ghp|gho|github_pat|xox[baprs])-[-A-Za-z0-9_]{8,}\b/g
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g
const SECRET_QUERY_PATTERN = /([?&](?:token|key|secret|password|signature)=)[^&#\s]+/gi
const EMAIL_PATTERN = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g
const HOME_PATH_PATTERN = /\/(?:Users|home)\/[^/\s]+/g
const REDACTED_VALUE = "[REDACTED]"

type MemoryServiceEnvironment =
  | ConfigService
  | SecretStore
  | FileSystem.FileSystem
  | AppPaths

export interface MemoryAttachment {
  readonly server: RemoteMcpServer
  readonly instructions: string
}

export const EMPTY_MEMORY_RETRIEVAL_SUMMARY: MemoryRetrievalSummary = {
  searches: 0,
  reads: 0,
  navigation: 0,
  graphReads: 0,
  proposals: 0
}

/** Fold a renderer-visible tool name into counters without retaining arguments. */
export const recordMemoryRetrieval = (
  summary: MemoryRetrievalSummary,
  toolName: string
): MemoryRetrievalSummary => {
  const name = toolName.toLowerCase().replace(MCP_TOOL_PREFIX_PATTERN, "")
  switch (name) {
    case "memory_search":
      return { ...summary, searches: summary.searches + 1 }
    case "memory_read":
      return { ...summary, reads: summary.reads + 1 }
    case "memory_navigation":
      return { ...summary, navigation: summary.navigation + 1 }
    case "memory_graph":
    case "memory_graph_neighborhood":
      return { ...summary, graphReads: summary.graphReads + 1 }
    case "memory_propose":
      return { ...summary, proposals: summary.proposals + 1 }
    default:
      return summary
  }
}

export interface MemorySessionDigestInput {
  readonly sessionId: string
  readonly chatId: string
  /** Stable assistant-turn id: the idempotency boundary for one settled run. */
  readonly turnId: string
  readonly cli: CliKind
  readonly userText: string
  readonly assistantText: string
  readonly settledAt: string
  readonly retrieval: MemoryRetrievalSummary
}

export interface MemoryServiceShape {
  readonly attachment: (
    cli: CliKind
  ) => Effect.Effect<MemoryAttachment | null, never, MemoryServiceEnvironment>
  readonly captureSettledSession: (
    input: MemorySessionDigestInput
  ) => Effect.Effect<boolean, never, MemoryServiceEnvironment>
  /** Resolve renderer-safe eligibility; the grant itself remains in this service. */
  readonly access: () => Effect.Effect<MemoryUiAccess | null, never, MemoryServiceEnvironment>
  /** Perform one stateless MCP tool call without exposing request credentials. */
  readonly uiRequest: (
    input: MemoryUiRequest
  ) => Effect.Effect<unknown | null, never, MemoryServiceEnvironment>
}

export interface MemoryUiAccess {
  readonly organizationId: string
  readonly role: MemoryOrganizationRole
  readonly privileges: ReadonlyArray<MemoryPrivilege>
}

export interface MemoryUiRequest {
  readonly organizationId: string
  readonly name: string
  readonly arguments: Readonly<Record<string, unknown>>
}

export interface MemoryServiceOptions {
  readonly fetch?: typeof fetch
  readonly baseUrl?: () => string
  readonly nowSeconds?: () => number
  readonly timeoutMs?: number
}

interface MemoryRuntime {
  readonly fetchImplementation: typeof fetch
  readonly baseUrl: () => string
  readonly nowSeconds: () => number
  readonly timeoutMs: number
  readonly captured: Map<string, true>
  readonly capturing: Set<string>
}

interface SelectedMemory {
  readonly organizationId: string
  readonly token: string
}

class MemoryRequestError extends Data.TaggedError("MemoryRequestError")<{
  readonly status: number
}> {}

const configuredBaseUrl = (): string =>
  process.env.JINGLER_MEMORY_URL ?? process.env.JINGLER_AUTH_URL ?? "http://localhost:9100"

const endpoint = (baseUrl: string, path: string): URL => {
  const normalized = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`
  return new URL(path.replace(LEADING_SLASH_PATTERN, ""), normalized)
}

const boundedCount = (value: number): number =>
  Number.isFinite(value) ? Math.min(1_000_000, Math.max(0, Math.floor(value))) : 0

const safeRetrieval = (value: MemoryRetrievalSummary): MemoryRetrievalSummary => ({
  searches: boundedCount(value.searches),
  reads: boundedCount(value.reads),
  navigation: boundedCount(value.navigation),
  graphReads: boundedCount(value.graphReads),
  proposals: boundedCount(value.proposals)
})

/**
 * Remove credential-shaped and machine-local material before a conversation can
 * become a durable source. The digest intentionally excludes tool arguments,
 * tool results, images, diagnostics, and protocol/request metadata entirely.
 */
const stripControlCharacters = (value: string): string =>
  [...value]
    .filter((character) => {
      const code = character.charCodeAt(0)
      return code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127)
    })
    .join("")

export const redactMemoryText = (value: string): string =>
  stripControlCharacters(
    value
      .replace(PRIVATE_KEY_PATTERN, "[REDACTED PRIVATE KEY]")
      .replace(AUTH_VALUE_PATTERN, (_match, label: string) => `${label}: ${REDACTED_VALUE}`)
      .replace(CREDENTIAL_VALUE_PATTERN, (_match, label: string) => `${label}=${REDACTED_VALUE}`)
      .replace(PROVIDER_TOKEN_PATTERN, "[REDACTED TOKEN]")
      .replace(JWT_PATTERN, "[REDACTED TOKEN]")
      .replace(SECRET_QUERY_PATTERN, `$1${REDACTED_VALUE}`)
      .replace(EMAIL_PATTERN, "[REDACTED EMAIL]")
      .replace(HOME_PATH_PATTERN, "~")
  )

const clipped = (value: string, maxCharacters: number): string =>
  value.length <= maxCharacters ? value : `${value.slice(0, maxCharacters)}\n[TRUNCATED]`

const sha256 = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex")

export const memoryDigestContent = (input: MemorySessionDigestInput): string => {
  const user = clipped(redactMemoryText(input.userText).trim(), 3_000)
  const assistant = clipped(redactMemoryText(input.assistantText).trim(), 4_000)
  return clipped(
    [
      `Harness: ${input.cli}`,
      "",
      "User request:",
      user,
      "",
      "Settled outcome:",
      assistant
    ].join("\n"),
    MAX_DIGEST_CHARACTERS
  )
}

const requestMetadata = {
  "io.modelcontextprotocol/protocolVersion": MEMORY_MCP_PROTOCOL_VERSION,
  "io.modelcontextprotocol/clientInfo": { name: "jingler-desktop", version: "1.0.0" },
  "io.modelcontextprotocol/clientCapabilities": {}
}

const grantHeaders = (token: string): Record<string, string> => ({
  authorization: `Bearer ${token}`,
  "content-type": "application/json"
})

const scopedHeaders = (
  grant: string,
  organizationId: string,
  method?: string
): Record<string, string> => ({
  authorization: `Bearer ${grant}`,
  "content-type": "application/json",
  "mcp-protocol-version": MEMORY_MCP_PROTOCOL_VERSION,
  "x-jingler-organization-id": organizationId,
  ...(method === undefined ? {} : { "mcp-method": method })
})

const requestJson = <A, I>(
  runtime: MemoryRuntime,
  path: string,
  init: RequestInit,
  schema: Schema.Schema<A, I>
): Effect.Effect<A, MemoryRequestError> =>
  Effect.tryPromise({
    try: async () => {
      const response = await runtime.fetchImplementation(endpoint(runtime.baseUrl(), path), {
        ...init,
        signal: AbortSignal.timeout(runtime.timeoutMs)
      })
      if (!response.ok) throw new MemoryRequestError({ status: response.status })
      return response.json()
    },
    catch: (cause) =>
      cause instanceof MemoryRequestError ? cause : new MemoryRequestError({ status: 0 })
  }).pipe(
    Effect.flatMap(Schema.decodeUnknown(schema)),
    Effect.mapError((cause) =>
      cause instanceof MemoryRequestError ? cause : new MemoryRequestError({ status: 502 })
    )
  )

const requestGrant = (
  runtime: MemoryRuntime,
  selection: SelectedMemory
): Effect.Effect<MemoryGrantResponse, MemoryRequestError> =>
  requestJson(
    runtime,
    "/api/memory/grant",
    {
      method: "POST",
      headers: grantHeaders(selection.token),
      body: JSON.stringify({ organizationId: selection.organizationId })
    },
    MemoryGrantResponseSchema
  ).pipe(
    Effect.flatMap((parsed) => {
      if (
        parsed.claims.organizationId !== selection.organizationId ||
        parsed.claims.expiresAt <= runtime.nowSeconds()
      ) {
        return Effect.fail(new MemoryRequestError({ status: 401 }))
      }
      return Effect.succeed(parsed)
    })
  )

const discoverGrant = (
  runtime: MemoryRuntime,
  issued: MemoryGrantResponse,
  organizationId: string
): Effect.Effect<void, MemoryRequestError> =>
  requestJson(
    runtime,
    "/api/mcp",
    {
        method: "POST",
        headers: scopedHeaders(issued.grant, organizationId, "server/discover"),
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: `discover-${issued.claims.grantId}`,
          method: "server/discover",
          params: { _meta: requestMetadata }
        }),
    },
    MemoryMcpCompleteResponse
  ).pipe(Effect.asVoid)

const roleFromPrivileges = (
  privileges: ReadonlyArray<MemoryPrivilege>
): MemoryOrganizationRole =>
  privileges.includes("schema") ? "owner" : privileges.includes("review") ? "admin" : "member"

const callMemoryTool = (
  runtime: MemoryRuntime,
  issued: MemoryGrantResponse,
  input: MemoryUiRequest
): Effect.Effect<unknown, MemoryRequestError> =>
  requestJson(
    runtime,
    "/api/mcp",
    {
        method: "POST",
        headers: {
          ...scopedHeaders(issued.grant, input.organizationId, "tools/call"),
          "mcp-name": input.name,
          "x-request-id": `desktop-memory-${issued.claims.grantId}`
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: `ui-${issued.claims.grantId}`,
          method: "tools/call",
          params: {
            name: input.name,
            arguments: input.arguments,
            _meta: requestMetadata
          }
        }),
    },
    MemoryMcpToolResponse
  ).pipe(Effect.map((response) => response.result.structuredContent.data))

const attachmentFrom = (
  runtime: MemoryRuntime,
  issued: MemoryGrantResponse,
  organizationId: string
): MemoryAttachment => ({
  server: {
    name: MEMORY_SERVER_NAME,
    url: endpoint(runtime.baseUrl(), "/api/mcp").toString(),
    headers: {
      authorization: `Bearer ${issued.grant}`,
      "mcp-protocol-version": MEMORY_MCP_PROTOCOL_VERSION,
      "x-jingler-organization-id": organizationId
    },
    headerEnvironment: { authorization: MEMORY_AUTH_ENVIRONMENT }
  },
  instructions: memoryPrompt()
})

const validatedAttachment = (
  runtime: MemoryRuntime,
  selection: SelectedMemory
): Effect.Effect<MemoryAttachment | null> =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const issued = yield* requestGrant(runtime, selection).pipe(Effect.either)
      if (Either.isLeft(issued)) return null
      const discovery = yield* discoverGrant(
        runtime,
        issued.right,
        selection.organizationId
      ).pipe(Effect.either)
      if (Either.isRight(discovery)) {
        return attachmentFrom(runtime, issued.right, selection.organizationId)
      }
      if (discovery.left.status !== 401) return null
    }
    return null
  })

const selectedMemory = Effect.gen(function* () {
  const config = yield* ConfigService.get().pipe(Effect.orElseSucceed(() => null))
  const memory = config?.memory ?? MEMORY_CONFIG_DEFAULT
  const organizationId = memory.organizationId
  if (!memory.enabled || organizationId === null || organizationId.length === 0) return null
  const token = yield* (yield* SecretStore).get
  return token === null || token.length === 0 ? null : { organizationId, token }
})

const postDigest = (options: {
  readonly runtime: MemoryRuntime
  readonly selection: SelectedMemory
  readonly issued: MemoryGrantResponse
  readonly digestId: string
  readonly input: MemorySessionDigestInput
}): Effect.Effect<boolean> => {
  const { runtime, selection, issued, digestId, input } = options
  const content = memoryDigestContent(input)
  return Effect.tryPromise({
    try: async () => {
      const response = await runtime.fetchImplementation(
        endpoint(runtime.baseUrl(), "/api/memory/sources"),
        {
          method: "POST",
          headers: {
            ...scopedHeaders(issued.grant, selection.organizationId),
            "x-idempotency-key": digestId
          },
          body: JSON.stringify({
            source: {
              id: digestId,
              kind: "conversation",
              title: "Settled Jingler agent session",
              uri: `jingler://session-digest/${digestId.slice("session-digest:".length)}`,
              retrievedAt: input.settledAt,
              contentHash: sha256(content)
            },
            content,
            retrieval: safeRetrieval(input.retrieval)
          }),
          signal: AbortSignal.timeout(runtime.timeoutMs)
        }
      )
      return response.ok
    },
    catch: () => new MemoryRequestError({ status: 0 })
  }).pipe(Effect.orElseSucceed(() => false))
}

const captureDigest = (
  runtime: MemoryRuntime,
  selection: SelectedMemory,
  input: MemorySessionDigestInput
): Effect.Effect<boolean> => {
  const digestId = `session-digest:${sha256(`${selection.organizationId}\u0000${input.sessionId}\u0000${input.chatId}\u0000${input.turnId}`)}`
  const claim = Effect.sync(() => {
    if (runtime.captured.has(digestId) || runtime.capturing.has(digestId)) return false
    runtime.capturing.add(digestId)
    return true
  })
  return claim.pipe(
    Effect.flatMap((first) =>
      first
        ? requestGrant(runtime, selection).pipe(
            Effect.flatMap((issued) =>
              postDigest({ runtime, selection, issued, digestId, input })
            ),
            Effect.orElseSucceed(() => false),
            Effect.tap((captured) =>
              captured
                ? Effect.sync(() => {
                    runtime.captured.set(digestId, true)
                    if (runtime.captured.size > MAX_CAPTURED_DIGESTS) {
                      const oldest = runtime.captured.keys().next().value
                      if (oldest !== undefined) runtime.captured.delete(oldest)
                    }
                  })
                : Effect.void
            ),
            Effect.ensuring(Effect.sync(() => runtime.capturing.delete(digestId)))
          )
        : Effect.succeed(false)
    )
  )
}

export const makeMemoryService = (
  options: MemoryServiceOptions = {}
): MemoryServiceShape => {
  const runtime: MemoryRuntime = {
    fetchImplementation: options.fetch ?? fetch,
    baseUrl: options.baseUrl ?? configuredBaseUrl,
    nowSeconds: options.nowSeconds ?? (() => Math.floor(Date.now() / 1_000)),
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    captured: new Map<string, true>(),
    capturing: new Set<string>()
  }
  const attachment = (cli: CliKind) =>
    cli === "cursor"
      ? Effect.succeed(null)
      : selectedMemory.pipe(
      Effect.flatMap((selection) =>
        selection === null ? Effect.succeed(null) : validatedAttachment(runtime, selection)
      )
      )
  const captureSettledSession = (input: MemorySessionDigestInput) =>
    selectedMemory.pipe(
      Effect.flatMap((selection) =>
        selection === null ? Effect.succeed(false) : captureDigest(runtime, selection, input)
      )
    )

  const access = () =>
    selectedMemory.pipe(
      Effect.flatMap((selection) => {
        if (selection === null) return Effect.succeed(null)
        return requestGrant(runtime, selection).pipe(
          Effect.map(
            (issued): MemoryUiAccess => ({
              organizationId: selection.organizationId,
              role: roleFromPrivileges(issued.claims.privileges),
              privileges: issued.claims.privileges
            })
          ),
          Effect.orElseSucceed(() => null)
        )
      })
    )

  const uiRequest = (input: MemoryUiRequest) =>
    selectedMemory.pipe(
      Effect.flatMap((selection) => {
        if (selection === null) return Effect.succeed(null)
        const requested = { ...selection, organizationId: input.organizationId }
        return requestGrant(runtime, requested).pipe(
          Effect.flatMap((issued) => callMemoryTool(runtime, issued, input)),
          Effect.orElseSucceed(() => null)
        )
      })
    )

  return { attachment, captureSettledSession, access, uiRequest }
}

export class MemoryService extends Effect.Service<MemoryService>()("@jingler/MemoryService", {
  sync: () => makeMemoryService()
}) {}

export const MemoryServiceLive = MemoryService.Default
