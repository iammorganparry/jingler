/**
 * Persistence boundary for the GitHub App product connection. BetterAuth's
 * `account` table is intentionally absent: social login and app authorization
 * have different credentials, lifecycles, and ownership.
 */
import { randomUUID } from "node:crypto"
import { and, eq, gt, inArray, isNull } from "drizzle-orm"
import { Effect, Option } from "effect"
import { Database, type DatabaseError, type DrizzleClient } from "../database.js"
import {
  githubCallbackState,
  githubInstallation,
  githubUserAuthorization
} from "../schema.js"

type AuthorizationRow = typeof githubUserAuthorization.$inferSelect
type CallbackStateRow = typeof githubCallbackState.$inferSelect

export type GitHubCallbackStateKind = "authorize" | "install"

export interface GitHubAuthorizationRecord {
  readonly id: string
  readonly userId: string
  readonly githubUserId: string
  readonly githubLogin: string
  readonly githubName: string | null
  readonly githubAvatarUrl: string | null
  readonly accessTokenEncrypted: string
  readonly refreshTokenEncrypted: string | null
  readonly accessTokenExpiresAt: Date | null
  readonly refreshTokenExpiresAt: Date | null
  readonly createdAt: Date
  readonly updatedAt: Date
  readonly lastRefreshedAt: Date
}

export interface GitHubInstallationRecord {
  readonly id: string
  readonly authorizationId: string
  readonly installationId: string
  readonly accountId: string
  readonly accountLogin: string
  readonly accountType: string
  readonly accountAvatarUrl: string | null
  readonly repositorySelection: "all" | "selected"
  readonly permissions: Readonly<Record<string, string>>
  readonly suspendedAt: Date | null
  readonly createdAt: Date
  readonly updatedAt: Date
}

export interface GitHubCallbackStateRecord {
  readonly id: string
  readonly userId: string
  readonly kind: GitHubCallbackStateKind
  readonly redirectUri: string
  readonly codeVerifierEncrypted: string
  readonly expiresAt: Date
  readonly consumedAt: Date | null
  readonly createdAt: Date
}

export interface SaveGitHubConnectionInput {
  readonly authorization: {
    readonly id: string
    readonly userId: string
    readonly githubUserId: string
    readonly githubLogin: string
    readonly githubName: string | null
    readonly githubAvatarUrl: string | null
    readonly accessTokenEncrypted: string
    readonly refreshTokenEncrypted: string | null
    readonly accessTokenExpiresAt: Date | null
    readonly refreshTokenExpiresAt: Date | null
  }
  readonly installations: ReadonlyArray<{
    readonly installationId: string
    readonly accountId: string
    readonly accountLogin: string
    readonly accountType: string
    readonly accountAvatarUrl: string | null
    readonly repositorySelection: "all" | "selected"
    readonly permissions: Readonly<Record<string, string>>
    readonly suspendedAt: Date | null
  }>
  readonly refreshedAt: Date
}

const toAuthorization = (row: AuthorizationRow): GitHubAuthorizationRecord => ({ ...row })

const parsePermissions = (raw: string): Readonly<Record<string, string>> => {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string"
      )
    )
  } catch {
    return {}
  }
}

const toInstallation = (
  row: typeof githubInstallation.$inferSelect
): GitHubInstallationRecord => ({
  ...row,
  repositorySelection: row.repositorySelection === "selected" ? "selected" : "all",
  permissions: parsePermissions(row.permissions)
})

const toCallbackState = (row: CallbackStateRow): GitHubCallbackStateRecord => ({
  ...row,
  kind: row.kind === "install" ? "install" : "authorize"
})

const repositoryFor = (database: Database) => {
  const findAuthorization = (
    operation: string,
    query: (client: DrizzleClient) => Promise<Array<AuthorizationRow>>
  ): Effect.Effect<Option.Option<GitHubAuthorizationRecord>, DatabaseError> =>
    database
      .run(operation, query)
      .pipe(
        Effect.map((rows) => Option.fromNullable(rows[0]).pipe(Option.map(toAuthorization)))
      )

  return {
    createCallbackState: (values: typeof githubCallbackState.$inferInsert) =>
      database
        .run("GitHubConnectionRepository.createCallbackState", (db) =>
          db.insert(githubCallbackState).values(values)
        )
        .pipe(Effect.asVoid),

    /**
     * The UPDATE is the replay lock. Hash, user, kind, expiry and unused status
     * are checked in one statement; a second caller receives None.
     */
    consumeCallbackState: (input: {
      readonly stateHash: string
      readonly userId: string
      readonly kinds: ReadonlyArray<GitHubCallbackStateKind>
      readonly at: Date
    }): Effect.Effect<Option.Option<GitHubCallbackStateRecord>, DatabaseError> =>
      database
        .run("GitHubConnectionRepository.consumeCallbackState", (db) =>
          db
            .update(githubCallbackState)
            .set({ consumedAt: input.at })
            .where(
              and(
                eq(githubCallbackState.stateHash, input.stateHash),
                eq(githubCallbackState.userId, input.userId),
                inArray(githubCallbackState.kind, [...input.kinds]),
                gt(githubCallbackState.expiresAt, input.at),
                isNull(githubCallbackState.consumedAt)
              )
            )
            .returning()
        )
        .pipe(
          Effect.map((rows) => Option.fromNullable(rows[0]).pipe(Option.map(toCallbackState)))
        ),

    findAuthorizationByUserId: (userId: string) =>
      findAuthorization("GitHubConnectionRepository.findAuthorizationByUserId", (db) =>
        db
          .select()
          .from(githubUserAuthorization)
          .where(eq(githubUserAuthorization.userId, userId))
          .limit(1)
      ),

    listInstallationsByAuthorizationId: (
      authorizationId: string
    ): Effect.Effect<ReadonlyArray<GitHubInstallationRecord>, DatabaseError> =>
      database
        .run("GitHubConnectionRepository.listInstallationsByAuthorizationId", (db) =>
          db
            .select()
            .from(githubInstallation)
            .where(eq(githubInstallation.authorizationId, authorizationId))
        )
        .pipe(Effect.map((rows) => rows.map(toInstallation))),

    findInstallationForUser: (userId: string, installationId: string) =>
      database
        .run("GitHubConnectionRepository.findInstallationForUser", (db) =>
          db
            .select({ installation: githubInstallation })
            .from(githubInstallation)
            .innerJoin(
              githubUserAuthorization,
              eq(githubInstallation.authorizationId, githubUserAuthorization.id)
            )
            .where(
              and(
                eq(githubUserAuthorization.userId, userId),
                eq(githubInstallation.installationId, installationId)
              )
            )
            .limit(1)
        )
        .pipe(
          Effect.map((rows) =>
            Option.fromNullable(rows[0]?.installation).pipe(Option.map(toInstallation))
          )
        ),

    /** Upsert authorization + replace the reconciled installation set atomically. */
    saveConnection: (
      input: SaveGitHubConnectionInput
    ): Effect.Effect<GitHubAuthorizationRecord, DatabaseError> =>
      database
        .run("GitHubConnectionRepository.saveConnection", (db) =>
          db.transaction(async (tx) => {
            const rows = await tx
              .insert(githubUserAuthorization)
              .values({
                ...input.authorization,
                createdAt: input.refreshedAt,
                updatedAt: input.refreshedAt,
                lastRefreshedAt: input.refreshedAt
              })
              .onConflictDoUpdate({
                target: githubUserAuthorization.userId,
                set: {
                  githubUserId: input.authorization.githubUserId,
                  githubLogin: input.authorization.githubLogin,
                  githubName: input.authorization.githubName,
                  githubAvatarUrl: input.authorization.githubAvatarUrl,
                  accessTokenEncrypted: input.authorization.accessTokenEncrypted,
                  refreshTokenEncrypted: input.authorization.refreshTokenEncrypted,
                  accessTokenExpiresAt: input.authorization.accessTokenExpiresAt,
                  refreshTokenExpiresAt: input.authorization.refreshTokenExpiresAt,
                  updatedAt: input.refreshedAt,
                  lastRefreshedAt: input.refreshedAt
                }
              })
              .returning()
            const authorization = rows[0]
            if (!authorization) throw new Error("GitHub authorization upsert returned no row")

            await tx
              .delete(githubInstallation)
              .where(eq(githubInstallation.authorizationId, authorization.id))
            if (input.installations.length > 0) {
              await tx.insert(githubInstallation).values(
                input.installations.map((installation) => ({
                  id: randomUUID(),
                  authorizationId: authorization.id,
                  installationId: installation.installationId,
                  accountId: installation.accountId,
                  accountLogin: installation.accountLogin,
                  accountType: installation.accountType,
                  accountAvatarUrl: installation.accountAvatarUrl,
                  repositorySelection: installation.repositorySelection,
                  permissions: JSON.stringify(installation.permissions),
                  suspendedAt: installation.suspendedAt,
                  createdAt: input.refreshedAt,
                  updatedAt: input.refreshedAt
                }))
              )
            }
            return authorization
          })
        )
        .pipe(Effect.map(toAuthorization)),

    replaceInstallations: (input: {
      readonly authorizationId: string
      readonly installations: SaveGitHubConnectionInput["installations"]
      readonly refreshedAt: Date
    }): Effect.Effect<void, DatabaseError> =>
      database
        .run("GitHubConnectionRepository.replaceInstallations", (db) =>
          db.transaction(async (tx) => {
            await tx
              .delete(githubInstallation)
              .where(eq(githubInstallation.authorizationId, input.authorizationId))
            if (input.installations.length > 0) {
              await tx.insert(githubInstallation).values(
                input.installations.map((installation) => ({
                  id: randomUUID(),
                  authorizationId: input.authorizationId,
                  installationId: installation.installationId,
                  accountId: installation.accountId,
                  accountLogin: installation.accountLogin,
                  accountType: installation.accountType,
                  accountAvatarUrl: installation.accountAvatarUrl,
                  repositorySelection: installation.repositorySelection,
                  permissions: JSON.stringify(installation.permissions),
                  suspendedAt: installation.suspendedAt,
                  createdAt: input.refreshedAt,
                  updatedAt: input.refreshedAt
                }))
              )
            }
            await tx
              .update(githubUserAuthorization)
              .set({ updatedAt: input.refreshedAt, lastRefreshedAt: input.refreshedAt })
              .where(eq(githubUserAuthorization.id, input.authorizationId))
          })
        )
        .pipe(Effect.asVoid),

    updateTokens: (input: {
      readonly userId: string
      readonly accessTokenEncrypted: string
      readonly refreshTokenEncrypted: string | null
      readonly accessTokenExpiresAt: Date | null
      readonly refreshTokenExpiresAt: Date | null
      readonly updatedAt: Date
    }): Effect.Effect<void, DatabaseError> =>
      database
        .run("GitHubConnectionRepository.updateTokens", (db) =>
          db
            .update(githubUserAuthorization)
            .set({
              accessTokenEncrypted: input.accessTokenEncrypted,
              refreshTokenEncrypted: input.refreshTokenEncrypted,
              accessTokenExpiresAt: input.accessTokenExpiresAt,
              refreshTokenExpiresAt: input.refreshTokenExpiresAt,
              updatedAt: input.updatedAt
            })
            .where(eq(githubUserAuthorization.userId, input.userId))
        )
        .pipe(Effect.asVoid),

    disconnect: (userId: string): Effect.Effect<void, DatabaseError> =>
      database
        .run("GitHubConnectionRepository.disconnect", (db) =>
          db.transaction(async (tx) => {
            // Invalidate in-flight browser callbacks as part of disconnect.
            await tx.delete(githubCallbackState).where(eq(githubCallbackState.userId, userId))
            await tx
              .delete(githubUserAuthorization)
              .where(eq(githubUserAuthorization.userId, userId))
          })
        )
        .pipe(Effect.asVoid)
  } as const
}

export class GitHubConnectionRepository extends Effect.Service<GitHubConnectionRepository>()(
  "@jingler/server/GitHubConnectionRepository",
  {
    accessors: true,
    effect: Effect.gen(function* () {
      return repositoryFor(yield* Database)
    })
  }
) {}
