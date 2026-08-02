import { env } from "../../../src/env.js"
import { createMemoryClient, JsonValue } from "../../../src/memory-client.js"
import { handleMemoryMcpRequest, rejectMemoryMcpGet } from "../../../src/mcp-memory.js"
import { verifyMemoryGrant } from "../../../src/memory-grant.js"

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
    verifyGrant: (grant, organizationId) =>
      verifyMemoryGrant(grant, {
        secret: env.memoryGrantSecret,
        audience: env.memoryGrantAudience,
        organizationId
      }),
    client: client()
  })
}

export const GET = rejectMemoryMcpGet
