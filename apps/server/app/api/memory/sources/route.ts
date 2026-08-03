import { randomUUID } from "node:crypto"
import { env } from "../../../../src/env.js"
import { createMemoryClient, JsonValue } from "../../../../src/memory-client.js"
import { verifyMemoryGrant } from "../../../../src/memory-grant.js"
import { handleMemorySourceRequest } from "../../../../src/memory-sources.js"

export const dynamic = "force-dynamic"

// Built lazily on first request so a build-time import (NODE_ENV=production, no
// secrets) never reads env at module load — see api/mcp/route.ts.
const makeClient = () =>
  createMemoryClient(
    {
      baseUrl: env.memoryWorkerUrl,
      serviceSecret: env.memoryWorkerServiceSecret,
      timeoutMs: env.memoryRequestTimeoutMs
    },
    JsonValue
  )
let cachedClient: ReturnType<typeof makeClient> | undefined
const client = (): ReturnType<typeof makeClient> => (cachedClient ??= makeClient())

export const POST = (request: Request): Promise<Response> => {
  if (!env.memoryEnabled) {
    return Promise.resolve(
      Response.json(
        { error: "Team memory is disabled" },
        { status: 503, headers: { "cache-control": "no-store", "x-request-id": randomUUID() } }
      )
    )
  }
  return handleMemorySourceRequest(request, {
    verifyGrant: (grant, organizationId) =>
      verifyMemoryGrant(grant, {
        secret: env.memoryGrantSecret,
        audience: env.memoryGrantAudience,
        organizationId
      }),
    client: client()
  })
}
