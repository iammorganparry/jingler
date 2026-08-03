import { getAuth } from "../../../../../src/auth.js"
import { env } from "../../../../../src/env.js"
import {
  handleRevokePersonalAccessToken,
  type PersonalAccessTokenManagementDependencies
} from "../../../../../src/personal-access-token-management.js"
import {
  authorizeOrganization,
  personalAccessTokenManagementStore
} from "../../../../../src/personal-access-token-store.js"

export const dynamic = "force-dynamic"

const disabled = (): Response =>
  Response.json(
    { error: "Team memory is disabled" },
    { status: 503, headers: { "cache-control": "no-store" } }
  )

const dependencies = (): PersonalAccessTokenManagementDependencies => ({
  getUserId: async (headers) => {
    const session = await getAuth().api.getSession({ headers })
    return session?.user.id ?? null
  },
  authorize: authorizeOrganization,
  store: personalAccessTokenManagementStore
})

const revoke = async (
  request: Request,
  context: { readonly params: Promise<{ readonly id: string }> }
): Promise<Response> => {
  if (!env.memoryEnabled) return disabled()
  const { id } = await context.params
  return handleRevokePersonalAccessToken(request, id, dependencies())
}

// Both verbs revoke the same token; DELETE is canonical, POST is offered for
// clients that cannot send a DELETE body/verb.
export const DELETE = revoke
export const POST = revoke
