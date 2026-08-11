import {
  EnvironmentCapabilities,
  type ManagedEnvironment,
  type ManagedEnvironmentInstanceType,
  type ManagedEnvironmentState
} from "@jingler/core"
import { and, asc, eq, isNull, sql } from "drizzle-orm"
import { Effect, Schema } from "effect"
import { Database, type DatabaseError } from "../database.js"
import { managedEnvironment } from "../schema.js"

export const MANAGED_ENVIRONMENT_LIST_LIMIT = 128

const projection = {
  id: managedEnvironment.id,
  userId: managedEnvironment.userId,
  displayName: managedEnvironment.displayName,
  state: managedEnvironment.state,
  region: managedEnvironment.region,
  instanceType: managedEnvironment.instanceType,
  capabilities: managedEnvironment.capabilities,
  generation: managedEnvironment.generation,
  createdAt: managedEnvironment.createdAt,
  updatedAt: managedEnvironment.updatedAt
}

type ManagedEnvironmentRow = {
  readonly id: string
  readonly userId: string
  readonly displayName: string
  readonly state: string
  readonly region: string | null
  readonly instanceType: string
  readonly capabilities: string
  readonly generation: number
  readonly createdAt: Date
  readonly updatedAt: Date
}

const stateFrom = (value: string): ManagedEnvironmentState => {
  switch (value) {
    case "provisioning":
    case "online":
    case "sleeping":
    case "restoring":
    case "paused":
    case "failed":
    case "revoked":
      return value
    default:
      return "failed"
  }
}

const instanceTypeFrom = (value: string): ManagedEnvironmentInstanceType =>
  value === "standard-1" ? "standard-1" : "basic"

const toRecord = (row: ManagedEnvironmentRow): ManagedEnvironment => ({
  kind: "managed",
  id: row.id,
  name: row.displayName,
  platform: { os: "linux", arch: "x64" },
  capabilities: Schema.decodeUnknownSync(EnvironmentCapabilities)(
    JSON.parse(row.capabilities)
  ),
  state: stateFrom(row.state),
  agentVersion: null,
  lastSeenAt: row.state === "online" ? Math.floor(row.updatedAt.getTime() / 1_000) : null,
  region: row.region,
  instanceType: instanceTypeFrom(row.instanceType),
  generation: row.generation,
  createdAt: Math.floor(row.createdAt.getTime() / 1_000),
  updatedAt: Math.floor(row.updatedAt.getTime() / 1_000)
})

export interface CreateManagedEnvironmentInput {
  readonly id: string
  readonly userId: string
  readonly displayName: string
  readonly region: string | null
  readonly instanceType: ManagedEnvironmentInstanceType
  readonly capabilities: ManagedEnvironment["capabilities"]
  readonly idempotencyKey: string
  readonly at: Date
}

const repositoryFor = (database: Database) => ({
  create: (
    input: CreateManagedEnvironmentInput
  ): Effect.Effect<ManagedEnvironment, DatabaseError> =>
    database
      .run("ManagedEnvironmentRepository.create", (db) =>
        db
          .insert(managedEnvironment)
          .values({
            id: input.id,
            userId: input.userId,
            displayName: input.displayName,
            state: "paused",
            region: input.region,
            instanceType: input.instanceType,
            capabilities: JSON.stringify(input.capabilities),
            generation: 1,
            idempotencyKey: input.idempotencyKey,
            createdAt: input.at,
            updatedAt: input.at,
            deletedAt: null
          })
          .onConflictDoUpdate({
            target: [managedEnvironment.userId, managedEnvironment.idempotencyKey],
            set: { idempotencyKey: sql`${managedEnvironment.idempotencyKey}` }
          })
          .returning(projection)
      )
      .pipe(
        Effect.flatMap((rows) => {
          const row = rows[0]
          return row
            ? Effect.succeed(toRecord(row))
            : Effect.dieMessage("Managed environment upsert returned no row")
        })
      ),

  listForUser: (
    userId: string
  ): Effect.Effect<ReadonlyArray<ManagedEnvironment>, DatabaseError> =>
    database
      .run("ManagedEnvironmentRepository.listForUser", (db) =>
        db
          .select(projection)
          .from(managedEnvironment)
          .where(
            and(
              eq(managedEnvironment.userId, userId),
              isNull(managedEnvironment.deletedAt)
            )
          )
          .orderBy(asc(managedEnvironment.createdAt), asc(managedEnvironment.id))
          .limit(MANAGED_ENVIRONMENT_LIST_LIMIT)
      )
      .pipe(Effect.map((rows) => rows.map(toRecord))),

  findForUser: (
    userId: string,
    environmentId: string
  ): Effect.Effect<ManagedEnvironment | null, DatabaseError> =>
    database
      .run("ManagedEnvironmentRepository.findForUser", (db) =>
        db
          .select(projection)
          .from(managedEnvironment)
          .where(
            and(
              eq(managedEnvironment.userId, userId),
              eq(managedEnvironment.id, environmentId),
              isNull(managedEnvironment.deletedAt)
            )
          )
          .limit(1)
      )
      .pipe(Effect.map((rows) => (rows[0] ? toRecord(rows[0]) : null))),

  renameForUser: (input: {
    readonly userId: string
    readonly environmentId: string
    readonly displayName: string
    readonly at: Date
  }): Effect.Effect<ManagedEnvironment | null, DatabaseError> =>
    database
      .run("ManagedEnvironmentRepository.renameForUser", (db) =>
        db
          .update(managedEnvironment)
          .set({ displayName: input.displayName, updatedAt: input.at })
          .where(
            and(
              eq(managedEnvironment.userId, input.userId),
              eq(managedEnvironment.id, input.environmentId),
              isNull(managedEnvironment.deletedAt)
            )
          )
          .returning(projection)
      )
      .pipe(Effect.map((rows) => (rows[0] ? toRecord(rows[0]) : null))),

  setStateForUser: (input: {
    readonly userId: string
    readonly environmentId: string
    readonly state: ManagedEnvironmentState
    readonly expectedGeneration: number
    readonly at: Date
  }): Effect.Effect<ManagedEnvironment | null, DatabaseError> =>
    database
      .run("ManagedEnvironmentRepository.setStateForUser", (db) =>
        db
          .update(managedEnvironment)
          .set({ state: input.state, updatedAt: input.at })
          .where(
            and(
              eq(managedEnvironment.userId, input.userId),
              eq(managedEnvironment.id, input.environmentId),
              eq(managedEnvironment.generation, input.expectedGeneration),
              isNull(managedEnvironment.deletedAt)
            )
          )
          .returning(projection)
      )
      .pipe(Effect.map((rows) => (rows[0] ? toRecord(rows[0]) : null))),

  deleteForUser: (input: {
    readonly userId: string
    readonly environmentId: string
    readonly expectedGeneration: number
    readonly at: Date
  }): Effect.Effect<ManagedEnvironment | null, DatabaseError> =>
    database
      .run("ManagedEnvironmentRepository.deleteForUser", (db) =>
        db
          .update(managedEnvironment)
          .set({
            state: "revoked",
            deletedAt: input.at,
            generation: sql`${managedEnvironment.generation} + 1`,
            updatedAt: input.at
          })
          .where(
            and(
              eq(managedEnvironment.userId, input.userId),
              eq(managedEnvironment.id, input.environmentId),
              eq(managedEnvironment.generation, input.expectedGeneration),
              isNull(managedEnvironment.deletedAt)
            )
          )
          .returning(projection)
      )
      .pipe(Effect.map((rows) => (rows[0] ? toRecord(rows[0]) : null)))
})

export class ManagedEnvironmentRepository extends Effect.Service<ManagedEnvironmentRepository>()(
  "@jingler/server/ManagedEnvironmentRepository",
  {
    accessors: true,
    effect: Effect.gen(function* () {
      return repositoryFor(yield* Database)
    })
  }
) {}
