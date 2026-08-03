import { getAuth } from "../../../../src/auth.js"
import { env } from "../../../../src/env.js"
import {
  handleCreatePersonalAccessToken,
  handleListPersonalAccessTokens,
  type PersonalAccessTokenManagementDependencies
} from "../../../../src/personal-access-token-management.js"
import {
  authorizeOrganization,
  personalAccessTokenManagementStore
} from "../../../../src/personal-access-token-store.js"

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

export const POST = (request: Request): Promise<Response> =>
  env.memoryEnabled
    ? handleCreatePersonalAccessToken(request, dependencies())
    : Promise.resolve(disabled())

export const GET = (request: Request): Promise<Response> =>
  env.memoryEnabled
    ? handleListPersonalAccessTokens(request, dependencies())
    : Promise.resolve(disabled())
