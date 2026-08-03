import { env } from "../../../src/env.js"
import { createMemoryClient, JsonValue } from "../../../src/memory-client.js"
import { handleMemoryMcpRequest, rejectMemoryMcpGet } from "../../../src/mcp-memory.js"
import { verifyMemoryGrant } from "../../../src/memory-grant.js"
import { verifyPersonalAccessToken } from "../../../src/personal-access-token.js"
import {
  authorizeOrganization,
  personalAccessTokenVerifyStore
} from "../../../src/personal-access-token-store.js"

export const dynamic = "force-dynamic"

// Built lazily on first request: importing this route at build time
// (NODE_ENV=production with no secrets, as `next build` does) must never read
// env at module load. The lazy env accessor throws on a missing secret read, so
// deferring the client keeps the build import side-effect-free.
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
    return Promise.resolve(Response.json(
      { error: "Team memory is disabled" },
      { status: 503, headers: { "cache-control": "no-store" } }
    ))
  }
  return handleMemoryMcpRequest(request, {
    // Compose the two verifiers: an external client presents a `jmem_…` Personal
    // Access Token, which the PAT verifier resolves (re-checking revocation,
    // expiry and the paid-membership gate per request). For any other bearer the
    // PAT verifier returns null and we fall through to the desktop's short-lived
    // HMAC grant. Either yields the same `MemoryGrantClaims` the MCP pipeline
    // already understands; a rejected PAT throws → 401.
    verifyGrant: async (grant, organizationId) => {
      const patClaims = await verifyPersonalAccessToken(grant, organizationId, {
        store: personalAccessTokenVerifyStore,
        authorize: authorizeOrganization,
        audience: env.memoryGrantAudience,
        ttlSeconds: env.memoryGrantTtlSeconds
      })
      if (patClaims) return patClaims
      return verifyMemoryGrant(grant, {
        secret: env.memoryGrantSecret,
        audience: env.memoryGrantAudience,
        organizationId
      })
    },
    client: client()
  })
}

export const GET = rejectMemoryMcpGet
