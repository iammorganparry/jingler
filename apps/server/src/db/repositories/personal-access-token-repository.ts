/**
 * Read/write access to the `personal_access_token` table. All queries funnel
 * through `Database.run` for uniform error tagging, exactly like every other
 * repository. Writes here are the ONLY place PAT rows are mutated — routes never
 * touch Drizzle inline.
 *
 * Note the store never surfaces the plaintext token (there isn't one to surface;
 * only the hash is stored). `hashedToken` is projected only where the verifier
 * needs it for a constant-time compare.
 */
import { and, desc, eq } from "drizzle-orm"
import { Effect, Option } from "effect"
import { Database, type DatabaseError, type DrizzleClient } from "../database.js"
import { personalAccessToken } from "../schema.js"

export type PersonalAccessTokenRow = typeof personalAccessToken.$inferSelect
export type PersonalAccessTokenInsert = typeof personalAccessToken.$inferInsert

const repositoryFor = (database: Database) => {
  const findOne = (
    operation: string,
    query: (client: DrizzleClient) => Promise<Array<PersonalAccessTokenRow>>
  ): Effect.Effect<Option.Option<PersonalAccessTokenRow>, DatabaseError> =>
    database.run(operation, query).pipe(Effect.map((rows) => Option.fromNullable(rows[0])))

  return {
    create: (values: PersonalAccessTokenInsert): Effect.Effect<void, DatabaseError> =>
      database
        .run("PersonalAccessTokenRepository.create", (db) =>
          db.insert(personalAccessToken).values(values)
        )
        .pipe(Effect.asVoid),

    findByHash: (hashedToken: string) =>
      findOne("PersonalAccessTokenRepository.findByHash", (db) =>
        db
          .select()
          .from(personalAccessToken)
          .where(eq(personalAccessToken.hashedToken, hashedToken))
          .limit(1)
      ),

    findById: (id: string) =>
      findOne("PersonalAccessTokenRepository.findById", (db) =>
        db.select().from(personalAccessToken).where(eq(personalAccessToken.id, id)).limit(1)
      ),

    listByUser: (
      userId: string,
      organizationId?: string
    ): Effect.Effect<ReadonlyArray<PersonalAccessTokenRow>, DatabaseError> =>
      database.run("PersonalAccessTokenRepository.listByUser", (db) =>
        db
          .select()
          .from(personalAccessToken)
          .where(
            organizationId === undefined
              ? eq(personalAccessToken.userId, userId)
              : and(
                  eq(personalAccessToken.userId, userId),
                  eq(personalAccessToken.organizationId, organizationId)
                )
          )
          .orderBy(desc(personalAccessToken.createdAt))
      ),

    revoke: (id: string, at: Date): Effect.Effect<void, DatabaseError> =>
      database
        .run("PersonalAccessTokenRepository.revoke", (db) =>
          db
            .update(personalAccessToken)
            .set({ revokedAt: at })
            .where(eq(personalAccessToken.id, id))
        )
        .pipe(Effect.asVoid),

    touchLastUsed: (id: string, at: Date): Effect.Effect<void, DatabaseError> =>
      database
        .run("PersonalAccessTokenRepository.touchLastUsed", (db) =>
          db
            .update(personalAccessToken)
            .set({ lastUsedAt: at })
            .where(eq(personalAccessToken.id, id))
        )
        .pipe(Effect.asVoid)
  } as const
}

export class PersonalAccessTokenRepository
  extends Effect.Service<PersonalAccessTokenRepository>()(
    "@jingler/server/PersonalAccessTokenRepository",
    {
      accessors: true,
      effect: Effect.gen(function* () {
        return repositoryFor(yield* Database)
      })
    }
  ) {}
