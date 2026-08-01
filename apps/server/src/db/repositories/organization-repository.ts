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

const PaidPlan = Schema.Literal("team", "pro", "business", "enterprise")
const ActiveSubscription = Schema.Union(
  Schema.Struct({ plan: PaidPlan, status: Schema.Literal("active") }),
  Schema.Struct({ plan: PaidPlan, subscriptionStatus: Schema.Literal("active") })
)
const ActivePaidOrganizationMetadata = Schema.Union(
  ActiveSubscription,
  Schema.Struct({ subscription: ActiveSubscription })
)

/**
 * Billing owns this metadata shape. Requiring both a paid plan and an active
 * status means missing, malformed, cancelled, and free metadata all fail closed.
 */
export const isActivePaidOrganizationMetadata = (metadata: string | null): boolean => {
  if (!metadata) return false
  return Schema.decodeUnknownEither(Schema.parseJson(ActivePaidOrganizationMetadata))(metadata)
    ._tag === "Right"
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
