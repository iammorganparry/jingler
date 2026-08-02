import { env } from "../../../src/env.js"
import { createMemoryClient, JsonValue } from "../../../src/memory-client.js"
import { handleMemoryMcpRequest, rejectMemoryMcpGet } from "../../../src/mcp-memory.js"
import { verifyMemoryGrant } from "../../../src/memory-grant.js"

export const dynamic = "force-dynamic"

const client = createMemoryClient({
  baseUrl: env.memoryWorkerUrl,
  serviceSecret: env.memoryWorkerServiceSecret,
  timeoutMs: env.memoryRequestTimeoutMs
}, JsonValue)

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
    client
  })
}

export const GET = rejectMemoryMcpGet
