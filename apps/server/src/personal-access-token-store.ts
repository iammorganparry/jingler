/**
 * Promise-shaped adapters that bridge the Effect/Drizzle
 * `PersonalAccessTokenRepository` to the plain interfaces the PAT verifier and
 * management handlers depend on. Kept in one place so both the `/api/mcp` route
 * and the `/api/memory/tokens` routes share identical row→record/metadata
 * projections and the same paid-gate `authorize`.
 */
import { MemoryOrganizationRole } from "@jingler/core"
import { Option, Schema } from "effect"
import { findOrganizationAuthorization } from "./db/repositories/organization-repository.js"
import {
  PersonalAccessTokenRepository,
  type PersonalAccessTokenRow
} from "./db/repositories/personal-access-token-repository.js"
import type { OrganizationAuthorization } from "./db/repositories/organization-repository.js"
import { runtime } from "./runtime.js"
import type {
  PersonalAccessTokenManagementStore,
  PersonalAccessTokenMetadata
} from "./personal-access-token-management.js"
import type {
  CreatedPersonalAccessToken,
  PersonalAccessTokenRecord,
  PersonalAccessTokenStore
} from "./personal-access-token.js"

const decodeRole = Schema.decodeUnknownOption(MemoryOrganizationRole)

const toRecord = (row: PersonalAccessTokenRow): PersonalAccessTokenRecord | null => {
  const role = decodeRole(row.role)
  return Option.isNone(role)
    ? null
    : {
        id: row.id,
        userId: row.userId,
        organizationId: row.organizationId,
        role: role.value,
        hashedToken: row.hashedToken,
        expiresAt: row.expiresAt,
        revokedAt: row.revokedAt
      }
}

const toMetadata = (row: PersonalAccessTokenRow): PersonalAccessTokenMetadata | null => {
  const role = decodeRole(row.role)
  return Option.isNone(role)
    ? null
    : {
        id: row.id,
        userId: row.userId,
        organizationId: row.organizationId,
        name: row.name,
        role: role.value,
        createdAt: row.createdAt.toISOString(),
        expiresAt: row.expiresAt?.toISOString() ?? null,
        revokedAt: row.revokedAt?.toISOString() ?? null,
        lastUsedAt: row.lastUsedAt?.toISOString() ?? null
      }
}

/** Shared paid-membership gate: null unless an ACTIVE paid membership exists. */
export const authorizeOrganization = async (
  userId: string,
  organizationId: string
): Promise<OrganizationAuthorization | null> =>
  Option.getOrNull(
    await runtime.runPromise(findOrganizationAuthorization(userId, organizationId))
  )

/** Read side for the verifier (hash lookup + best-effort last-used stamp). */
export const personalAccessTokenVerifyStore: PersonalAccessTokenStore = {
  findByHash: async (hashedToken) =>
    Option.match(
      await runtime.runPromise(PersonalAccessTokenRepository.findByHash(hashedToken)),
      { onNone: () => null, onSome: toRecord }
    ),
  touchLastUsed: async (id, at) => {
    await runtime.runPromise(PersonalAccessTokenRepository.touchLastUsed(id, at))
  }
}

/** Read/write side for the session-gated management API. */
export const personalAccessTokenManagementStore: PersonalAccessTokenManagementStore = {
  create: async (record: CreatedPersonalAccessToken["record"]) => {
    await runtime.runPromise(PersonalAccessTokenRepository.create(record))
  },
  listByUser: async (userId, organizationId) => {
    const rows = await runtime.runPromise(
      PersonalAccessTokenRepository.listByUser(userId, organizationId)
    )
    return rows.flatMap((row) => {
      const metadata = toMetadata(row)
      return metadata ? [metadata] : []
    })
  },
  findById: async (id) =>
    Option.match(await runtime.runPromise(PersonalAccessTokenRepository.findById(id)), {
      onNone: () => null,
      onSome: (row) => ({
        id: row.id,
        userId: row.userId,
        revokedAt: row.revokedAt?.toISOString() ?? null
      })
    }),
  revoke: async (id, at) => {
    await runtime.runPromise(PersonalAccessTokenRepository.revoke(id, at))
  }
}
