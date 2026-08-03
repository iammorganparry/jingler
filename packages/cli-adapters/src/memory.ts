import { createHash } from "node:crypto"
import path from "node:path"
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
  MemoryGrantResponse as MemoryGrantResponseSchema,
  MemoryRetrievalSummary as MemoryRetrievalSummarySchema,
  MemoryOrganizationRole as MemoryOrganizationRoleSchema,
  MemoryPrivilege as MemoryPrivilegeSchema
} from "@jingler/core"
import { FileSystem } from "@effect/platform"
import { Data, Effect, Either, Schema } from "effect"
import type { RemoteMcpServer } from "./adapter.js"
import { AppPaths, type AppPathsShape } from "./app-paths.js"
import { ConfigService } from "./config.js"
import { memoryPrompt } from "./memory-prompt.js"
import { SecretStore } from "./secret-store.js"

const MEMORY_SERVER_NAME = "jingler-memory"
const MEMORY_AUTH_ENVIRONMENT = "JINGLER_MEMORY_AUTHORIZATION"
const DEFAULT_TIMEOUT_MS = 1_500
// UI reads (dashboard/graph/export/suggestions) hop through the Next.js server,
// which budgets MEMORY_REQUEST_TIMEOUT_MS (5s) for its own call to the Worker; a
// cold Durable Object or a large vault can consume most of it. The desktop must
// therefore wait LONGER than that downstream budget, or every heavier read would
// abort locally and surface as "Team memory is unavailable". The short
// DEFAULT_TIMEOUT_MS stays for the fail-open attachment/capture paths, where a
// slow hop must never block an agent turn.
const UI_REQUEST_TIMEOUT_MS = 8_000
const MAX_DIGEST_CHARACTERS = 8_000
// Reuse a minted grant until it is within this many seconds of expiry, so the
// clock skew / in-flight-request window still leaves a valid grant. The 401
// eviction path (below) covers server-side revocation and expiry races.
const GRANT_REFRESH_MARGIN_SECONDS = 30
const ATTACHMENT_BACKGROUND_REFRESH_SECONDS = 5 * 60
// A capture that keeps failing to deliver is dropped rather than re-attempted on
// every drain forever — bounded by attempt count and by age.
const MAX_CAPTURE_ATTEMPTS = 5
const MAX_CAPTURE_AGE_SECONDS = 7 * 24 * 60 * 60
const MCP_TOOL_PREFIX_PATTERN = /^mcp__jingler-memory__/
const LEADING_SLASH_PATTERN = /^\/+/
const PRIVATE_KEY_PATTERN = /-----BEGIN [^-\r\n]+-----[\s\S]*?-----END [^-\r\n]+-----/g
const AUTH_HEADER_PATTERN = /(?:^|\b)(authorization|proxy-authorization|cookie|set-cookie|mcp-session-id)\s*:\s*[^\r\n]*(?:\r?\n[ \t]+[^\r\n]*)*/gim
const AUTH_INLINE_PATTERN = /\b(authorization|proxy-authorization|mcp-session-id)\s*:\s*(?:bearer\s+)?[^\s,;]+/gi
const AUTH_VALUE_PATTERN = /\b(authorization|proxy-authorization|mcp-session-id)\s*=\s*(?:bearer\s+)?[^\s,;]+/gi
const CREDENTIAL_VALUE_PATTERN = /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|session[_-]?token|private[_-]?key|password|passwd|secret)\s*[:=]\s*["']?[^\s,"';]+["']?/gi
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
  /**
   * Fetch advisory relatedness suggestions. A separate, explicit access path — the
   * grant is minted and consumed in the main process, so it never reaches the
   * renderer. Advisory-only: the result is never an accepted graph edge.
   */
  readonly suggestions: (
    input: MemorySuggestionsRequest
  ) => Effect.Effect<unknown | null, never, MemoryServiceEnvironment>
}

export interface MemorySuggestionsRequest {
  readonly organizationId: string
  readonly limit?: number
  readonly pageId?: string
}

export interface MemoryUiAccess {
  readonly selectedOrganizationId: string | null
  readonly organizations: ReadonlyArray<{
    readonly id: string
    readonly name: string
    readonly role: MemoryOrganizationRole
    readonly privileges: ReadonlyArray<MemoryPrivilege>
  }>
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
  /** Timeout for interactive UI reads; defaults to UI_REQUEST_TIMEOUT_MS. */
  readonly uiTimeoutMs?: number
}

interface MemoryRuntime {
  readonly fetchImplementation: typeof fetch
  readonly baseUrl: () => string
  readonly nowSeconds: () => number
  readonly timeoutMs: number
  readonly uiTimeoutMs: number
  readonly queuedCaptures: Set<string>
  readonly outboxLock: Effect.Semaphore
  /** One reusable grant per organization; never leaves the main process. */
  readonly grantCache: Map<string, MemoryGrantResponse>
  /** Serializes mint-and-cache so parallel UI requests share one grant. */
  readonly grantLock: Effect.Semaphore
  /** Validated static MCP attachment per organization and source bearer. */
  readonly attachmentCache: Map<string, CachedMemoryAttachment>
  readonly attachmentLock: Effect.Semaphore
  readonly attachmentRefreshes: Set<string>
  draining: boolean
}

interface CachedMemoryAttachment {
  readonly attachment: MemoryAttachment
  readonly expiresAt: number
  readonly tokenHash: string
}

interface MemoryCaptureJob {
  readonly id: string
  readonly organizationId: string
  readonly settledAt: string
  readonly content: string
  readonly retrieval: MemoryRetrievalSummary
  /** Delivery attempts so far; drives the dead-job drop below. */
  readonly attempts: number
  /** Unix seconds the job was first enqueued; drives the max-age drop. */
  readonly firstSeenAt: number
}

const MemoryCaptureJob = Schema.Struct({
  id: Schema.String,
  organizationId: Schema.String,
  settledAt: Schema.String,
  content: Schema.String,
  retrieval: MemoryRetrievalSummarySchema,
  // Optional-with-default so outbox files written before this field existed
  // still decode. Missing firstSeenAt (0) is treated as "unknown" by the drain.
  attempts: Schema.optionalWith(Schema.Int, { default: () => 0 }),
  firstSeenAt: Schema.optionalWith(Schema.Int, { default: () => 0 })
})
const MemoryCaptureOutbox = Schema.Array(MemoryCaptureJob)

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
      .replace(AUTH_HEADER_PATTERN, (_match, label: string) => `${label}: ${REDACTED_VALUE}`)
      .replace(AUTH_INLINE_PATTERN, (_match, label: string) => `${label}: ${REDACTED_VALUE}`)
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
  schema: Schema.Schema<A, I>,
  timeoutMs: number = runtime.timeoutMs
): Effect.Effect<A, MemoryRequestError> =>
  Effect.tryPromise({
    try: async () => {
      const response = await runtime.fetchImplementation(endpoint(runtime.baseUrl(), path), {
        ...init,
        signal: AbortSignal.timeout(timeoutMs)
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
  selection: SelectedMemory,
  timeoutMs: number = runtime.uiTimeoutMs
): Effect.Effect<MemoryGrantResponse, MemoryRequestError> =>
  requestJson(
    runtime,
    "/api/memory/grant",
    {
      method: "POST",
      headers: grantHeaders(selection.token),
      body: JSON.stringify({
        organizationId: selection.organizationId
      })
    },
    MemoryGrantResponseSchema,
    timeoutMs
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

/**
 * Reuse the cached grant for an organization until it nears expiry, minting a
 * fresh one only when absent or stale. The mint is serialized so the renderer's
 * burst of parallel UI requests (dashboard/graph/reviews/search) issues a single
 * grant per org rather than one per operation. The cache is keyed strictly by
 * organizationId — grants never cross organizations — and stays main-process
 * only. Callers evict on a failed tool call so revocation self-heals.
 */
const cachedGrant = (
  runtime: MemoryRuntime,
  selection: SelectedMemory
): Effect.Effect<MemoryGrantResponse, MemoryRequestError> =>
  runtime.grantLock.withPermits(1)(
    Effect.suspend(() => {
      const cached = runtime.grantCache.get(selection.organizationId)
      if (
        cached !== undefined &&
        cached.claims.expiresAt - GRANT_REFRESH_MARGIN_SECONDS > runtime.nowSeconds()
      ) {
        return Effect.succeed(cached)
      }
      return requestGrant(runtime, selection).pipe(
        Effect.tap((issued) =>
          Effect.sync(() => runtime.grantCache.set(selection.organizationId, issued))
        )
      )
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
    MemoryMcpToolResponse,
    runtime.uiTimeoutMs
  ).pipe(Effect.map((response) => response.result.structuredContent.data))

// TODO(memory-proxy): this bakes a single grant into a static MCP header for the
// whole turn, which is why the attachment grant needs the longer server-side TTL.
// Once memory MCP routes through a main-process proxy that mints/refreshes a
// per-request grant, this static header (and the extended TTL) can go away.
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
): Effect.Effect<CachedMemoryAttachment | null> =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const issued = yield* requestGrant(runtime, selection, runtime.timeoutMs).pipe(Effect.either)
      if (Either.isLeft(issued)) return null
      const discovery = yield* discoverGrant(
        runtime,
        issued.right,
        selection.organizationId
      ).pipe(Effect.either)
      if (Either.isRight(discovery)) {
        return {
          attachment: attachmentFrom(runtime, issued.right, selection.organizationId),
          expiresAt: issued.right.claims.expiresAt,
          tokenHash: sha256(selection.token)
        }
      }
      if (discovery.left.status !== 401) return null
    }
    return null
  })

const refreshAttachmentInBackground = (
  runtime: MemoryRuntime,
  selection: SelectedMemory
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const claimed = yield* Effect.sync(() => {
      if (runtime.attachmentRefreshes.has(selection.organizationId)) return false
      runtime.attachmentRefreshes.add(selection.organizationId)
      return true
    })
    if (!claimed) return
    yield* validatedAttachment(runtime, selection).pipe(
      Effect.tap((entry) =>
        entry === null
          ? Effect.void
          : Effect.sync(() => runtime.attachmentCache.set(selection.organizationId, entry))
      ),
      Effect.ensuring(
        Effect.sync(() => runtime.attachmentRefreshes.delete(selection.organizationId))
      ),
      Effect.forkDaemon
    )
  })

const cachedAttachment = (
  runtime: MemoryRuntime,
  selection: SelectedMemory
): Effect.Effect<MemoryAttachment | null> =>
  runtime.attachmentLock.withPermits(1)(
    Effect.gen(function* () {
      const cached = runtime.attachmentCache.get(selection.organizationId)
      const remaining = (cached?.expiresAt ?? 0) - runtime.nowSeconds()
      if (
        cached !== undefined &&
        cached.tokenHash === sha256(selection.token) &&
        remaining > GRANT_REFRESH_MARGIN_SECONDS
      ) {
        if (remaining <= ATTACHMENT_BACKGROUND_REFRESH_SECONDS) {
          yield* refreshAttachmentInBackground(runtime, selection)
        }
        return cached.attachment
      }
      const refreshed = yield* validatedAttachment(runtime, selection)
      if (refreshed === null) {
        runtime.attachmentCache.delete(selection.organizationId)
        return null
      }
      runtime.attachmentCache.set(selection.organizationId, refreshed)
      return refreshed.attachment
    })
  )

const selectedMemory = Effect.gen(function* () {
  const config = yield* ConfigService.get().pipe(Effect.orElseSucceed(() => null))
  const memory = config?.memory ?? MEMORY_CONFIG_DEFAULT
  const organizationId = memory.organizationId
  if (!memory.enabled || organizationId === null || organizationId.length === 0) return null
  const token = yield* (yield* SecretStore).get
  return token === null || token.length === 0 ? null : { organizationId, token }
})

const MemoryOrganizationsResponse = Schema.Struct({
  organizations: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      role: MemoryOrganizationRoleSchema,
      privileges: Schema.Array(MemoryPrivilegeSchema)
    })
  )
})

const memoryToken = Effect.gen(function* () {
  const token = yield* (yield* SecretStore).get
  return token === null || token.length === 0 ? null : token
})

const postDigest = (options: {
  readonly runtime: MemoryRuntime
  readonly selection: SelectedMemory
  readonly issued: MemoryGrantResponse
  readonly digestId: string
  readonly input: MemorySessionDigestInput
  readonly content: string
}): Effect.Effect<boolean> => {
  const { runtime, selection, issued, digestId, input, content } = options
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

const outboxFile = (paths: AppPathsShape): string =>
  path.join(paths.root, "memory-capture-outbox.json")

const readOutbox = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const paths = yield* AppPaths
  const file = outboxFile(paths)
  if (!(yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false)))) return []
  const raw = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => "[]"))
  return yield* Schema.decodeUnknown(Schema.parseJson(MemoryCaptureOutbox))(raw).pipe(
    Effect.orElseSucceed(() => [])
  )
})

const writeOutbox = (jobs: ReadonlyArray<MemoryCaptureJob>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const paths = yield* AppPaths
    const file = outboxFile(paths)
    const temporary = `${file}.tmp`
    yield* fs.makeDirectory(paths.root, { recursive: true })
    yield* fs.writeFileString(temporary, `${JSON.stringify(jobs)}\n`)
    yield* fs.rename(temporary, file)
  })

type EnqueueOutcome = "stored" | "duplicate" | "failed"

const enqueueCapture = (
  runtime: MemoryRuntime,
  job: MemoryCaptureJob
) =>
  runtime.outboxLock.withPermits(1)(
    Effect.gen(function* () {
      const jobs = yield* readOutbox
      if (jobs.some((candidate) => candidate.id === job.id)) return "duplicate" as const
      yield* writeOutbox([...jobs, job])
      return "stored" as const
    })
  ).pipe(Effect.orElseSucceed(() => "failed" as const))

const drainCaptureOutbox = (runtime: MemoryRuntime, token: string) =>
  Effect.gen(function* () {
    if (runtime.draining) return
    runtime.draining = true
    // Snapshot under the lock, then send UNLOCKED so a concurrent enqueue is not
    // blocked for the length of the network round-trips.
    const jobs = yield* runtime.outboxLock.withPermits(1)(readOutbox)
    const now = runtime.nowSeconds()
    // Delivered ids to remove, permanently-dead ids to drop, and the bumped
    // attempt counts for ids that should be retried later.
    const sent = new Set<string>()
    const dropped = new Set<string>()
    const retried = new Map<string, number>()
    for (const job of jobs) {
      const selection = { organizationId: job.organizationId, token }
      const outcome = yield* requestGrant(runtime, selection).pipe(
        Effect.flatMap((issued) =>
          postDigest({
            runtime,
            selection,
            issued,
            digestId: job.id,
            content: job.content,
            input: {
              sessionId: job.id,
              chatId: job.id,
              turnId: job.id,
              cli: "codex",
              userText: "",
              assistantText: job.content,
              settledAt: job.settledAt,
              retrieval: job.retrieval
            }
          }).pipe(Effect.map((ok) => (ok ? ("sent" as const) : ("failed" as const))))
        ),
        // A 403 on the grant means the user has lost membership of this org —
        // the job can never succeed, so drop it. Any other transient error is a
        // retry candidate, bounded by attempts/age below.
        Effect.catchAll((error) =>
          Effect.succeed(error.status === 403 ? ("forbidden" as const) : ("failed" as const))
        )
      )
      if (outcome === "sent") {
        sent.add(job.id)
      } else if (outcome === "forbidden") {
        dropped.add(job.id)
      } else {
        const attempts = job.attempts + 1
        const firstSeenAt = job.firstSeenAt > 0 ? job.firstSeenAt : now
        if (attempts >= MAX_CAPTURE_ATTEMPTS || now - firstSeenAt > MAX_CAPTURE_AGE_SECONDS) {
          dropped.add(job.id)
        } else {
          retried.set(job.id, attempts)
        }
      }
    }
    // Re-read under the lock so captures enqueued mid-drain are preserved rather
    // than clobbered by a stale snapshot: remove delivered/dropped ids and bump
    // the attempt count on ids kept for a later retry.
    if (sent.size > 0 || dropped.size > 0 || retried.size > 0) {
      yield* runtime.outboxLock.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* readOutbox
          const next = current
            .filter((candidate) => !sent.has(candidate.id) && !dropped.has(candidate.id))
            .map((candidate) => {
              const attempts = retried.get(candidate.id)
              return attempts === undefined
                ? candidate
                : {
                    ...candidate,
                    attempts,
                    firstSeenAt: candidate.firstSeenAt > 0 ? candidate.firstSeenAt : now
                  }
            })
          yield* writeOutbox(next)
        })
      )
    }
  }).pipe(
    Effect.ensuring(Effect.sync(() => { runtime.draining = false })),
    Effect.ignore
  )

export const makeMemoryService = (
  options: MemoryServiceOptions = {}
): MemoryServiceShape => {
  const runtime: MemoryRuntime = {
    fetchImplementation: options.fetch ?? fetch,
    baseUrl: options.baseUrl ?? configuredBaseUrl,
    nowSeconds: options.nowSeconds ?? (() => Math.floor(Date.now() / 1_000)),
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    uiTimeoutMs: options.uiTimeoutMs ?? UI_REQUEST_TIMEOUT_MS,
    queuedCaptures: new Set<string>(),
    outboxLock: Effect.unsafeMakeSemaphore(1),
    grantCache: new Map<string, MemoryGrantResponse>(),
    grantLock: Effect.unsafeMakeSemaphore(1),
    attachmentCache: new Map<string, CachedMemoryAttachment>(),
    attachmentLock: Effect.unsafeMakeSemaphore(1),
    attachmentRefreshes: new Set<string>(),
    draining: false
  }
  const attachment = (cli: CliKind) =>
    cli === "cursor"
      ? Effect.succeed(null)
      : selectedMemory.pipe(
      Effect.flatMap((selection) =>
        selection === null ? Effect.succeed(null) : cachedAttachment(runtime, selection)
      )
      )
  const captureSettledSession = (input: MemorySessionDigestInput) =>
    selectedMemory.pipe(
      Effect.flatMap((selection) =>
        selection === null
          ? Effect.succeed(false)
          : Effect.gen(function* () {
              const id = `session-digest:${sha256(`${selection.organizationId}\u0000${input.sessionId}\u0000${input.chatId}\u0000${input.turnId}`)}`
              const claimed = yield* Effect.sync(() => {
                if (runtime.queuedCaptures.has(id)) return false
                runtime.queuedCaptures.add(id)
                return true
              })
              if (!claimed) return false
              const enqueued = yield* enqueueCapture(runtime, {
                id,
                organizationId: selection.organizationId,
                settledAt: input.settledAt,
                content: memoryDigestContent(input),
                retrieval: safeRetrieval(input.retrieval),
                attempts: 0,
                firstSeenAt: runtime.nowSeconds()
              })
              // A transient write failure persisted nothing, so release the
              // in-memory claim — otherwise this settled turn could never be
              // captured again for the lifetime of the process.
              if (enqueued === "failed") {
                yield* Effect.sync(() => runtime.queuedCaptures.delete(id))
                return false
              }
              if (enqueued === "duplicate") return false
              yield* drainCaptureOutbox(runtime, selection.token).pipe(Effect.forkDaemon)
              return true
            })
      )
    )

  const access = () =>
    Effect.all([memoryToken, ConfigService.get().pipe(Effect.orElseSucceed(() => null))]).pipe(
      Effect.flatMap(([token, config]) => {
        if (token === null) return Effect.succeed(null)
        return Effect.gen(function* () {
          yield* drainCaptureOutbox(runtime, token).pipe(Effect.forkDaemon)
          const organizations = yield* Effect.tryPromise({
            try: async () => {
              const response = await runtime.fetchImplementation(
                endpoint(runtime.baseUrl(), "/api/memory/organizations"),
                {
                  headers: { authorization: `Bearer ${token}` },
                  signal: AbortSignal.timeout(runtime.uiTimeoutMs)
                }
              )
              if (!response.ok) throw new MemoryRequestError({ status: response.status })
              return Schema.decodeUnknownSync(MemoryOrganizationsResponse)(await response.json())
                .organizations
            },
            catch: () => new MemoryRequestError({ status: 0 })
          }).pipe(Effect.orElseSucceed(() => null))
          if (organizations === null) return null

          // Engage team memory by DEFAULT. Every downstream hook — MCP attach,
          // <team-memory> prompt, settled-session capture — is already an
          // unconditional per-turn call gated only on `memory.enabled` + a selected
          // org. So the first time an eligible user is seen with exactly ONE org and
          // no explicit choice yet, enable it and select that org; the agents then
          // pick it up automatically. An explicit config (even `enabled: false`) is
          // always respected — this only fills the unset default.
          let selected = config?.memory?.enabled === true
            ? (config.memory.organizationId ?? null)
            : null
          const soleOrganization = organizations.length === 1 ? organizations[0] : null
          if (config?.memory === undefined && soleOrganization !== null && soleOrganization !== undefined) {
            selected = soleOrganization.id
            yield* ConfigService.setMemory({ enabled: true, organizationId: selected }).pipe(
              Effect.ignore
            )
          }

          return {
            selectedOrganizationId: organizations.some((item) => item.id === selected)
              ? selected
              : null,
            organizations
          }
        })
      })
    )

  const uiRequest = (input: MemoryUiRequest) =>
    selectedMemory.pipe(
      Effect.flatMap((selection) => {
        if (selection === null) return Effect.succeed(null)
        const requested = { ...selection, organizationId: input.organizationId }
        return cachedGrant(runtime, requested).pipe(
          Effect.flatMap((issued) => callMemoryTool(runtime, issued, input)),
          // Evict on any failure so a revoked/expired cached grant is re-minted
          // on the next request rather than replayed into another 401.
          Effect.tapError(() =>
            Effect.sync(() => runtime.grantCache.delete(input.organizationId))
          ),
          Effect.orElseSucceed(() => null)
        )
      })
    )

  const suggestions = (input: MemorySuggestionsRequest) =>
    uiRequest({
      organizationId: input.organizationId,
      name: "memory_suggestions",
      arguments: {
        ...(input.limit === undefined ? {} : { limit: input.limit }),
        ...(input.pageId === undefined ? {} : { pageId: input.pageId })
      }
    })

  return { attachment, captureSettledSession, access, uiRequest, suggestions }
}

export class MemoryService extends Effect.Service<MemoryService>()("@jingler/MemoryService", {
  sync: () => makeMemoryService()
}) {}

export const MemoryServiceLive = MemoryService.Default
