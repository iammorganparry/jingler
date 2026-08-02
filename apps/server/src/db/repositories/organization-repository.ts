import {
  MemoryOrganizationRole,
  type MemoryOrganizationRole as MemoryOrganizationRoleType,
  type MemoryPrivilege,
  memoryPrivilegesForRole
} from "@jingler/core"
import { and, eq } from "drizzle-orm"
import { Effect, Option, Schema } from "effect"
import { Database, type DatabaseError } from "../database.js"
import { member, organization } from "../schema.js"

export interface OrganizationAuthorization {
  readonly organizationId: string
  readonly role: MemoryOrganizationRoleType
  readonly privileges: ReadonlyArray<MemoryPrivilege>
}

export interface OrganizationMemoryAccess extends OrganizationAuthorization {
  readonly name: string
}

const PaidPlan = Schema.Literal("team", "pro", "business", "enterprise")
const isPaidPlan = Schema.is(PaidPlan)

const OptionalString = Schema.optional(Schema.String)
const SubscriptionFields = Schema.Struct({
  plan: OptionalString,
  status: OptionalString,
  subscriptionStatus: OptionalString
})
/**
 * Canonical decode of the billing metadata. Excess keys are ignored, but every
 * status-bearing field we recognise is captured — top-level and nested — so a
 * cancelled status can never hide behind an active sibling. `Schema.Struct`
 * silently drops unlisted props, which is exactly how a cancelled subscription
 * used to slip through a `status`/`subscriptionStatus` union.
 */
const OrganizationMetadata = Schema.Struct({
  plan: OptionalString,
  status: OptionalString,
  subscriptionStatus: OptionalString,
  subscription: Schema.optional(SubscriptionFields)
})
const decodeMetadata = Schema.decodeUnknownEither(Schema.parseJson(OrganizationMetadata))

/**
 * Billing owns this metadata shape. Paid access requires (1) at least one paid
 * plan, (2) no non-paid plan anywhere, (3) at least one subscription status
 * field, and (4) EVERY status field present — top-level `status` /
 * `subscriptionStatus` and their `subscription.*` twins — equal to "active".
 * Missing, malformed, cancelled, free, and half-active metadata all fail closed.
 */
export const isActivePaidOrganizationMetadata = (metadata: string | null): boolean => {
  if (!metadata) return false
  const decoded = decodeMetadata(metadata)
  if (decoded._tag === "Left") return false
  const value = decoded.right
  const plans = [value.plan, value.subscription?.plan].filter(
    (plan): plan is string => plan !== undefined
  )
  const statuses = [
    value.status,
    value.subscriptionStatus,
    value.subscription?.status,
    value.subscription?.subscriptionStatus
  ].filter((status): status is string => status !== undefined)
  return (
    plans.length > 0 &&
    plans.every(isPaidPlan) &&
    statuses.length > 0 &&
    statuses.every((status) => status === "active")
  )
}

/**
 * Resolve a user's authorization for one exact organization. Both predicates
 * are in the SQL query, so a caller cannot substitute an arbitrary organization
 * id and inherit privileges from another membership.
 */
export const findOrganizationAuthorization = (
  userId: string,
  organizationId: string
): Effect.Effect<Option.Option<OrganizationAuthorization>, DatabaseError, Database> =>
  Effect.gen(function* () {
    const database = yield* Database
    const rows = yield* database.run("OrganizationRepository.findAuthorization", (db) =>
      db
        .select({
          organizationId: organization.id,
          role: member.role,
          metadata: organization.metadata
        })
        .from(member)
        .innerJoin(organization, eq(member.organizationId, organization.id))
        .where(and(eq(member.userId, userId), eq(organization.id, organizationId)))
        .limit(1)
    )
    const row = rows[0]
    if (!(row && isActivePaidOrganizationMetadata(row.metadata))) return Option.none()
    const role = Schema.decodeUnknownOption(MemoryOrganizationRole)(row.role)
    if (Option.isNone(role)) return Option.none()
    return Option.some({
      organizationId: row.organizationId,
      role: role.value,
      privileges: memoryPrivilegesForRole(role.value)
    })
  })

export const listOrganizationMemoryAccess = (
  userId: string
): Effect.Effect<ReadonlyArray<OrganizationMemoryAccess>, DatabaseError, Database> =>
  Effect.gen(function* () {
    const database = yield* Database
    const rows = yield* database.run("OrganizationRepository.listMemoryAccess", (db) =>
      db
        .select({
          organizationId: organization.id,
          name: organization.name,
          role: member.role,
          metadata: organization.metadata
        })
        .from(member)
        .innerJoin(organization, eq(member.organizationId, organization.id))
        .where(eq(member.userId, userId))
    )
    return rows.flatMap((row): ReadonlyArray<OrganizationMemoryAccess> => {
      if (!isActivePaidOrganizationMetadata(row.metadata)) return []
      const role = Schema.decodeUnknownOption(MemoryOrganizationRole)(row.role)
      return Option.isNone(role)
        ? []
        : [{
            organizationId: row.organizationId,
            name: row.name,
            role: role.value,
            privileges: memoryPrivilegesForRole(role.value)
          }]
    }).sort((left, right) => left.name.localeCompare(right.name) || left.organizationId.localeCompare(right.organizationId))
  })
