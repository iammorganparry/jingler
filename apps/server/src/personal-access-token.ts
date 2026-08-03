/**
 * Personal Access Tokens (PATs) for the hosted team-memory MCP endpoint.
 *
 * A PAT is a long-lived, organization-scoped bearer credential that lets an
 * EXTERNAL agent (CI, a headless script, a third-party client) call `/api/mcp`
 * WITHOUT the desktop app minting a short-lived HMAC grant. It carries the same
 * `MemoryGrantClaims` shape the rest of the MCP pipeline already understands, so
 * `mcp-memory.ts` never learns that a request authenticated with a PAT rather
 * than a grant.
 *
 * Security invariants (mirrors `memory-grant.ts`, but for a credential that can
 * live for months):
 *  - The plaintext token is `jmem_` + ≥32 crypto-random bytes (base64url). It is
 *    returned exactly ONCE from `createPersonalAccessToken` and is NEVER stored
 *    or logged — only its SHA-256 hash (hex) is persisted.
 *  - Because PATs are long-lived, revocation, expiry AND the paid-membership gate
 *    are re-evaluated on EVERY request inside `verifyPersonalAccessToken`. The
 *    synthesized claims' short TTL is a belt-and-braces cache bound, never the
 *    authority — the authority is the live per-request check.
 *  - Hash comparison is constant-time.
 *
 * This module is pure (crypto + a store/authorize interface it is handed); the
 * Drizzle-backed store and BetterAuth session gate are wired in the route layer,
 * exactly as `mcp-memory.test.ts` injects a fake client + verifier.
 */
import {
  MemoryGrantClaims,
  type MemoryOrganizationRole,
  type MemoryPrivilege,
  memoryPrivilegesForRole
} from "@jingler/core"
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto"
import { Schema } from "effect"
import type { OrganizationAuthorization } from "./db/repositories/organization-repository.js"

/** Every PAT plaintext starts with this so the MCP route can route by prefix. */
export const PERSONAL_ACCESS_TOKEN_PREFIX = "jmem_"

/** True when a bearer is shaped like a PAT (so a grant otherwise falls through). */
export const isPersonalAccessToken = (bearer: string): boolean =>
  bearer.startsWith(PERSONAL_ACCESS_TOKEN_PREFIX)

/** SHA-256 hex of the FULL token string (prefix included). Never reversible. */
export const hashPersonalAccessToken = (token: string): string =>
  createHash("sha256").update(token).digest("hex")

const constantTimeHexEqual = (left: string, right: string): boolean => {
  const leftBytes = Buffer.from(left, "hex")
  const rightBytes = Buffer.from(right, "hex")
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes)
}

export type PersonalAccessTokenFailureReason =
  | "not-found"
  | "revoked"
  | "expired"
  | "wrong-organization"
  | "unauthorized"

export class PersonalAccessTokenError extends Error {
  readonly reason: PersonalAccessTokenFailureReason

  constructor(reason: PersonalAccessTokenFailureReason) {
    super(`Personal access token rejected: ${reason}`)
    this.name = "PersonalAccessTokenError"
    this.reason = reason
  }
}

/** The persisted, hash-only view of a token the verifier reads back. */
export interface PersonalAccessTokenRecord {
  readonly id: string
  readonly userId: string
  readonly organizationId: string
  readonly role: MemoryOrganizationRole
  readonly hashedToken: string
  readonly expiresAt: Date | null
  readonly revokedAt: Date | null
}

/**
 * The read side the verifier depends on. Injected so tests use a fake, mirroring
 * how `mcp-memory.test.ts` injects a fake `MemoryClient`. `touchLastUsed` is a
 * best-effort, fire-and-forget write and MAY be omitted (tests do).
 */
export interface PersonalAccessTokenStore {
  readonly findByHash: (hashedToken: string) => Promise<PersonalAccessTokenRecord | null>
  readonly touchLastUsed?: (id: string, at: Date) => Promise<void>
}

export interface VerifyPersonalAccessTokenDependencies {
  readonly store: PersonalAccessTokenStore
  /**
   * The SAME paid-gate + membership check the grant route uses
   * (`findOrganizationAuthorization`). Re-run per request so a revoked plan or a
   * removed member is rejected even while the token itself is otherwise valid.
   */
  readonly authorize: (
    userId: string,
    organizationId: string
  ) => Promise<OrganizationAuthorization | null>
  readonly audience: string
  /** Synthetic-claims TTL (a cache bound only; not the authority). */
  readonly ttlSeconds: number
  readonly now?: () => Date
}

const intersectPrivileges = (
  tokenPrivileges: ReadonlyArray<MemoryPrivilege>,
  membershipPrivileges: ReadonlyArray<MemoryPrivilege>
): ReadonlyArray<MemoryPrivilege> =>
  tokenPrivileges.filter((privilege) => membershipPrivileges.includes(privilege))

/**
 * Verify a bearer as a PAT.
 *
 *  - Returns `null` when the bearer is NOT `jmem_`-prefixed, so the MCP route
 *    falls through to `verifyMemoryGrant`.
 *  - Returns `MemoryGrantClaims` for a live, authorized token.
 *  - THROWS `PersonalAccessTokenError` for a PAT that is unknown, revoked,
 *    expired, org-mismatched, or whose membership no longer authorizes it — the
 *    route surfaces this as a 401.
 */
export const verifyPersonalAccessToken = async (
  bearer: string,
  organizationId: string,
  dependencies: VerifyPersonalAccessTokenDependencies
): Promise<MemoryGrantClaims | null> => {
  if (!isPersonalAccessToken(bearer)) return null

  const hashedToken = hashPersonalAccessToken(bearer)
  const record = await dependencies.store.findByHash(hashedToken)
  // Constant-time compare even though the lookup was by hash: never branch on a
  // partial-match timing side channel.
  if (!(record && constantTimeHexEqual(record.hashedToken, hashedToken))) {
    throw new PersonalAccessTokenError("not-found")
  }

  const now = dependencies.now?.() ?? new Date()
  if (record.revokedAt) throw new PersonalAccessTokenError("revoked")
  if (record.expiresAt && record.expiresAt.getTime() <= now.getTime()) {
    throw new PersonalAccessTokenError("expired")
  }
  // A PAT is minted for one exact organization; the request scope must match it.
  if (record.organizationId !== organizationId) {
    throw new PersonalAccessTokenError("wrong-organization")
  }

  // Long-lived credential → re-check the paid gate + membership on every request.
  const authorization = await dependencies.authorize(record.userId, organizationId)
  if (!authorization) throw new PersonalAccessTokenError("unauthorized")

  // The token can never exceed the live membership: intersect its minted role's
  // privileges with what the membership currently allows.
  const privileges = intersectPrivileges(
    memoryPrivilegesForRole(record.role),
    authorization.privileges
  )
  if (privileges.length === 0) throw new PersonalAccessTokenError("unauthorized")

  // Best-effort last-used stamp; a bookkeeping failure must not fail auth. Await
  // it so serverless runtimes do not discard the write when the response ends.
  try {
    await dependencies.store.touchLastUsed?.(record.id, now)
  } catch {
    // Authentication remains authoritative even when usage bookkeeping fails.
  }

  const nowSeconds = Math.floor(now.getTime() / 1_000)
  return Schema.decodeUnknownSync(MemoryGrantClaims)({
    version: 1,
    issuer: "jingler",
    audience: dependencies.audience,
    subject: record.userId,
    organizationId,
    privileges: [...privileges],
    issuedAt: nowSeconds,
    expiresAt: nowSeconds + dependencies.ttlSeconds,
    grantId: `pat-${record.id}`
  })
}

/** The row to persist plus the plaintext to hand back to the caller ONCE. */
export interface CreatedPersonalAccessToken {
  /** Plaintext `jmem_…`. Return to the caller exactly once; never store or log. */
  readonly token: string
  readonly record: {
    readonly id: string
    readonly userId: string
    readonly organizationId: string
    readonly name: string
    readonly hashedToken: string
    readonly role: MemoryOrganizationRole
    readonly createdAt: Date
    readonly expiresAt: Date | null
    readonly revokedAt: null
    readonly lastUsedAt: null
  }
}

export interface CreatePersonalAccessTokenInput {
  readonly userId: string
  readonly organizationId: string
  readonly name: string
  readonly role: MemoryOrganizationRole
  readonly expiresAt?: Date | null
}

export interface CreatePersonalAccessTokenOptions {
  readonly id?: () => string
  /** Injectable secret source for tests; defaults to 32 crypto-random bytes. */
  readonly secret?: () => string
  readonly now?: () => Date
}

/**
 * Mint a new PAT. The plaintext is `jmem_` + base64url(≥32 random bytes) and is
 * returned once inside `token`; only `record.hashedToken` (its SHA-256 hex) is
 * ever persisted.
 */
export const createPersonalAccessToken = (
  input: CreatePersonalAccessTokenInput,
  options: CreatePersonalAccessTokenOptions = {}
): CreatedPersonalAccessToken => {
  const secret = options.secret?.() ?? randomBytes(32).toString("base64url")
  const token = `${PERSONAL_ACCESS_TOKEN_PREFIX}${secret}`
  const now = options.now?.() ?? new Date()
  return {
    token,
    record: {
      id: options.id?.() ?? randomUUID(),
      userId: input.userId,
      organizationId: input.organizationId,
      name: input.name,
      hashedToken: hashPersonalAccessToken(token),
      role: input.role,
      createdAt: now,
      expiresAt: input.expiresAt ?? null,
      revokedAt: null,
      lastUsedAt: null
    }
  }
}
