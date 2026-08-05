import { randomUUID } from "node:crypto"
import { and, asc, eq, isNull, lte, sql } from "drizzle-orm"
import { Effect, Option } from "effect"
import { Database, type DatabaseError, type DrizzleClient } from "../database.js"
import { githubSessionRoute, githubSessionRouteOutbox } from "../schema.js"

export type GitHubSessionRouteState = "active" | "archived" | "removed"

export interface GitHubSessionRouteRecord {
  readonly id: string
  readonly userId: string
  readonly sessionId: string
  readonly relaySessionId: string
  readonly installationId: string
  readonly repositoryId: string
  readonly pullRequestNumber: number
  readonly state: GitHubSessionRouteState
  readonly generation: number
  readonly archivedAt: Date | null
  readonly unlinkedAt: Date | null
  readonly createdAt: Date
  readonly updatedAt: Date
}

export interface GitHubSessionRouteMutation {
  readonly id: string
  readonly userId: string
  readonly relaySessionId: string
  readonly installationId: string
  readonly repositoryId: string
  readonly pullRequestNumber: number
  readonly desiredState: GitHubSessionRouteState
  readonly generation: number
  readonly attemptCount: number
}

const routeState = (value: string): GitHubSessionRouteState =>
  value === "active" || value === "archived" ? value : "removed"

const toRoute = (row: typeof githubSessionRoute.$inferSelect): GitHubSessionRouteRecord => ({
  ...row,
  state: routeState(row.state)
})

const toMutation = (
  row: typeof githubSessionRouteOutbox.$inferSelect
): GitHubSessionRouteMutation => ({
  id: row.id,
  userId: row.userId,
  relaySessionId: row.relaySessionId,
  installationId: row.installationId,
  repositoryId: row.repositoryId,
  pullRequestNumber: row.pullRequestNumber,
  desiredState: routeState(row.desiredState),
  generation: row.generation,
  attemptCount: row.attemptCount
})

const queueMutation = async (
  tx: Pick<DrizzleClient, "insert">,
  route: GitHubSessionRouteRecord,
  state: GitHubSessionRouteState,
  at: Date
): Promise<void> => {
  const id = randomUUID()
  await tx
    .insert(githubSessionRouteOutbox)
    .values({
      id,
      userId: route.userId,
      relaySessionId: route.relaySessionId,
      installationId: route.installationId,
      repositoryId: route.repositoryId,
      pullRequestNumber: route.pullRequestNumber,
      desiredState: state,
      generation: route.generation,
      attemptCount: 0,
      nextAttemptAt: at,
      deliveredAt: null,
      lastError: null,
      createdAt: at,
      updatedAt: at
    })
    .onConflictDoNothing()
}

const repositoryFor = (database: Database) => ({
  listByUserId: (
    userId: string
  ): Effect.Effect<ReadonlyArray<GitHubSessionRouteRecord>, DatabaseError> =>
    database
      .run("GitHubSessionRouteRepository.listByUserId", (db) =>
        db
          .select()
          .from(githubSessionRoute)
          .where(eq(githubSessionRoute.userId, userId))
          .orderBy(asc(githubSessionRoute.createdAt))
      )
      .pipe(Effect.map((rows) => rows.map(toRoute))),

  findForUser: (userId: string, relaySessionId: string) =>
    database
      .run("GitHubSessionRouteRepository.findForUser", (db) =>
        db
          .select()
          .from(githubSessionRoute)
          .where(
            and(
              eq(githubSessionRoute.userId, userId),
              eq(githubSessionRoute.relaySessionId, relaySessionId)
            )
          )
          .limit(1)
      )
      .pipe(Effect.map((rows) => Option.fromNullable(rows[0]).pipe(Option.map(toRoute)))),

  upsertActive: (input: {
    readonly userId: string
    readonly sessionId: string
    readonly relaySessionId: string
    readonly installationId: string
    readonly repositoryId: string
    readonly pullRequestNumber: number
    readonly at: Date
  }): Effect.Effect<GitHubSessionRouteRecord, DatabaseError> =>
    database
      .run("GitHubSessionRouteRepository.upsertActive", (db) =>
        db.transaction(async (tx) => {
          const previousRows = await tx
            .select()
            .from(githubSessionRoute)
            .where(
              and(
                eq(githubSessionRoute.userId, input.userId),
                eq(githubSessionRoute.sessionId, input.sessionId)
              )
            )
            .limit(1)
          const previous = previousRows[0] ? toRoute(previousRows[0]) : null
          const identityChanged =
            previous !== null &&
            (previous.installationId !== input.installationId ||
              previous.repositoryId !== input.repositoryId ||
              previous.pullRequestNumber !== input.pullRequestNumber)
          const generationIncrement = identityChanged && previous.state !== "removed" ? 2 : 1
          const rows = await tx
            .insert(githubSessionRoute)
            .values({
              id: randomUUID(),
              userId: input.userId,
              sessionId: input.sessionId,
              relaySessionId: input.relaySessionId,
              installationId: input.installationId,
              repositoryId: input.repositoryId,
              pullRequestNumber: input.pullRequestNumber,
              state: "active",
              generation: 1,
              archivedAt: null,
              unlinkedAt: null,
              createdAt: input.at,
              updatedAt: input.at
            })
            .onConflictDoUpdate({
              target: [githubSessionRoute.userId, githubSessionRoute.sessionId],
              set: {
                relaySessionId: identityChanged
                  ? input.relaySessionId
                  : (previous?.relaySessionId ?? input.relaySessionId),
                installationId: input.installationId,
                repositoryId: input.repositoryId,
                pullRequestNumber: input.pullRequestNumber,
                state: "active",
                generation: sql`${githubSessionRoute.generation} + ${generationIncrement}`,
                archivedAt: null,
                unlinkedAt: null,
                updatedAt: input.at
              }
            })
            .returning()
          const row = rows[0]
          if (!row) throw new Error("GitHub session route upsert returned no row")
          const route = toRoute(row)
          if (identityChanged && previous?.state !== "removed") {
            await queueMutation(
              tx,
              { ...previous, generation: route.generation - 1 },
              "removed",
              input.at
            )
          }
          await queueMutation(tx, route, "active", input.at)
          return route
        })
      ),

  setState: (input: {
    readonly userId: string
    readonly relaySessionId: string
    readonly state: "archived" | "removed"
    readonly at: Date
  }): Effect.Effect<Option.Option<GitHubSessionRouteRecord>, DatabaseError> =>
    database
      .run("GitHubSessionRouteRepository.setState", (db) =>
        db.transaction(async (tx) => {
          const rows = await tx
            .update(githubSessionRoute)
            .set({
              state: input.state,
              archivedAt: input.state === "archived" ? input.at : null,
              unlinkedAt: input.state === "removed" ? input.at : null,
              generation: sql`${githubSessionRoute.generation} + 1`,
              updatedAt: input.at
            })
            .where(
              and(
                eq(githubSessionRoute.userId, input.userId),
                eq(githubSessionRoute.relaySessionId, input.relaySessionId)
              )
            )
            .returning()
          const row = rows[0]
          if (!row) return null
          const route = toRoute(row)
          await queueMutation(tx, route, input.state, input.at)
          return route
        })
      )
      .pipe(Effect.map((row) => Option.fromNullable(row))),

  removeAllForUser: (userId: string, at: Date): Effect.Effect<void, DatabaseError> =>
    database
      .run("GitHubSessionRouteRepository.removeAllForUser", (db) =>
        db.transaction(async (tx) => {
          const rows = await tx
            .update(githubSessionRoute)
            .set({
              state: "removed",
              archivedAt: null,
              unlinkedAt: at,
              generation: sql`${githubSessionRoute.generation} + 1`,
              updatedAt: at
            })
            .where(eq(githubSessionRoute.userId, userId))
            .returning()
          for (const row of rows) await queueMutation(tx, toRoute(row), "removed", at)
        })
      )
      .pipe(Effect.asVoid),

  listPendingMutations: (
    at: Date,
    limit = 50
  ): Effect.Effect<ReadonlyArray<GitHubSessionRouteMutation>, DatabaseError> =>
    database
      .run("GitHubSessionRouteRepository.listPendingMutations", (db) =>
        db
          .select()
          .from(githubSessionRouteOutbox)
          .where(
            and(
              isNull(githubSessionRouteOutbox.deliveredAt),
              lte(githubSessionRouteOutbox.nextAttemptAt, at)
            )
          )
          .orderBy(
            asc(githubSessionRouteOutbox.nextAttemptAt),
            asc(githubSessionRouteOutbox.relaySessionId),
            asc(githubSessionRouteOutbox.generation)
          )
          .limit(Math.max(1, Math.min(limit, 100)))
      )
      .pipe(Effect.map((rows) => rows.map(toMutation))),

  markMutationDelivered: (id: string, deliveredAt: Date): Effect.Effect<void, DatabaseError> =>
    database
      .run("GitHubSessionRouteRepository.markMutationDelivered", (db) =>
        db
          .update(githubSessionRouteOutbox)
          .set({ deliveredAt, lastError: null, updatedAt: deliveredAt })
          .where(eq(githubSessionRouteOutbox.id, id))
      )
      .pipe(Effect.asVoid),

  markMutationFailed: (input: {
    readonly id: string
    readonly retryAt: Date
    readonly updatedAt: Date
    readonly error: string
  }): Effect.Effect<void, DatabaseError> =>
    database
      .run("GitHubSessionRouteRepository.markMutationFailed", (db) =>
        db
          .update(githubSessionRouteOutbox)
          .set({
            attemptCount: sql`${githubSessionRouteOutbox.attemptCount} + 1`,
            nextAttemptAt: input.retryAt,
            lastError: input.error.slice(0, 200),
            updatedAt: input.updatedAt
          })
          .where(eq(githubSessionRouteOutbox.id, input.id))
      )
      .pipe(Effect.asVoid)
})

export class GitHubSessionRouteRepository extends Effect.Service<GitHubSessionRouteRepository>()(
  "@jingler/server/GitHubSessionRouteRepository",
  {
    accessors: true,
    effect: Effect.gen(function* () {
      return repositoryFor(yield* Database)
    })
  }
) {}
