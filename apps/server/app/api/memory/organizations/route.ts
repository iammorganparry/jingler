import { auth } from "../../../../src/auth.js"
import { listOrganizationMemoryAccess } from "../../../../src/db/repositories/organization-repository.js"
import { env } from "../../../../src/env.js"
import { runtime } from "../../../../src/runtime.js"

export const dynamic = "force-dynamic"

export const GET = async (request: Request): Promise<Response> => {
  if (!env.memoryEnabled) {
    return Response.json(
      { error: "Team memory is disabled" },
      { status: 503, headers: { "cache-control": "no-store" } }
    )
  }
  const session = await auth.api.getSession({ headers: request.headers }).catch(() => null)
  if (!session?.user.id) {
    return Response.json(
      { error: "Authentication required" },
      { status: 401, headers: { "cache-control": "no-store" } }
    )
  }
  const organizations = await runtime.runPromise(listOrganizationMemoryAccess(session.user.id))
  return Response.json(
    {
      organizations: organizations.map(({ organizationId: id, name, role, privileges }) => ({
        id,
        name,
        role,
        privileges
      }))
    },
    { headers: { "cache-control": "no-store" } }
  )
}
