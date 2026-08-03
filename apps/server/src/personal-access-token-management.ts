/**
 * Session-gated management API for Personal Access Tokens: create, list, revoke.
 * Kept OUT of the `route.ts` modules (Next 16 rejects non-handler value exports
 * from a route file) and deps-injected so it is testable without a live DB or
 * BetterAuth session — the same seam the grant route and MCP route use.
 *
 * Authority rules:
 *  - Every operation requires a signed-in user (`getUserId`).
 *  - Create requires the caller to be an active PAID member of the target org
 *    (the SAME `findOrganizationAuthorization` gate the grant route enforces),
 *    and the minted role can never exceed the caller's live membership.
 *  - List and revoke only ever see the caller's OWN tokens; a token id owned by
 *    someone else is indistinguishable from a missing one (404), so ids don't
 *    leak across users.
 */
import {
  MemoryOrganizationRole,
  type MemoryOrganizationRole as MemoryOrganizationRoleType,
  memoryPrivilegesForRole
} from "@jingler/core"
import { Schema } from "effect"
import type { OrganizationAuthorization } from "./db/repositories/organization-repository.js"
import {
  type CreatedPersonalAccessToken,
  createPersonalAccessToken
} from "./personal-access-token.js"

/** Metadata safe to return in a list — NEVER the token or its hash. */
export interface PersonalAccessTokenMetadata {
  readonly id: string
  readonly userId: string
  readonly organizationId: string
  readonly name: string
  readonly role: MemoryOrganizationRoleType
  readonly createdAt: string
  readonly expiresAt: string | null
  readonly revokedAt: string | null
  readonly lastUsedAt: string | null
}

/** Ownership/lifecycle facts the revoke path needs — again, no secret material. */
export interface PersonalAccessTokenOwnership {
  readonly id: string
  readonly userId: string
  readonly revokedAt: string | null
}

export interface PersonalAccessTokenManagementStore {
  readonly create: (record: CreatedPersonalAccessToken["record"]) => Promise<void>
  readonly listByUser: (
    userId: string,
    organizationId?: string
  ) => Promise<ReadonlyArray<PersonalAccessTokenMetadata>>
  readonly findById: (id: string) => Promise<PersonalAccessTokenOwnership | null>
  readonly revoke: (id: string, at: Date) => Promise<void>
}

export interface PersonalAccessTokenManagementDependencies {
  readonly getUserId: (headers: Headers) => Promise<string | null>
  readonly authorize: (
    userId: string,
    organizationId: string
  ) => Promise<OrganizationAuthorization | null>
  readonly store: PersonalAccessTokenManagementStore
  readonly now?: () => Date
}

const json = (body: unknown, status: number): Response =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } })

const CreateTokenRequest = Schema.Struct({
  organizationId: Schema.String.pipe(Schema.minLength(1)),
  name: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(200)),
  role: Schema.optional(MemoryOrganizationRole),
  // ISO-8601 expiry; omitted / null → a non-expiring token.
  expiresAt: Schema.optional(Schema.Union(Schema.String, Schema.Null))
})

const parseCreate = async (
  request: Request
): Promise<Schema.Schema.Type<typeof CreateTokenRequest> | null> => {
  try {
    return Schema.decodeUnknownSync(CreateTokenRequest)(await request.json())
  } catch {
    return null
  }
}

const isSubset = (
  candidate: MemoryOrganizationRoleType,
  membership: MemoryOrganizationRoleType
): boolean => {
  const allowed = memoryPrivilegesForRole(membership)
  return memoryPrivilegesForRole(candidate).every((privilege) => allowed.includes(privilege))
}

export const handleCreatePersonalAccessToken = async (
  request: Request,
  dependencies: PersonalAccessTokenManagementDependencies
): Promise<Response> => {
  const userId = await dependencies.getUserId(request.headers)
  if (!userId) return json({ error: "Authentication required" }, 401)

  const parsed = await parseCreate(request)
  if (!parsed) return json({ error: "organizationId and name are required" }, 400)

  const name = parsed.name.trim()
  if (!name) return json({ error: "name must contain visible characters" }, 400)

  const now = dependencies.now?.() ?? new Date()
  const expiresAt = parsed.expiresAt ? new Date(parsed.expiresAt) : null
  if (expiresAt && Number.isNaN(expiresAt.getTime())) {
    return json({ error: "expiresAt must be an ISO-8601 timestamp" }, 400)
  }
  if (expiresAt && expiresAt.getTime() <= now.getTime()) {
    return json({ error: "expiresAt must be in the future" }, 400)
  }

  const authorization = await dependencies.authorize(userId, parsed.organizationId)
  if (!authorization) return json({ error: "Paid organization membership required" }, 403)

  // Default to the caller's own role; a requested role may only be LOWER.
  const role = parsed.role ?? authorization.role
  if (!isSubset(role, authorization.role)) {
    return json({ error: "Requested role exceeds your membership" }, 403)
  }

  const created = createPersonalAccessToken(
    {
      userId,
      organizationId: authorization.organizationId,
      name,
      role,
      expiresAt
    },
    { now: () => now }
  )
  await dependencies.store.create(created.record)

  // The plaintext token is returned HERE and only here.
  return json(
    {
      token: created.token,
      id: created.record.id,
      organizationId: created.record.organizationId,
      name: created.record.name,
      role: created.record.role,
      createdAt: created.record.createdAt.toISOString(),
      expiresAt: created.record.expiresAt?.toISOString() ?? null
    },
    201
  )
}

export const handleListPersonalAccessTokens = async (
  request: Request,
  dependencies: PersonalAccessTokenManagementDependencies
): Promise<Response> => {
  const userId = await dependencies.getUserId(request.headers)
  if (!userId) return json({ error: "Authentication required" }, 401)

  const organizationId =
    new URL(request.url).searchParams.get("organizationId") ?? undefined
  const tokens = await dependencies.store.listByUser(userId, organizationId)
  return json({ tokens }, 200)
}

export const handleRevokePersonalAccessToken = async (
  request: Request,
  tokenId: string,
  dependencies: PersonalAccessTokenManagementDependencies
): Promise<Response> => {
  const userId = await dependencies.getUserId(request.headers)
  if (!userId) return json({ error: "Authentication required" }, 401)

  const record = await dependencies.store.findById(tokenId)
  // A token owned by another user is indistinguishable from a missing one.
  if (!record || record.userId !== userId) {
    return json({ error: "Token not found" }, 404)
  }
  if (record.revokedAt) return json({ id: tokenId, revoked: true }, 200)

  await dependencies.store.revoke(tokenId, dependencies.now?.() ?? new Date())
  return json({ id: tokenId, revoked: true }, 200)
}
