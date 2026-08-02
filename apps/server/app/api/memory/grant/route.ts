import { auth } from "../../../../src/auth.js"
import { findOrganizationAuthorization } from "../../../../src/db/repositories/organization-repository.js"
import { env } from "../../../../src/env.js"
import { handleMemoryGrantRequest, issueMemoryGrant } from "../../../../src/memory-grant.js"
import { runtime } from "../../../../src/runtime.js"
import { Option } from "effect"

export const dynamic = "force-dynamic"

export const POST = (request: Request): Promise<Response> => {
  if (!env.memoryEnabled) {
    return Promise.resolve(Response.json(
      { error: "Team memory is disabled" },
      { status: 503, headers: { "cache-control": "no-store" } }
    ))
  }
  return handleMemoryGrantRequest(request, {
    getUserId: async (headers) => {
      const session = await auth.api.getSession({ headers })
      return session?.user.id ?? null
    },
    authorize: async (userId, organizationId) => {
      const authorization = await runtime.runPromise(
        findOrganizationAuthorization(userId, organizationId)
      )
      return Option.getOrNull(authorization)
    },
    issue: (userId, authorization, purpose) =>
      issueMemoryGrant(
        {
          subject: userId,
          organizationId: authorization.organizationId,
          privileges: authorization.privileges
        },
        {
          secret: env.memoryGrantSecret,
          audience: env.memoryGrantAudience,
          // A static MCP attachment header lives for the length of an agent turn;
          // the short capture/UI TTL would 401 mid-run. Server-authoritative so the
          // desktop can't inflate it.
          ttlSeconds:
            purpose === "attachment"
              ? env.memoryAttachmentGrantTtlSeconds
              : env.memoryGrantTtlSeconds
        }
      )
  })
}
