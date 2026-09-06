import { and, eq, gte, inArray, lt, sql, sum } from "drizzle-orm"
import { Effect } from "effect"
import { Database, type DatabaseError } from "../database.js"
import { managedUsageReservation } from "../schema.js"

export interface ManagedUsagePolicy {
  readonly maxConcurrentSessions: number
  readonly maxActiveSeconds: number
  readonly dailyBudgetMicrousd: number
  readonly maxEgressBytes: number
  readonly maxCheckpointBytes: number
  readonly checkpointRetentionSeconds: number
}

export const DEFAULT_MANAGED_USAGE_POLICY: ManagedUsagePolicy = {
  maxConcurrentSessions: 1,
  maxActiveSeconds: 7_200,
  dailyBudgetMicrousd: 200_000,
  maxEgressBytes: 100 * 1024 * 1024,
  maxCheckpointBytes: 64 * 1024 * 1024,
  checkpointRetentionSeconds: 7 * 24 * 60 * 60
}

/** Published basic-instance ceiling: memory + disk + 100% active CPU. */
export const basicInstanceCeilingMicrousd = (seconds: number): number =>
  Math.ceil((28_000 * seconds) / 3_600)

export type ManagedUsageAdmission =
  | { readonly admitted: true; readonly estimatedMicrousd: number }
  | { readonly admitted: false; readonly reason: "concurrency" | "daily-budget" }

export const admitManagedUsage = (input: {
  readonly policy: ManagedUsagePolicy
  readonly activeReservations: number
  readonly committedMicrousd: number
}): ManagedUsageAdmission => {
  if (input.activeReservations >= input.policy.maxConcurrentSessions) {
    return { admitted: false, reason: "concurrency" }
  }
  const estimatedMicrousd = basicInstanceCeilingMicrousd(
    input.policy.maxActiveSeconds
  )
  if (input.committedMicrousd + estimatedMicrousd > input.policy.dailyBudgetMicrousd) {
    return { admitted: false, reason: "daily-budget" }
  }
  return { admitted: true, estimatedMicrousd }
}

export type ManagedUsageReservationResult =
  | { readonly status: "reserved" | "existing"; readonly reservationId: string }
  | { readonly status: "denied"; readonly reason: "concurrency" | "daily-budget" }

const repositoryFor = (database: Database) => ({
  reserve: (input: {
    readonly id: string
    readonly userId: string
    readonly environmentId: string
    readonly sessionId: string
    readonly idempotencyKey: string
    readonly policy: ManagedUsagePolicy
    readonly now: Date
  }): Effect.Effect<ManagedUsageReservationResult, DatabaseError> =>
    database.run("ManagedUsageRepository.reserve", (db) =>
      db.transaction(async (tx) => {
        // Serialize admissions for one account without scanning or locking other users.
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${input.userId}, 0))`)
        const existing = await tx
          .select({
            id: managedUsageReservation.id,
            state: managedUsageReservation.state
          })
          .from(managedUsageReservation)
          .where(and(
            eq(managedUsageReservation.userId, input.userId),
            eq(managedUsageReservation.idempotencyKey, input.idempotencyKey)
          ))
          .limit(1)
        if (
          existing[0] &&
          !["released", "expired"].includes(existing[0].state)
        ) {
          return { status: "existing", reservationId: existing[0].id } as const
        }

        // Commands are metered as one lifecycle interval per managed session.
        // Follow-up input and cancellation must reuse that interval instead of
        // consuming another account concurrency slot.
        const activeForSession = await tx
          .select({ id: managedUsageReservation.id })
          .from(managedUsageReservation)
          .where(and(
            eq(managedUsageReservation.userId, input.userId),
            eq(managedUsageReservation.sessionId, input.sessionId),
            inArray(managedUsageReservation.state, ["reserved", "active"])
          ))
          .orderBy(managedUsageReservation.createdAt)
          .limit(1)
        if (activeForSession[0]) {
          return {
            status: "existing",
            reservationId: activeForSession[0].id
          } as const
        }

        const reserveNewUsageInterval = async (): Promise<ManagedUsageReservationResult> => {
          const windowStart = new Date(input.now)
          windowStart.setUTCHours(0, 0, 0, 0)
          const rows = await tx
            .select({
              activeReservations: sum(sql<number>`case when ${managedUsageReservation.state} in ('reserved', 'active') then 1 else 0 end`),
              committedMicrousd: sum(sql<number>`coalesce(${managedUsageReservation.settledMicrousd}, ${managedUsageReservation.estimatedMicrousd})`)
            })
            .from(managedUsageReservation)
            .where(and(
              eq(managedUsageReservation.userId, input.userId),
              gte(managedUsageReservation.windowStart, windowStart),
              inArray(managedUsageReservation.state, ["reserved", "active", "settled"])
            ))
          const current = rows[0]
          const decision = admitManagedUsage({
            policy: input.policy,
            activeReservations: Number(current?.activeReservations ?? 0),
            committedMicrousd: Number(current?.committedMicrousd ?? 0)
          })
          if (!decision.admitted) return { status: "denied", reason: decision.reason } as const
          const expiresAt = new Date(input.now.getTime() + input.policy.maxActiveSeconds * 1_000)
          if (existing[0]) {
            await tx.update(managedUsageReservation)
              .set({
                state: "reserved",
                windowStart,
                estimatedMicrousd: decision.estimatedMicrousd,
                settledMicrousd: null,
                updatedAt: input.now,
                expiresAt
              })
              .where(eq(managedUsageReservation.id, existing[0].id))
            return { status: "reserved", reservationId: existing[0].id } as const
          }
          await tx.insert(managedUsageReservation).values({
            id: input.id,
            userId: input.userId,
            environmentId: input.environmentId,
            sessionId: input.sessionId,
            runtimeId: null,
            state: "reserved",
            windowStart,
            estimatedMicrousd: decision.estimatedMicrousd,
            settledMicrousd: null,
            idempotencyKey: input.idempotencyKey,
            createdAt: input.now,
            updatedAt: input.now,
            expiresAt
          })
          return { status: "reserved", reservationId: input.id } as const
        }
        return reserveNewUsageInterval()
      })
    ),

  settle: (input: {
    readonly userId: string
    readonly reservationId: string
    readonly settledMicrousd: number
    readonly now: Date
  }): Effect.Effect<void, DatabaseError> =>
    database.run("ManagedUsageRepository.settle", (db) =>
      db.update(managedUsageReservation)
        .set({ state: "settled", settledMicrousd: input.settledMicrousd, updatedAt: input.now })
        .where(and(
          eq(managedUsageReservation.id, input.reservationId),
          eq(managedUsageReservation.userId, input.userId),
          inArray(managedUsageReservation.state, ["reserved", "active"])
        ))
    ).pipe(Effect.asVoid),

  release: (input: {
    readonly userId: string
    readonly reservationId: string
    readonly now: Date
  }): Effect.Effect<void, DatabaseError> =>
    database.run("ManagedUsageRepository.release", (db) =>
      db.update(managedUsageReservation)
        .set({ state: "released", updatedAt: input.now })
        .where(and(
          eq(managedUsageReservation.id, input.reservationId),
          eq(managedUsageReservation.userId, input.userId),
          eq(managedUsageReservation.state, "reserved")
        ))
    ).pipe(Effect.asVoid),

  releaseReservedForSession: (input: {
    readonly userId: string
    readonly environmentId: string
    readonly sessionId: string
    readonly now: Date
  }): Effect.Effect<void, DatabaseError> =>
    database.run("ManagedUsageRepository.releaseReservedForSession", (db) =>
      db.update(managedUsageReservation)
        .set({ state: "released", updatedAt: input.now })
        .where(and(
          eq(managedUsageReservation.userId, input.userId),
          eq(managedUsageReservation.environmentId, input.environmentId),
          eq(managedUsageReservation.sessionId, input.sessionId),
          eq(managedUsageReservation.state, "reserved")
        ))
    ).pipe(Effect.asVoid),

  reclaimExpired: (now: Date): Effect.Effect<number, DatabaseError> =>
    database.run("ManagedUsageRepository.reclaimExpired", async (db) => {
      const due = await db
        .select({ id: managedUsageReservation.id })
        .from(managedUsageReservation)
        .where(and(
          lt(managedUsageReservation.expiresAt, now),
          inArray(managedUsageReservation.state, ["reserved", "active"])
        ))
        .orderBy(managedUsageReservation.expiresAt, managedUsageReservation.id)
        .limit(256)
      if (due.length === 0) return 0
      await db.update(managedUsageReservation)
        .set({ state: "expired", updatedAt: now })
        .where(inArray(managedUsageReservation.id, due.map((row) => row.id)))
      return due.length
    })
})

export class ManagedUsageRepository extends Effect.Service<ManagedUsageRepository>()(
  "@jingler/server/ManagedUsageRepository",
  {
    accessors: true,
    effect: Effect.gen(function* () {
      return repositoryFor(yield* Database)
    })
  }
) {}
