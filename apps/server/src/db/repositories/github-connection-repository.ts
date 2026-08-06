/**
 * Persistence boundary for the GitHub App product connection. BetterAuth's
 * `account` table is intentionally absent: social login and app authorization
 * have different credentials, lifecycles, and ownership.
 */
import { randomUUID } from "node:crypto"
import { and, asc, eq, gt, inArray, isNull, lte, notInArray, sql } from "drizzle-orm"
import { Effect, Option } from "effect"
import { Database, type DatabaseError, type DrizzleClient } from "../database.js"
import {
  githubCallbackState,
  githubInstallation,
  githubRelayRegistrationOutbox,
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

export type GitHubRelayRegistrationState = "active" | "suspended" | "removed"

export interface GitHubRelayRegistrationMutation {
  readonly id: string
  readonly userId: string
  readonly installationId: string
  readonly desiredState: GitHubRelayRegistrationState
  readonly generation: number
  readonly attemptCount: number
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

const toAuthorization = (row: AuthorizationRow): GitHubAuthorizationRecord => ({
  ...row
})

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

const toInstallation = (row: typeof githubInstallation.$inferSelect): GitHubInstallationRecord => ({
  ...row,
  repositorySelection: row.repositorySelection === "selected" ? "selected" : "all",
  permissions: parsePermissions(row.permissions)
})

const toCallbackState = (row: CallbackStateRow): GitHubCallbackStateRecord => ({
  ...row,
  kind: row.kind === "install" ? "install" : "authorize"
})

const relayState = (suspendedAt: Date | null): GitHubRelayRegistrationState =>
  suspendedAt === null ? "active" : "suspended"

const toRelayMutation = (
  row: typeof githubRelayRegistrationOutbox.$inferSelect
): GitHubRelayRegistrationMutation => ({
  id: row.id,
  userId: row.userId,
  installationId: row.installationId,
  desiredState:
    row.desiredState === "active" || row.desiredState === "suspended"
      ? row.desiredState
      : "removed",
  generation: row.generation,
  attemptCount: row.attemptCount
})

const queueRelayMutation = async (
  tx: Pick<DrizzleClient, "insert">,
  input: {
    readonly userId: string
    readonly installationId: string
    readonly desiredState: GitHubRelayRegistrationState
    readonly at: Date
  }
): Promise<void> => {
  const mutationId = randomUUID()
  await tx
    .insert(githubRelayRegistrationOutbox)
    .values({
      id: mutationId,
      userId: input.userId,
      installationId: input.installationId,
      desiredState: input.desiredState,
      generation: 1,
      attemptCount: 0,
      nextAttemptAt: input.at,
      deliveredAt: null,
      lastError: null,
      createdAt: input.at,
      updatedAt: input.at
    })
    .onConflictDoUpdate({
      target: [
        githubRelayRegistrationOutbox.userId,
        githubRelayRegistrationOutbox.installationId
      ],
      set: {
        id: mutationId,
        desiredState: input.desiredState,
        generation: sql`${githubRelayRegistrationOutbox.generation} + 1`,
        attemptCount: 0,
        nextAttemptAt: input.at,
        deliveredAt: null,
        lastError: null,
        updatedAt: input.at
      }
    })
}

const repositoryFor = (database: Database) => {
  const findAuthorization = (
    operation: string,
    query: (client: DrizzleClient) => Promise<Array<AuthorizationRow>>
  ): Effect.Effect<Option.Option<GitHubAuthorizationRecord>, DatabaseError> =>
    database
      .run(operation, query)
      .pipe(Effect.map((rows) => Option.fromNullable(rows[0]).pipe(Option.map(toAuthorization))))

  return {
    createCallbackState: (values: typeof githubCallbackState.$inferInsert) =>
      database
        .run("GitHubConnectionRepository.createCallbackState", (db) =>
          db.insert(githubCallbackState).values(values)
        )
        .pipe(Effect.asVoid),

    /**
     * The UPDATE is the replay lock. Hash, kind, expiry and unused status are
     * checked in one statement; a second caller receives None. The owning user
     * is recovered from the returned row, never supplied by the caller: the
     * GitHub redirect lands in the OS browser, which carries no session cookie,
     * so the unguessable single-use state is the callback's sole authenticator.
     */
    consumeCallbackState: (input: {
      readonly stateHash: string
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
                inArray(githubCallbackState.kind, [...input.kinds]),
                gt(githubCallbackState.expiresAt, input.at),
                isNull(githubCallbackState.consumedAt)
              )
            )
            .returning()
        )
        .pipe(Effect.map((rows) => Option.fromNullable(rows[0]).pipe(Option.map(toCallbackState)))),

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

    /** Upsert authorization and diff the reconciled installation set atomically. */
    saveConnection: (
      input: SaveGitHubConnectionInput
    ): Effect.Effect<GitHubAuthorizationRecord, DatabaseError> =>
      database
        .run("GitHubConnectionRepository.saveConnection", (db) =>
          db.transaction(async (tx) => {
            const previous = await tx
              .select({ installation: githubInstallation })
              .from(githubInstallation)
              .innerJoin(
                githubUserAuthorization,
                eq(githubInstallation.authorizationId, githubUserAuthorization.id)
              )
              .where(eq(githubUserAuthorization.userId, input.authorization.userId))
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

            if (input.installations.length > 0) {
              for (const installation of input.installations) {
                await tx
                  .insert(githubInstallation)
                  .values({
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
                  })
                  .onConflictDoUpdate({
                    target: [
                      githubInstallation.authorizationId,
                      githubInstallation.installationId
                    ],
                    set: {
                      accountId: installation.accountId,
                      accountLogin: installation.accountLogin,
                      accountType: installation.accountType,
                      accountAvatarUrl: installation.accountAvatarUrl,
                      repositorySelection: installation.repositorySelection,
                      permissions: JSON.stringify(installation.permissions),
                      suspendedAt: installation.suspendedAt,
                      updatedAt: input.refreshedAt
                    }
                  })
              }
              await tx.delete(githubInstallation).where(
                and(
                  eq(githubInstallation.authorizationId, authorization.id),
                  notInArray(
                    githubInstallation.installationId,
                    input.installations.map((installation) => installation.installationId)
                  )
                )
              )
            } else {
              await tx
                .delete(githubInstallation)
                .where(eq(githubInstallation.authorizationId, authorization.id))
            }
            const previousStates = new Map(
              previous.map(({ installation }) => [
                installation.installationId,
                relayState(installation.suspendedAt)
              ])
            )
            const currentStates = new Map(
              input.installations.map((installation) => [
                installation.installationId,
                relayState(installation.suspendedAt)
              ])
            )
            const changes = [
              ...[...currentStates].filter(
                ([installationId, state]) => previousStates.get(installationId) !== state
              ),
              ...[...previousStates.keys()]
                .filter((installationId) => !currentStates.has(installationId))
                .map((installationId) => [installationId, "removed"] as const)
            ]
            for (const [installationId, desiredState] of changes) {
              await queueRelayMutation(tx, {
                userId: input.authorization.userId,
                installationId,
                desiredState,
                at: input.refreshedAt
              })
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
            const authorization = await tx
              .select()
              .from(githubUserAuthorization)
              .where(eq(githubUserAuthorization.id, input.authorizationId))
              .limit(1)
            const userId = authorization[0]?.userId
            const previous = await tx
              .select()
              .from(githubInstallation)
              .where(eq(githubInstallation.authorizationId, input.authorizationId))
            if (input.installations.length > 0) {
              for (const installation of input.installations) {
                await tx
                  .insert(githubInstallation)
                  .values({
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
                  })
                  .onConflictDoUpdate({
                    target: [
                      githubInstallation.authorizationId,
                      githubInstallation.installationId
                    ],
                    set: {
                      accountId: installation.accountId,
                      accountLogin: installation.accountLogin,
                      accountType: installation.accountType,
                      accountAvatarUrl: installation.accountAvatarUrl,
                      repositorySelection: installation.repositorySelection,
                      permissions: JSON.stringify(installation.permissions),
                      suspendedAt: installation.suspendedAt,
                      updatedAt: input.refreshedAt
                    }
                  })
              }
              await tx.delete(githubInstallation).where(
                and(
                  eq(githubInstallation.authorizationId, input.authorizationId),
                  notInArray(
                    githubInstallation.installationId,
                    input.installations.map((installation) => installation.installationId)
                  )
                )
              )
            } else {
              await tx
                .delete(githubInstallation)
                .where(eq(githubInstallation.authorizationId, input.authorizationId))
            }
            await tx
              .update(githubUserAuthorization)
              .set({
                updatedAt: input.refreshedAt,
                lastRefreshedAt: input.refreshedAt
              })
              .where(eq(githubUserAuthorization.id, input.authorizationId))
            if (userId) {
              const previousStates = new Map(
                previous.map((installation) => [
                  installation.installationId,
                  relayState(installation.suspendedAt)
                ])
              )
              const currentStates = new Map(
                input.installations.map((installation) => [
                  installation.installationId,
                  relayState(installation.suspendedAt)
                ])
              )
              const changes = [
                ...[...currentStates].filter(
                  ([installationId, state]) => previousStates.get(installationId) !== state
                ),
                ...[...previousStates.keys()]
                  .filter((installationId) => !currentStates.has(installationId))
                  .map((installationId) => [installationId, "removed"] as const)
              ]
              for (const [installationId, desiredState] of changes) {
                await queueRelayMutation(tx, {
                  userId,
                  installationId,
                  desiredState,
                  at: input.refreshedAt
                })
              }
            }
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
            const installations = await tx
              .select({ installationId: githubInstallation.installationId })
              .from(githubInstallation)
              .innerJoin(
                githubUserAuthorization,
                eq(githubInstallation.authorizationId, githubUserAuthorization.id)
              )
              .where(eq(githubUserAuthorization.userId, userId))
            // Invalidate in-flight browser callbacks as part of disconnect.
            await tx.delete(githubCallbackState).where(eq(githubCallbackState.userId, userId))
            await tx
              .delete(githubUserAuthorization)
              .where(eq(githubUserAuthorization.userId, userId))
            const disconnectedAt = new Date()
            for (const installation of installations) {
              await queueRelayMutation(tx, {
                userId,
                installationId: installation.installationId,
                desiredState: "removed",
                at: disconnectedAt
              })
            }
          })
        )
        .pipe(Effect.asVoid),

    listPendingRelayMutations: (
      at: Date,
      limit = 50
    ): Effect.Effect<ReadonlyArray<GitHubRelayRegistrationMutation>, DatabaseError> =>
      database
        .run("GitHubConnectionRepository.listPendingRelayMutations", (db) =>
          db
            .select()
            .from(githubRelayRegistrationOutbox)
            .where(
              and(
                isNull(githubRelayRegistrationOutbox.deliveredAt),
                lte(githubRelayRegistrationOutbox.nextAttemptAt, at)
              )
            )
            .orderBy(asc(githubRelayRegistrationOutbox.nextAttemptAt))
            .limit(Math.max(1, Math.min(limit, 100)))
        )
        .pipe(Effect.map((rows) => rows.map(toRelayMutation))),

    markRelayMutationDelivered: (
      id: string,
      deliveredAt: Date
    ): Effect.Effect<void, DatabaseError> =>
      database
        .run("GitHubConnectionRepository.markRelayMutationDelivered", (db) =>
          db
            .update(githubRelayRegistrationOutbox)
            .set({ deliveredAt, lastError: null, updatedAt: deliveredAt })
            .where(eq(githubRelayRegistrationOutbox.id, id))
        )
        .pipe(Effect.asVoid),

    markRelayMutationFailed: (input: {
      readonly id: string
      readonly retryAt: Date
      readonly updatedAt: Date
      readonly error: string
    }): Effect.Effect<void, DatabaseError> =>
      database
        .run("GitHubConnectionRepository.markRelayMutationFailed", (db) =>
          db
            .update(githubRelayRegistrationOutbox)
            .set({
              attemptCount: sql`${githubRelayRegistrationOutbox.attemptCount} + 1`,
              nextAttemptAt: input.retryAt,
              lastError: input.error.slice(0, 200),
              updatedAt: input.updatedAt
            })
            .where(eq(githubRelayRegistrationOutbox.id, input.id))
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
