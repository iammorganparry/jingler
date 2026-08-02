/**
 * Settled-session source ingestion. Kept OUT of the Next.js route module because
 * Next 16 rejects value exports from a `route.ts` that are not route handlers —
 * the route file may only re-export `dynamic` + `POST`.
 */
import { randomUUID } from "node:crypto"
import {
  type MemoryGrantClaims,
  MemoryRetrievalSummary
} from "@jingler/core"
import { Effect, Schema } from "effect"
import { type JsonValue, type MemoryClient } from "./memory-client.js"

const MAX_SOURCE_CHARACTERS = 8_192

const MemorySourceRequest = Schema.Struct({
  source: Schema.Struct({
    id: Schema.String.pipe(Schema.startsWith("session-digest:")),
    kind: Schema.Literal("conversation"),
    title: Schema.String,
    uri: Schema.optional(Schema.String),
    retrievedAt: Schema.optional(Schema.String),
    contentHash: Schema.optional(Schema.String)
  }),
  content: Schema.String.pipe(Schema.maxLength(MAX_SOURCE_CHARACTERS)),
  retrieval: MemoryRetrievalSummary
})

const bearerFrom = (request: Request): string | null => {
  const authorization = request.headers.get("authorization")
  if (!authorization?.startsWith("Bearer ")) return null
  const bearer = authorization.slice("Bearer ".length)
  return bearer.length === 0 ? null : bearer
}

const json = (value: unknown, status: number, requestId: string): Response =>
  Response.json(value, {
    status,
    headers: { "cache-control": "no-store", "x-request-id": requestId }
  })

export interface MemorySourceRouteDependencies {
  readonly verifyGrant: (grant: string, organizationId: string) => MemoryGrantClaims
  readonly client: MemoryClient<JsonValue>
}

export const handleMemorySourceRequest = async (
  request: Request,
  dependencies: MemorySourceRouteDependencies
): Promise<Response> => {
  const requestId = request.headers.get("x-request-id") ?? randomUUID()
  const organizationId = request.headers.get("x-jingler-organization-id")
  const grant = bearerFrom(request)
  if (!(organizationId && grant)) {
    return json({ error: "Memory grant and organization scope required" }, 401, requestId)
  }

  let claims: MemoryGrantClaims
  try {
    claims = dependencies.verifyGrant(grant, organizationId)
  } catch {
    return json({ error: "Invalid memory grant" }, 401, requestId)
  }
  if (!claims.privileges.includes("propose")) {
    return json({ error: "Source capture requires propose privilege" }, 403, requestId)
  }

  let jsonBody: unknown
  try {
    jsonBody = await request.json()
  } catch {
    return json({ error: "Invalid JSON" }, 400, requestId)
  }
  const decoded = Schema.decodeUnknownEither(MemorySourceRequest)(jsonBody)
  if (decoded._tag === "Left") {
    return json({ error: "A source and content are required" }, 400, requestId)
  }
  const body = decoded.right
  const sourceId = body.source.id
  if (
    request.headers.get("x-idempotency-key") !== sourceId
  ) {
    return json({ error: "Invalid settled-session source digest" }, 400, requestId)
  }

  try {
    const result = await Effect.runPromise(
      dependencies.client.request({
        organizationId,
        requestId,
        method: "POST",
        path: "/internal/memory/sources",
        body: { source: body.source, content: body.content, retrieval: body.retrieval }
      })
    )
    return json(result, 201, requestId)
  } catch {
    return json({ error: "Private memory service request failed" }, 502, requestId)
  }
}
